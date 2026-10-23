import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { FunctionTool } from '@google/adk';
import { z } from 'zod';

const TEXT_EXTENSIONS = new Set([
	'.ts',
	'.tsx',
	'.js',
	'.mjs',
	'.cjs',
	'.svelte',
	'.json',
	'.md',
	'.yaml',
	'.yml',
	'.sh',
	'.toml',
	'.css',
	'.html',
	'.txt'
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_CHARS = 24_000;

/** Read-only file tools, not a shell or an operating-system sandbox. */
export class RepositoryReader {
	readonly root: string;
	private readonly tracked: Set<string>;

	constructor(repoRoot: string) {
		this.root = realpathSync(repoRoot);
		const top = this.git(['rev-parse', '--show-toplevel']).trim();
		if (realpathSync(top) !== this.root)
			throw new Error('repoRoot must be the Git repository root');
		this.tracked = new Set(
			this.git(['ls-files', '-z'])
				.split('\0')
				.filter((path) => path && this.allowed(path))
		);
	}

	private git(args: string[]): string {
		return execFileSync('git', args, {
			cwd: this.root,
			encoding: 'utf8',
			timeout: 10_000,
			maxBuffer: 2 * 1024 * 1024
		});
	}

	private files(): string[] {
		return [...this.tracked];
	}

	private allowed(path: string): boolean {
		if (/(^|\/)(\.git|node_modules|\.aws|\.codex|\.claude|\.agents|build|dist)(\/|$)/.test(path))
			return false;
		if (
			/(^|\/)(\.env(?:\..*)?|.*(?:credential|secret|private[-_]?key).*|id_rsa|id_ed25519)$/i.test(
				path
			)
		)
			return false;
		return (
			TEXT_EXTENSIONS.has(extname(path)) ||
			/(^|\/)\.(gitignore|prettierignore|nojekyll)$/.test(path)
		);
	}

	private file(path: string): string {
		if (isAbsolute(path) || !this.tracked.has(path))
			throw new Error('Only permitted Git-tracked text paths may be read');
		const canonical = realpathSync(resolve(this.root, path));
		const rel = relative(this.root, canonical);
		if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
			throw new Error('Path escapes repository');
		// Check the target policy too, so a benign symlink cannot expose a blocked file.
		if (!this.allowed(rel.split(sep).join('/'))) throw new Error('Target path is blocked');
		const stat = statSync(canonical);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
			throw new Error('File is not a text-sized regular file');
		return canonical;
	}

	baseline() {
		return {
			root: this.root,
			commit: this.git(['rev-parse', 'HEAD']).trim(),
			workingTree: this.git(['status', '--short']).slice(0, MAX_RESULT_CHARS),
			note: 'Tracked text only. Untracked files, credentials, media bytes, and command execution are unavailable.'
		};
	}

	list(prefix = '', offset = 0) {
		const paths = this.files()
			.filter((path) => path.startsWith(prefix))
			.sort();
		return { total: paths.length, offset, paths: paths.slice(offset, offset + 100) };
	}

	read(path: string, startLine = 1, lineCount = 100) {
		if (
			!Number.isInteger(startLine) ||
			startLine < 1 ||
			!Number.isInteger(lineCount) ||
			lineCount < 1 ||
			lineCount > 200
		)
			throw new Error('Use a positive startLine and 1–200 lines');
		const content = readFileSync(this.file(path), 'utf8');
		if (content.includes('\0')) throw new Error('Binary content is blocked');
		const lines = content.split('\n');
		const selected = lines.slice(startLine - 1, startLine - 1 + lineCount);
		const numbered = selected.map((line, i) => `${startLine + i}: ${line}`).join('\n');
		return {
			path,
			totalLines: lines.length,
			startLine,
			content: numbered.slice(0, MAX_RESULT_CHARS),
			truncated: numbered.length > MAX_RESULT_CHARS,
			nextLine: startLine + selected.length
		};
	}

	search(query: string, prefix = '') {
		if (!query || query.length > 200 || query.includes('\n'))
			throw new Error('Use a nonempty single-line literal query of at most 200 characters');
		const matches: { path: string; line: number; text: string }[] = [];
		let scanned = 0;
		for (const path of this.files().filter((path) => path.startsWith(prefix))) {
			let content: string;
			try {
				content = readFileSync(this.file(path), 'utf8');
			} catch {
				continue;
			}
			if (content.includes('\0')) continue;
			scanned++;
			for (const [i, line] of content.split('\n').entries()) {
				if (!line.includes(query)) continue;
				matches.push({ path, line: i + 1, text: line.slice(0, 200) });
				if (matches.length === 60) return { matches, scanned, truncated: true };
			}
		}
		return { matches, scanned, truncated: false };
	}
}

export function createRepositoryTools(repoRoot: string) {
	const reader = new RepositoryReader(repoRoot);
	return [
		new FunctionTool({
			name: 'repository_baseline',
			description: 'Read the Git revision and worktree status; no commands are accepted.',
			parameters: z.object({}).strict(),
			execute: () => reader.baseline()
		}),
		new FunctionTool({
			name: 'list_source_files',
			description:
				'List permitted tracked text paths, 100 at a time. Media and secrets are excluded.',
			parameters: z
				.object({ prefix: z.string().default(''), offset: z.number().int().min(0).default(0) })
				.strict(),
			execute: ({ prefix, offset }) => reader.list(prefix, offset)
		}),
		new FunctionTool({
			name: 'read_source_lines',
			description: 'Read numbered lines from a permitted tracked text file. Use small ranges.',
			parameters: z
				.object({
					path: z.string(),
					startLine: z.number().int().min(1).default(1),
					lineCount: z.number().int().min(1).max(200).default(100)
				})
				.strict(),
			execute: ({ path, startLine, lineCount }) => reader.read(path, startLine, lineCount)
		}),
		new FunctionTool({
			name: 'search_source',
			description:
				'Search permitted tracked text for a literal substring; optional directory prefix, at most 60 matches.',
			parameters: z
				.object({ query: z.string().min(1).max(200), prefix: z.string().default('') })
				.strict(),
			execute: ({ query, prefix }) => reader.search(query, prefix)
		})
	];
}
