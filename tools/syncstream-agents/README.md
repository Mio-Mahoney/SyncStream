# SyncStream review agents for Google ADK

A portable Bun/TypeScript package defining six agent roles with `@google/adk`:
coordinator, connectivity/security reviewer, media/resource reviewer,
sync/mesh reviewer, implementer, and independent verifier.

## Use these roles through Orca

`orca.ts` provides native Orca agent definitions with complete prompts and these
launch preferences:

| Role                             | Agent           | Model               | Effort  |
| -------------------------------- | --------------- | ------------------- | ------- |
| Coordinator                      | Claude          | `claude-fable-5-1`  | `high`  |
| Coordinator alternative          | Claude          | `claude-opus-5-5`   | `high`  |
| Implementer                      | Codex           | `gpt-6.1-sol`       | Inherit |
| Media/resources                  | Claude          | `claude-sonnet-5-5` | Inherit |
| Verifier                         | Codex           | `gpt-6-astra`       | Inherit |
| Connectivity/security, sync/mesh | Caller-selected | Inherit             | Inherit |

Fable is the preferred orchestrator; Opus is an explicitly selectable
alternative, not an automatic retry. Sol resolves to the current installed
Codex catalog's GPT-6.1 Sol. Only the orchestrator overrides effort because
that is the role for which high thinking was requested. Model availability
still depends on your provider account.

```ts
import { getOrcaAgentDefinition, getOrcaWorkerStartArgs } from './orca.ts';

const orchestrator = getOrcaAgentDefinition('coordinator');
const opusOrchestrator = getOrcaAgentDefinition('coordinator', true);
const implementer = getOrcaAgentDefinition('implementer');

// Pass implementer.prompt as the self-contained task instructions when creating
// the Task, alongside its target, ownership, acceptance criterion, and scope.
// This only prepares arguments for an existing Task in a bound Orca Run.
const argv = getOrcaWorkerStartArgs('implementer', {
	taskId: 'existing-task-id',
	worktree: 'path:/absolute/path/to/isolated-checkout'
});
// argv is suitable for spawn('orca', argv); this package never starts it itself.
```

Load the version-matched guides with `orca skills get orca-cli --json` and
`orca skills get orchestration --json` before coordinating a real run. The
installed Orca CLI supports `orchestration worker-start --model --effort`.
Use `worker-start` for a supervised worker, then compare `launch.requested`
with `launch.effective` in the receipt. A requested model is not proof that it
actually ran. Workers follow the live Task/Dispatch preamble and its completion
contract. Start all independent reviewers before waiting, and use one isolated
checkout for a scoped implementation, followed by verification of that patch.

These are importable profiles, not an Orca settings-file format or a command
that registers global presets. Copy the package to your reusable agent library
and load `getOrcaAgentDefinition(role)` from your coordinator integration.
No Orca workers or paid model turns are started by setup or offline tests.

The ADK factory and native Orca runner are separate execution paths. The
standalone ADK CLI example below uses Gemini by default. To run the ADK graph
itself on mixed providers, supply registered ADK models or `BaseLlm` adapters
through `AgentOptions.models`. Do not pass Claude/Codex CLI model strings to
Gemini and assume they are provider adapters. The native Orca profiles use your
Claude Code and Codex launchers and their existing authentication.

