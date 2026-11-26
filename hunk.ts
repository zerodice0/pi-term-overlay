import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

export async function reloadHunk(pi: ExtensionAPI, cwd: string, sessionId: string, args: string[]): Promise<boolean> {
	const r = await pi.exec("hunk", ["session", "reload", sessionId, "--", ...args], { cwd, timeout: 15_000 });
	return r.code === 0;
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
