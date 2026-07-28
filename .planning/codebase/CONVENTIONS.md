# Coding Conventions

**Analysis Date:** 2026-07-28

## Naming Patterns

**Files:**
- Modules use kebab-case for filenames: `src/lib/rtc/connection.ts`, `src/lib/sync/clock.ts`
- Svelte components in routes: `src/routes/+page.svelte`, `src/routes/+layout.svelte`
- Route modules use `+` prefix: `+page.ts`, `+layout.ts`, `+page.svelte`
- Test files follow pattern: `tests/e2e/{feature}.spec.ts`
- Worker scripts: `worker/encode.worker.ts`

**Functions:**
- camelCase throughout: `generateRoomCode()`, `normalizeRoomCode()`, `isValidRoomCode()`, `joinRoomByCode()`
- Predicate functions prefixed with `is` or `looks`: `isValidRoomCode()`, `looksLikeLink()`
- Verb-first action functions: `sendIntent()`, `setName()`, `dropFile()`, `throttle()`
- Utility exports are specific and descriptive: `waitingMessage()`, `inviteLink()`, `snapshot()`

**Variables:**
- camelCase for all local and module variables
- Constants (values that never change) are UPPERCASE: `CODE_ALPHABET`, `CODE_LENGTH`, `NAME_MAX`, `KEY`, `BITS_PER_CHAR`
- Event/callback parameters are descriptive: `onReady`, `onHostName`, `onPeer`, `onPeerGone`, `onError`
- Temporary variables in loops are single letters only when the scope is 2-3 lines (e.g., `for (const b of bytes)`)

**Types:**
- PascalCase for type and interface names: `GuestRoom`, `HostRoom`, `PeerLink`, `PeerNetwork`, `Snapshot`
- Type names often end with `Room`, `Link`, `Network`, `Options`, or `Message` to indicate their role
- Callback types named explicitly: `type StrategyOptions = { strategy?: StrategyName }`
- Readonly types preferred for immutable data: `readonly string[]` rather than `string[]`

**Modules and Exports:**
- Barrel files not used; imports are direct: `import { snapshot } from './helpers'`
- Export type definitions before implementations
- Named exports preferred over default exports

## Code Style

**Formatting:**
- Tool: Prettier 3.1.1 (`prettier.config.js` at root)
- Tabs (not spaces): enabled via `"useTabs": true`
- Single quotes: `'string'` not `"string"` (via `"singleQuote": true`)
- No trailing commas: `[1, 2, 3]` not `[1, 2, 3,]` (via `"trailingComma": "none"`)
- Print width: 100 characters (via `"printWidth": 100`)
- Svelte files use dedicated parser: `prettier-plugin-svelte`

**Linting:**
- Tool: ESLint 9 with flat config format (`eslint.config.js`)
- TypeScript linting via `typescript-eslint` (v8)
- Svelte linting via `eslint-plugin-svelte` (v3)
- Prettier integration: `eslint-config-prettier` disables conflicting rules
- Ignores: `build/`, `.svelte-kit/`, `dist/`, `.claude/`, `.agents/`, `.gnhf/`

**TypeScript:**
- Strict mode enabled: `"strict": true` in `tsconfig.json`
- `checkJs: true` and `allowJs: true` for JavaScript files
- Source maps enabled: `"sourceMap": true`
- Module resolution: `"bundler"` mode

## Import Organization

**Order (within each file):**
1. External framework imports: `import { goto } from '$app/navigation'`
2. SvelteKit/app imports: `import { page } from '$app/state'`
3. Local lib imports from `$lib/`: `import { generateRoomCode } from '$lib/rendezvous/codes'`
4. Type-only imports grouped separately or marked with `type` keyword
5. Specific utility imports listed on separate lines for readability

**Path Aliases:**
- `$lib/` → `src/lib/` (configured in SvelteKit)
- `$app/` → SvelteKit runtime modules
- No relative imports beyond immediate parent (prefer `$lib/` paths)

**Example from `src/routes/+page.svelte`:**
```typescript
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { page } from '$app/state';
import {
	generateRoomCode,
	isValidRoomCode,
	normalizeRoomCode
} from '$lib/rendezvous/codes';
```

## Error Handling

**Pattern: Try/Catch with Graceful Fallback:**
Used when an operation may fail but the failure mode is survivable. See `src/lib/identity.ts`:
```typescript
export function readName(): string {
	try {
		return normalizeName(localStorage.getItem(KEY) ?? '');
	} catch {
		return '';
	}
}
```
Comments explain why the fallback is correct (localStorage not always readable; forgotten name is already the default).

**Pattern: Validation with Clear Return:**
Used for input validation. See `src/lib/rendezvous/codes.ts`:
```typescript
export function isValidRoomCode(code: string): boolean {
	if (code.length !== CODE_LENGTH) return false;
	for (const ch of code) {
		if (!CODE_ALPHABET.includes(ch)) return false;
	}
	return true;
}
```