Model identifiers were checked against the installed Codex model cache and
the [OpenAI model catalog](https://developers.openai.com/api/docs/models) and
[Claude model catalog](https://platform.claude.com/docs/en/models/overview).

The SDK is pinned to **2.2.1**. This package follows the official
[TypeScript quickstart](https://adk.dev/get-started/typescript/): `LlmAgent`,
Zod-backed `FunctionTool`, and an exported `rootAgent`. Its orchestration uses
ADK 2.x `Workflow` graphs and an explicit fan-in barrier. Bun is used here for
dependency installation, TypeScript execution, and offline tests; the official
quickstart documents Node/npm prerequisites. Smoke tests do not establish every
SDK feature's compatibility with Bun.

ADK marks `Workflow` experimental in this release, which is another reason the
package pins the SDK and tests report handoffs against the real installed API.

## Run a review

From this folder:

```sh
bun install --ignore-scripts
bun run check
bun test
```

Set `GEMINI_API_KEY` through your normal secret-management method. The CLI also
supports the Google SDK's authentication configuration; do not commit keys.
Then select a Git repository and run the official devtools:

```sh
export SYNCSTREAM_REPO=/absolute/path/to/SyncStream
export ADK_MODEL=gemini-flash-latest
bunx --bun --package @google/adk-devtools@2.2.1 adk run agent.ts
```

The model name is configurable. The command starts an interactive ADK session
and sends permitted source content to the configured model provider. A useful
first task is: “Review this checkout for failures that prevent friends from
watching a local video together. Return evidence and acceptance criteria.”

To use one reviewer instead of the full workflow:

```sh
SYNCSTREAM_ROLE=connectivity-security bunx --bun --package @google/adk-devtools@2.2.1 adk run agent.ts
```

Available standalone roles: `coordinator`, `connectivity-security`,
`media-resources`, `sync-mesh`, and `verifier`. The implementer is exposed by the
library and requires caller-supplied tools in an implementation workflow.

## Workflow and capabilities

```text
Architecture baseline
    -> three parallel specialist reviewers
    -> coordinator reconciles evidence
    -> independent verifier
    -> coordinator produces final report
```

The provided repository tools read only tracked text files, with bounded
line ranges and literal search results. They reject path escapes, excluded
credential paths, binary files, oversized files, and escaping symlinks.
They do not expose an arbitrary shell, edits, browser control, media contents,
untracked files, or deployment tools. Tracked text containing inline secrets
can still contain sensitive data; these tools are path guards, not a secrets
scanner or an OS sandbox. Git and a trusted local repository are required.

The default review performs **static analysis**. Runtime claims remain
unverified unless execution tools are supplied. Use an external runner's
per-invocation call limit (for example `runConfig: { maxLlmCalls: 80 }`) and
wall-clock/cost controls. Each review pass runs once; there is no automatic
revision loop. Sessions/results belong to the caller or ADK devtools.

## Add to your reusable/global agent library

Google ADK agent definitions are executable modules. Installing this package
globally does not register it as a Codex/Claude subagent. Choose the integration
that matches your existing agent system:

1. **ADK library:** Copy this entire folder into your personal agents directory,
   run `bun install --ignore-scripts` there, and import its factories by absolute
   path. There are no hardcoded machine paths. Set `repoRoot` per invocation.
2. **Existing coding-agent harness:** Use `getAgentPrompt(role)` to obtain the
   complete Markdown instruction for each role, including the common contract.
   Add that text using the harness's own agent-definition format. The individual
   files in `prompts/` must be combined with `prompts/common.md`.

```ts
import {
	createAgents,
	createReviewWorkflow,
	getAgentPrompt
} from '/absolute/path/to/personal-agents/syncstream-agents/index.ts';

const agents = createAgents({ repoRoot: '/absolute/path/to/project' });
const rootAgent = createReviewWorkflow({ repoRoot: '/absolute/path/to/project' });
const portableInstructions = getAgentPrompt('media-resources');
```

Every factory returns fresh agent instances because an ADK agent has one parent.
The suite uses explicit state keys to hand reports between stages; parallel
reviewers get the same baseline without sharing each other's conversation.

## Implement and verify an assigned change

Provide your harness's scoped editing/build/test tools. They must enforce their
permissions in code; prompt instructions are not a sandbox. Use an isolated
checkout, serialize browser/encoder tests across all runs, and verify the app
and signaling-relay ports. Tool names/descriptions tell agents how to use them.

```ts
import { createChangeWorkflow } from '/absolute/path/to/personal-agents/syncstream-agents/index.ts';

// editingTools and testTools are BaseTool[] supplied by your own harness.
const changeAgent = createChangeWorkflow({
	repoRoot: '/absolute/path/to/isolated-checkout',
	implementerTools: editingTools,
	verifierTools: testTools
});
```

Assign one confirmed issue with its original acceptance criterion. This workflow
does one implementation pass followed by independent verification; it does not
automatically retry, commit, merge, or deploy. No live model runs are included
in the offline test suite.
