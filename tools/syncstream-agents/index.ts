import { readFileSync } from 'node:fs';
import { BaseLlm, BaseTool, JoinNode, LlmAgent, Workflow } from '@google/adk';
import type { ReadonlyContext } from '@google/adk';
import { createRepositoryTools } from './repository.ts';

export { createRepositoryTools, RepositoryReader } from './repository.ts';

export const roles = [
	'coordinator',
	'connectivity-security',
	'media-resources',
	'sync-mesh',
	'implementer',
	'verifier'
] as const;
export type Role = (typeof roles)[number];

export interface AgentOptions {
	repoRoot: string;
	model?: string | BaseLlm;
	/** ADK-native model adapters or registered IDs, independently selected per role. */
	models?: Partial<Record<Role, string | BaseLlm>>;
	/** Each array grants exactly those tool capabilities to that role. */
	implementerTools?: BaseTool[];
	verifierTools?: BaseTool[];
}

const descriptions: Record<Role, string> = {
	coordinator: 'Map the architecture, reconcile evidence, and prioritize verified work.',
	'connectivity-security': 'Review rendezvous, ICE, room authority, and untrusted peer messages.',
	'media-resources':
		'Review file streaming, codec handling, segmentation, workers, and memory bounds.',
	'sync-mesh': 'Review synchronized playback, barriers, ABR, mesh coverage, and uplink efficiency.',
	implementer: 'Implement one assigned issue with caller-provided scoped editing tools.',
	verifier: 'Independently verify findings or a patch against the original acceptance criteria.'
};

/** Portable prompt text for copying into an existing global-agent harness. */
export function getAgentPrompt(role: Role): string {
	if (!roles.includes(role)) throw new Error(`Unknown agent role: ${role}`);
	return ['common', role]
		.map((name) => readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), 'utf8'))
		.join('\n\n');
}

function upstream(context: ReadonlyContext, keys: string[]): string {
	return keys
		.map((key) => {
			const value = context.state.get(key);
			return `## Prior stage: ${key}\n${value === undefined ? 'No prior result available; do not infer success.' : String(value)}`;
		})
		.join('\n\n');
}

function makeAgent(
	role: Role,
	options: AgentOptions,
	name = `syncstream_${role.replaceAll('-', '_')}`,
	outputKey = name,
	inputs: string[] = [],
	stage = ''
): LlmAgent {
	const readTools = createRepositoryTools(options.repoRoot);
	const additional =
		role === 'implementer'
			? (options.implementerTools ?? [])
			: role === 'verifier'
				? (options.verifierTools ?? [])
				: [];
	return new LlmAgent({
		name,
		description: descriptions[role],
		model: options.models?.[role] ?? options.model ?? 'gemini-flash-latest',
		// A provider function avoids interpreting braces in source or findings as state templates.
		instruction: (context) =>
			[getAgentPrompt(role), stage, upstream(context, ['user_request', ...inputs])]
				.filter(Boolean)
				.join('\n\n'),
		beforeAgentCallback: (context) => {
			if (name === 'review_baseline' || name === 'change_implementer') {
				context.state.set(
					'user_request',
					context.userContent?.parts?.map((part) => part.text ?? '').join('\n') ??
						'Original assignment unavailable; do not infer authorization.'
				);
			}
			return undefined;
		},
		tools: [...readTools, ...additional],
		outputKey,
		disallowTransferToParent: true,
		disallowTransferToPeers: true,
		includeContents: 'none'
	});
}

/** Fresh instances: ADK agents can belong to only one parent workflow. */
export function createAgents(options: AgentOptions): Record<Role, LlmAgent> {
	return Object.fromEntries(roles.map((role) => [role, makeAgent(role, options)])) as Record<
		Role,
		LlmAgent
	>;
}

/** Read-only audit by default. No editing or shell tools enter the specialist branches. */
export function createReviewWorkflow(options: AgentOptions): Workflow {
	const baseline = makeAgent(
		'coordinator',
		options,
		'review_baseline',
		'review_baseline',
		[],
		'Establish scope and architecture only. Return the baseline, invariant map, and specialist assignments; do not claim the audit is already complete.'
	);
	const specialists = [
		makeAgent('connectivity-security', options, 'review_connectivity', 'review_connectivity', [
			'review_baseline'
		]),
		makeAgent('media-resources', options, 'review_media', 'review_media', ['review_baseline']),
		makeAgent('sync-mesh', options, 'review_sync_mesh', 'review_sync_mesh', ['review_baseline'])
	];
	const join = new JoinNode({ name: 'join_specialist_reviews' });
	const triage = makeAgent(
		'coordinator',
		options,
		'review_triage',
		'review_triage',
		['review_baseline', 'review_connectivity', 'review_media', 'review_sync_mesh'],
		'Reconcile specialist evidence and propose a prioritized review. Preserve classifications and uncertainty.'
	);
	const verifier = makeAgent('verifier', options, 'review_verifier', 'review_verification', [
		'review_baseline',
		'review_triage'
	]);
	const final = makeAgent(
		'coordinator',
		options,
		'review_final',
		'review_report',
		['review_baseline', 'review_triage', 'review_verification'],
		'Return the final report, requirement matrix, validation limitations, and five next actions. Keep unsupported criteria unverified. This workflow does not implement changes.'
	);
	return new Workflow({
		name: 'syncstream_review',
		description:
			'Baseline, parallel specialist reviews, evidence reconciliation, independent verification, final report.',
		maxConcurrency: 3,
		edges: [['START', baseline, specialists, join, triage, verifier, final]]
	});
}

/** One assigned patch followed by verification; no autonomous retry/merge/deploy loop. */
export function createChangeWorkflow(options: AgentOptions): Workflow {
	if (!options.implementerTools?.length || !options.verifierTools?.length) {
		throw new Error(
			'A change workflow requires caller-provided implementation and verification tools'
		);
	}
	return new Workflow({
		name: 'syncstream_change',
		description: 'Implement one assigned issue, then independently verify it.',
		maxConcurrency: 1,
		edges: [
			[
				'START',
				makeAgent('implementer', options, 'change_implementer', 'implementation'),
				makeAgent('verifier', options, 'change_verifier', 'verification', ['implementation'])
			]
		]
	});
}
