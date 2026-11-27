import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface HunkComment {
	noteId: string;
	parentId?: string;
	source: string;
	filePath: string;
	hunkIndex?: number;
	oldRange?: [number, number];
	newRange?: [number, number];
	body: string;
	author?: string;
	createdAt?: string;
}

interface HunkSessionInfo {
	sessionId: string;
	pid: number;
}

async function hunkJson<T>(pi: ExtensionAPI, cwd: string, args: string[]): Promise<T | undefined> {
	const r = await pi.exec("hunk", [...args, "--json"], { cwd, timeout: 10_000 });
	if (r.code !== 0) return undefined;
	try {
		return JSON.parse(r.stdout) as T;
	} catch {
		return undefined;
	}
}

function parentPid(pid: number): number | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// pid (comm) state ppid ...
		const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return Number(rest[1]);
	} catch {
		// No procfs (macOS): ask ps.
		try {
			const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
			const ppid = Number(out.trim());
			return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
		} catch {
			return undefined;
		}
	}
}

function isDescendant(pid: number, ancestor: number): boolean {
	let cur: number | undefined = pid;
	for (let i = 0; i < 16 && cur && cur > 1; i++) {
		if (cur === ancestor) return true;
		cur = parentPid(cur);
	}
	return false;
}

/** Find the hunk session that belongs to the process tree rooted at `rootPid`. */
export async function findHunkSession(pi: ExtensionAPI, cwd: string, rootPid: number, timeoutMs = 15_000): Promise<string | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await hunkJson<{ sessions: HunkSessionInfo[] }>(pi, cwd, ["session", "list"]);
		const match = res?.sessions.find((s) => isDescendant(s.pid, rootPid));
		if (match) return match.sessionId;
		await new Promise((r) => setTimeout(r, 500));
	}
	return undefined;
}

export async function listComments(pi: ExtensionAPI, cwd: string, sessionId: string): Promise<HunkComment[] | undefined> {
	const res = await hunkJson<{ comments: HunkComment[] }>(pi, cwd, ["session", "comment", "list", sessionId, "--type", "all"]);
	return res?.comments;
}

export async function navigateToComment(pi: ExtensionAPI, cwd: string, sessionId: string, c: HunkComment): Promise<void> {
	if (!c.noteId.startsWith("user:")) {
		const r = await pi.exec("hunk", ["session", "navigate", sessionId, "--comment", c.noteId], { cwd, timeout: 10_000 });
		if (r.code === 0) return;
	}
	const target = c.newRange ? ["--new-line", String(c.newRange[0])] : c.oldRange ? ["--old-line", String(c.oldRange[0])] : undefined;
	if (!target) return;
	await pi.exec("hunk", ["session", "navigate", sessionId, "--file", c.filePath, ...target], { cwd, timeout: 10_000 });
}

/** Reload a live session with new command args. Returns an error message on failure. */
export async function reloadHunk(pi: ExtensionAPI, cwd: string, sessionId: string, args: string[]): Promise<string | undefined> {
	const r = await pi.exec("hunk", ["session", "reload", sessionId, "--", ...args], { cwd, timeout: 15_000 });
	return r.code === 0 ? undefined : (r.stderr || r.stdout).trim() || `exit ${r.code}`;
}

/**
 * Hunk command args with `extra` flags added. Flags go before a `--` path
 * separator so they are not read as paths; flags already present are skipped.
 * Empty args, or args that start with an option, review the working tree.
 */
export function hunkArgs(args: string[], extra: string[][] = []): string[] {
	const base = !args.length || args[0].startsWith("-") ? ["diff", ...args] : [...args];
	const sep = base.indexOf("--");
	const head = sep < 0 ? base : base.slice(0, sep);
	const tail = sep < 0 ? [] : base.slice(sep);
	for (const flag of extra) if (!head.includes(flag[0])) head.push(...flag);
	return [...head, ...tail];
}

/** An agent note on one diff line, from the `hunk_open` tool. */
export interface HunkNote {
	file: string;
	line?: number;
	oldLine?: number;
	summary: string;
	rationale?: string;
}

const NOTE_AUTHOR = "pi";

/** Rewrite note paths to the repo-relative form Hunk shows. */
export async function normalizeNotePaths(pi: ExtensionAPI, cwd: string, notes: HunkNote[]): Promise<HunkNote[]> {
	const r = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
	const root = r.code === 0 && r.stdout.trim() ? r.stdout.trim() : cwd;
	return notes.map((n) => {
		const raw = n.file.replace(/^@/, "");
		let abs = resolve(cwd, raw);
		if (!isAbsolute(raw) && !existsSync(abs) && existsSync(resolve(root, raw))) abs = resolve(root, raw);
		const rel = relative(root, abs);
		return { ...n, file: rel && !rel.startsWith("..") ? rel : raw };
	});
}

