import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	BaseAgent,
	BaseLlm,
	FunctionTool,
	InMemoryRunner,
	LlmAgent,
	Workflow,
	type BaseLlmConnection,
	type LlmRequest,
	type LlmResponse
} from '@google/adk';
import { z } from 'zod';
import {
	createAgents,
	createChangeWorkflow,
	createReviewWorkflow,
	getAgentPrompt,
	RepositoryReader,
	roles
} from '../index.ts';
import { getOrcaAgentDefinition, getOrcaWorkerStartArgs } from '../orca.ts';

let repoRoot: string;
beforeAll(() => {
	repoRoot = mkdtempSync(join(tmpdir(), 'syncstream-agent-test-'));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
	git('init');
	writeFileSync(join(repoRoot, 'README.md'), '# Fixture\nLocal streaming\n');
	writeFileSync(join(repoRoot, '.env'), 'FAKE_SECRET=do-not-read');
	writeFileSync(join(repoRoot, 'untracked.md'), 'untracked content');
	writeFileSync(join(repoRoot, 'binary.json'), '\0binary');
	symlinkSync('.env', join(repoRoot, 'secret-link.md'));
	symlinkSync('/etc/hosts', join(repoRoot, 'outside.md'));
	git('add', 'README.md', '.env', 'binary.json', 'secret-link.md', 'outside.md');
	git(
		'-c',
		'user.name=Agent Test',
		'-c',
		'user.email=agent-test@example.invalid',
		'commit',
		'-m',
		'Fixture'
	);
});
afterAll(() => rmSync(repoRoot, { recursive: true, force: true }));

describe('repository read boundaries', () => {
	test('reads numbered source lines and returns a real Git baseline', () => {
		const reader = new RepositoryReader(repoRoot);
		expect(reader.read('README.md', 2, 1).content).toBe('2: Local streaming');
		expect(reader.baseline().commit).toMatch(/^[a-f0-9]{40,64}$/);
		expect(reader.search('Local').matches).toEqual([
			{ path: 'README.md', line: 2, text: 'Local streaming' }
		]);
	});

	test('rejects credentials, untracked files, escapes, binary data, and invalid ranges', () => {
		const reader = new RepositoryReader(repoRoot);
		for (const path of [
			'.env',
			'untracked.md',
			'../README.md',
			'/etc/hosts',
			'outside.md',
			'secret-link.md',
			'binary.json'
		]) {
			expect(() => reader.read(path)).toThrow();
		}
		expect(() => reader.read('README.md', 0)).toThrow();
		expect(() => reader.read('README.md', 1, 201)).toThrow();
		expect(reader.list().paths).not.toContain('.env');
	});

	test('the actual ADK function tool rejects malformed arguments', async () => {
		const tool = createAgents({ repoRoot })['media-resources'].tools.find(
			(tool) => tool instanceof FunctionTool && tool.name === 'read_source_lines'
		) as FunctionTool;
		await expect(
			tool.runAsync({ args: { path: 'README.md', lineCount: 201 }, toolContext: {} as never })
		).rejects.toThrow();
		expect(
			await tool.runAsync({
				args: { path: 'README.md', startLine: 2, lineCount: 1 },
				toolContext: {} as never
			})
		).toMatchObject({ content: '2: Local streaming' });
	});
});

class OfflineModel extends BaseLlm {
	constructor() {
		super({ model: 'offline-model' });
	}
	async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
		yield* [];
		throw new Error('Offline tests must intercept every model call');
	}
	async connect(): Promise<BaseLlmConnection> {
		throw new Error('No live model connections in offline tests');
	}
}

function fakeModelResponses(
	agent: BaseAgent | Workflow,
	calls: Map<string, LlmRequest>,
	order: string[]
) {
	if (agent instanceof Workflow) {
		for (const child of agent.graph?.nodes ?? [])
			if (child instanceof BaseAgent) fakeModelResponses(child, calls, order);
		return;
	}
	if (agent instanceof LlmAgent) {
		agent.model = new OfflineModel();
		agent.beforeModelCallback = ({ context, request }) => {
			calls.set(context.agentName, request);
			order.push(context.agentName);
			return {
				content: { role: 'model', parts: [{ text: `${context.agentName}: offline evidence` }] }
			};
		};
	}
	for (const child of agent.subAgents) fakeModelResponses(child, calls, order);
}

async function runOffline(agent: BaseAgent | Workflow) {
	const calls = new Map<string, LlmRequest>();
	const order: string[] = [];
	fakeModelResponses(agent, calls, order);
	const runner = new InMemoryRunner({ agent });
	const state: Record<string, unknown> = {};
	for await (const event of runner.runEphemeral({
		userId: 'offline-test',
		newMessage: {
			role: 'user',
			parts: [{ text: 'Review local video streaming; do not implement changes.' }]
		},
		runConfig: { maxLlmCalls: 20 }
	}))
		Object.assign(state, event.actions?.stateDelta);
	return { calls, order, state };
}

