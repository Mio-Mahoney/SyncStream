import { createAgents, createReviewWorkflow, roles, type Role } from './index.ts';

const repoRoot = process.env.SYNCSTREAM_REPO;
if (!repoRoot) throw new Error('Set SYNCSTREAM_REPO to the absolute Git repository root');
const options = { repoRoot, model: process.env.ADK_MODEL ?? 'gemini-flash-latest' };
const role = process.env.SYNCSTREAM_ROLE;
if (role && !roles.includes(role as Role)) throw new Error(`Unknown SYNCSTREAM_ROLE: ${role}`);
if (role === 'implementer')
	throw new Error('Use createChangeWorkflow with scoped implementation and verification tools');

// Official ADK devtools entry point. Defaults to the complete read-only review.
export const rootAgent = role ? createAgents(options)[role as Role] : createReviewWorkflow(options);
