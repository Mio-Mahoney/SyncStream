import { getAgentPrompt, roles, type Role } from './index.ts';

export interface OrcaProfile {
	agent?: 'claude' | 'codex';
	model?: string;
	effort?: 'high';
	alternative?: { model: string; effort: 'high' };
}

/** Native Orca launch preferences. These are not Gemini/ADK model registrations. */
export const orcaProfiles: Record<Role, OrcaProfile> = {
	coordinator: {
		agent: 'claude',
		model: 'claude-fable-5-1',
		effort: 'high',
		alternative: { model: 'claude-opus-5-5', effort: 'high' }
	},
	'connectivity-security': {},
	'media-resources': { agent: 'claude', model: 'claude-sonnet-5-5' },
	'sync-mesh': {},
	implementer: { agent: 'codex', model: 'gpt-6.1-sol' },
	verifier: { agent: 'codex', model: 'gpt-6-astra' }
};

export function getOrcaAgentDefinition(role: Role, useAlternative = false) {
	if (!roles.includes(role)) throw new Error(`Unknown agent role: ${role}`);
	const profile = orcaProfiles[role];
	if (useAlternative && !profile.alternative)
		throw new Error(`${role} has no alternative configured`);
	return {
		name: `syncstream_${role.replaceAll('-', '_')}`,
		role,
		prompt: getAgentPrompt(role),
		agent: profile.agent,
		model: useAlternative ? profile.alternative!.model : profile.model,
		effort: useAlternative ? profile.alternative!.effort : profile.effort
	};
}

/** Prepare argv for an already-bound Orca Run. Does not launch or send anything. */
export function getOrcaWorkerStartArgs(
	role: Role,
	options: {
		taskId: string;
		worktree?: string;
		inheritedAgent?: 'claude' | 'codex';
		useAlternative?: boolean;
	}
): string[] {
	if (!options.taskId.trim()) throw new Error('An existing Orca Task ID is required');
	const definition = getOrcaAgentDefinition(role, options.useAlternative);
	const agent = definition.agent ?? options.inheritedAgent;
	if (!agent) throw new Error(`${role} inherits its agent; supply inheritedAgent explicitly`);
	const args = [
		'orchestration',
		'worker-start',
		'--task',
		options.taskId,
		'--worktree',
		options.worktree ?? 'current',
		'--agent',
		agent
	];
	if (definition.model) args.push('--model', definition.model);
	if (definition.effort) args.push('--effort', definition.effort);
	args.push('--json');
	return args;
}