describe('real ADK workflow with offline model callbacks', () => {
	test('hands the baseline to all specialists and their evidence through verification to the final report', async () => {
		const { calls, order, state } = await runOffline(createReviewWorkflow({ repoRoot }));
		expect(order[0]).toBe('review_baseline');
		expect(order.slice(1, 4).sort()).toEqual([
			'review_connectivity',
			'review_media',
			'review_sync_mesh'
		]);
		expect(order.slice(4)).toEqual(['review_triage', 'review_verifier', 'review_final']);
		for (const name of ['review_connectivity', 'review_media', 'review_sync_mesh']) {
			expect(JSON.stringify(calls.get(name)?.config?.systemInstruction)).toContain(
				'review_baseline: offline evidence'
			);
		}
		const triage = JSON.stringify(calls.get('review_triage')?.config?.systemInstruction);
		for (const name of ['review_connectivity', 'review_media', 'review_sync_mesh'])
			expect(triage).toContain(`${name}: offline evidence`);
		expect(JSON.stringify(calls.get('review_final')?.config?.systemInstruction)).toContain(
			'review_verifier: offline evidence'
		);
		expect(JSON.stringify(calls.get('review_final')?.config?.systemInstruction)).toContain(
			'do not implement changes'
		);
		expect(JSON.stringify(calls.get('review_baseline')?.contents)).toContain(
			'do not implement changes'
		);
		expect(state.review_report).toBe('review_final: offline evidence');
	});

	test('reviewers never inherit editing/verification tools; missing change tools fail before running', () => {
		const privileged = new FunctionTool({
			name: 'caller_edit',
			description: 'Caller-supplied edit capability',
			parameters: z.object({}),
			execute: () => ({ status: 'success' })
		});
		const agents = createAgents({
			repoRoot,
			implementerTools: [privileged],
			verifierTools: [privileged]
		});
		for (const role of [
			'coordinator',
			'connectivity-security',
			'media-resources',
			'sync-mesh'
		] as const)
			expect(agents[role].tools).not.toContain(privileged);
		expect(agents.implementer.tools).toContain(privileged);
		expect(() => createChangeWorkflow({ repoRoot })).toThrow('caller-provided');
	});

	test('implementation completes before verification and the verifier receives the patch report', async () => {
		const placeholder = new FunctionTool({
			name: 'caller_capability',
			description: 'Offline fixture only',
			parameters: z.object({}),
			execute: () => ({ status: 'success' })
		});
		const workflow = createChangeWorkflow({
			repoRoot,
			implementerTools: [placeholder],
			verifierTools: [placeholder]
		});
		const { calls, order, state } = await runOffline(workflow);
		expect(order).toEqual(['change_implementer', 'change_verifier']);
		expect(JSON.stringify(calls.get('change_verifier')?.config?.systemInstruction)).toContain(
			'change_implementer: offline evidence'
		);
		expect(JSON.stringify(calls.get('change_verifier')?.config?.systemInstruction)).toContain(
			'do not implement changes'
		);
		expect(state.verification).toBe('change_verifier: offline evidence');
	});

	test('global prompt exports are complete and do not depend on a machine path', () => {
		for (const role of roles) {
			const prompt = getAgentPrompt(role);
			expect(prompt).toContain('Shared review contract');
			expect(prompt).not.toContain('/Users/');
		}
	});
});

describe('Orca role launch preferences', () => {
	test('uses Fable high with an explicit Opus high alternative', () => {
		expect(getOrcaAgentDefinition('coordinator')).toMatchObject({
			agent: 'claude',
			model: 'claude-fable-5-1',
			effort: 'high'
		});
		expect(getOrcaAgentDefinition('coordinator', true)).toMatchObject({
			agent: 'claude',
			model: 'claude-opus-5-5',
			effort: 'high'
		});
		expect(() => getOrcaAgentDefinition('implementer', true)).toThrow();
	});

	test('prepares exact model arguments without granting or starting execution', () => {
		expect(getOrcaWorkerStartArgs('implementer', { taskId: 'task-example' })).toEqual([
			'orchestration',
			'worker-start',
			'--task',
			'task-example',
			'--worktree',
			'current',
			'--agent',
			'codex',
			'--model',
			'gpt-6.1-sol',
			'--json'
		]);
		expect(getOrcaWorkerStartArgs('verifier', { taskId: 'task-example' })).toContain('gpt-6-astra');
		expect(getOrcaWorkerStartArgs('media-resources', { taskId: 'task-example' })).toContain(
			'claude-sonnet-5-5'
		);
		expect(getOrcaWorkerStartArgs('coordinator', { taskId: 'task-example' })).toContain('high');
		expect(() => getOrcaWorkerStartArgs('sync-mesh', { taskId: 'task-example' })).toThrow(
			'inheritedAgent'
		);
		const inherited = getOrcaWorkerStartArgs('sync-mesh', {
			taskId: 'task-example',
			inheritedAgent: 'codex'
		});
		expect(inherited).not.toContain('--model');
		expect(inherited).not.toContain('--effort');
	});

	test('ADK role adapters are honored independently rather than treating Claude/Codex IDs as Gemini models', () => {
		const coordinator = new OfflineModel();
		const implementer = new OfflineModel();
		const agents = createAgents({ repoRoot, models: { coordinator, implementer } });
		expect(agents.coordinator.model).toBe(coordinator);
		expect(agents.implementer.model).toBe(implementer);
	});
});