**Pattern: Throw for Invariant Violations:**
Used when a condition is programmer error, not user/environment error:
```typescript
if (CODE_ALPHABET.length !== 1 << BITS_PER_CHAR) {
	throw new Error('codes: alphabet must be exactly 32 characters for unbiased sampling');
}
```

**Pattern: Error Callback Subscription:**
Module errors that have no other route go to console unless subscribed. See `src/lib/rtc/connection.ts`:
```typescript
function raise(err: Error): void {
	if (errCbs.size === 0) {
		console.error('[rtc]', err);
		return;
	}
	for (const cb of [...errCbs]) cb(err);
}
```

**Logging:**
- Minimal console usage; only `console.error('[module-name]', err)` for unhandled errors
- Tagged with module identifier in brackets: `[rtc]`, `[mesh]`
- Test instrumentation uses `window.__syncstream` oracle, never console assertions

## Comments

**When to Comment:**
- Algorithm rationale: explain *why* a choice was made, not *what* the code does
- Edge cases that are not obvious from code
- References to external specs or PLAN.md sections
- Gotchas about browser behavior or API quirks
- Why a seemingly simpler approach was rejected

**When NOT to Comment:**
- Variable names are self-documenting
- Loop logic is straightforward
- Function names are descriptive

**JSDoc/TSDoc:**
- Every exported function has a doc comment
- Type definitions have comments explaining their purpose and any constraints
- Comments use `/** ... */` format (not `//`)
- Explain callback parameters and when they fire

**Example from `src/lib/room/guest.ts`:**
```typescript
/**
 * Say who we are. `name` was only ever a fallback ("Guest 412"), and the room
 * is where it gets replaced: the invite link puts us in the room before we
 * have been asked anything, so naming ourselves has to be something we can do
 * from inside it (see identity.ts).
 */
setName(name: string): void;
```

## Function Design

**Size:**
- Functions are small and single-purpose
- Typical range: 10-30 lines (including comments)
- No function longer than ~80 lines without strong justification

**Parameters:**
- Prefer explicit parameters to object configuration where fewer than 3 params
- Options objects when 3+ parameters or when future extensibility likely
- Destructured params in function signature when object is small and stable

**Return Values:**
- Functions named as queries (starting with `is`, `get`) return that value type
- Functions named as actions return void or Promise
- Async functions always return a Promise

**Example from `src/lib/names.ts`:**
```typescript
export function nameList(names: readonly string[]): string {
	if (names.length === 0) return '';
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	const others = names.length - 2;
	return `${names[0]}, ${names[1]} and ${others} ${others === 1 ? 'other' : 'others'}`;
}
```

## Module Design

**Exports:**
- All public interfaces and types exported explicitly
- Implementation details left unexported (no `export` on private helpers)
- Barrel files not used; direct imports preferred

**Structure:**
- Type definitions at top
- Constants follow types
- Utility functions grouped by purpose
- Lifecycle/initialization functions last

**Example from `src/lib/identity.ts`:**
```typescript
const KEY = 'syncstream:name';
export const NAME_MAX = 24;

export function normalizeName(raw: string): string { ... }
export function remoteName(raw: unknown, fallback: string): string { ... }
export function readName(): string { ... }
export function saveName(name: string): void { ... }
export function fallbackName(role: 'host' | 'guest'): string { ... }
```

## Svelte Component Conventions

**Script Setup:**
- TypeScript mode: `<script lang="ts">`
- Svelte 5 runes: `let x = $state(initial)`
- Computed values use `$derived`: `const canJoin = $derived(isValidRoomCode(roomCode))`
- Imports at top, all organized by same rules as TS modules

**Reactivity:**
- State declared with `$state()` rune
- Derived values use `$derived()` not manual tracking
- Event handlers are inline functions or named functions in script

**DOM Interaction:**
- Use Playwright test IDs for test targeting: `data-testid="file-input"`
- Semantic HTML (button, form, input) with proper labels
- Tailwind CSS for styling, no inline styles

## Testing-Specific Conventions (See TESTING.md for full detail)

**Test File Organization:**
- File per feature: `tests/e2e/mesh.spec.ts`, `tests/e2e/join.spec.ts`
- Helpers in `tests/e2e/helpers.ts`
- Fixture files in `tests/fixtures/`

**Test Assertions:**
- Assert against `window.__syncstream` oracle, not DOM/timing
- Use `snapshot()` helper to read state from instrumentation
- No `sleep()`; always use `until()` with explicit deadlines

**Error Messages:**
- Clear, specific error messages in validation functions
- Error handling is explicit, not silent
- Malformed input produces diagnostic output, not generic "error"

---

*Convention analysis: 2026-07-28*