/** Agent-context sidecar JSON for `hunk --agent-context`. */
export function buildAgentContext(notes: HunkNote[], idPrefix: string): { json: string; ids: string[] } {
	const files = new Map<string, object[]>();
	const ids: string[] = [];
	notes.forEach((n, i) => {
		const id = `${idPrefix}-${i + 1}`;
		ids.push(id);
		const annotation = {
			id,
			...(n.line !== undefined ? { newRange: [n.line, n.line] } : { oldRange: [n.oldLine, n.oldLine] }),
			summary: n.summary,
			...(n.rationale ? { rationale: n.rationale } : {}),
			author: NOTE_AUTHOR,
			source: "agent",
		};
		const list = files.get(n.file) ?? [];
		list.push(annotation);
		files.set(n.file, list);
	});
	const json = JSON.stringify({ version: 1, files: [...files].map(([path, annotations]) => ({ path, annotations })) });
	return { json, ids };
}

/** Add notes to a live session in one batch and focus the first. Returns an error message on failure. */
export function applyNotes(cwd: string, sessionId: string, notes: HunkNote[]): Promise<string | undefined> {
	const comments = notes.map((n) => ({
		filePath: n.file,
		...(n.line !== undefined ? { newLine: n.line } : { oldLine: n.oldLine }),
		summary: n.summary,
		...(n.rationale ? { rationale: n.rationale } : {}),
		author: NOTE_AUTHOR,
	}));
	return new Promise((done) => {
		const child = execFile(
			"hunk",
			["session", "comment", "apply", sessionId, "--stdin", "--focus"],
			{ cwd, timeout: 15_000 },
			(err, stdout, stderr) => done(err ? (stderr || stdout || err.message).trim() : undefined),
		);
		child.stdin?.end(JSON.stringify({ comments }));
	});
}

function location(c: HunkComment): string {
	if (c.newRange) return `${c.filePath}:${c.newRange[0]}${c.newRange[1] !== c.newRange[0] ? `-${c.newRange[1]}` : ""} (new)`;
	if (c.oldRange) return `${c.filePath}:${c.oldRange[0]}${c.oldRange[1] !== c.oldRange[0] ? `-${c.oldRange[1]}` : ""} (old)`;
	return c.filePath;
}

export function buildFeedbackPrompt(
	sessionId: string,
	cwd: string,
	pending: HunkComment[],
	all: HunkComment[],
	alive = true,
): string {
	const byId = new Map(all.map((c) => [c.noteId, c]));
	const blocks = pending.map((c, i) => {
		const lines = [`### ${i + 1}. ${location(c)}  [noteId: ${c.noteId}]`];
		if (c.parentId) {
			// Show the thread this comment replies to.
			const thread = all.filter((t) => (t.noteId === c.parentId || t.parentId === c.parentId) && t.noteId !== c.noteId);
			const root = byId.get(c.parentId);
			if (root && !thread.includes(root)) thread.unshift(root);
			for (const t of thread) lines.push(`> ${t.source === "user" ? "user" : (t.author ?? t.source)}: ${t.body.replace(/\n/g, "\n> ")}`);
		}
		lines.push("", c.body);
		return lines.join("\n");
	});

	if (!alive) {
		return [
			`The user left ${pending.length} review comment(s) in the Hunk diff viewer (repo ${cwd}), but that Hunk window has since closed.`,
			"Address each comment: answer questions, and change the code when the comment asks for it. Reply in the chat, one section per comment.",
			"",
			...blocks,
		].join("\n");
	}

	return [
		`The user left ${pending.length} review comment(s) in the Hunk diff viewer (session ${sessionId}, repo ${cwd}).`,
		"Address each comment: answer questions, and change the code when the comment asks for it.",
		"",
		"After handling each comment, reply inside Hunk so the user can read your answer next to the code:",
		"```bash",
		`hunk session comment add ${sessionId} --reply-to <noteId> --author pi --summary "<concise answer or what you changed>"`,
		"```",
		"For several replies, prefer one batch:",
		"```bash",
		`printf '%s\\n' '{"comments":[{"replyTo":"<noteId>","summary":"..."}]}' | hunk session comment apply ${sessionId} --stdin`,
		"```",
		"Every comment must get a reply. Keep replies short; put longer explanation in the chat answer. The Hunk session auto-reloads on file changes, so no reload is needed.",
		"",
		...blocks,
	].join("\n");
}
