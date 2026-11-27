/**
 * term-overlay: run hunk, lazygit and nvim inside a pi overlay.
 *
 * - Each tool runs in a PTY that stays alive in the background when the
 *   overlay is hidden (Ctrl+\ by default), so it cannot be closed by accident.
 * - /hunk: after the overlay is hidden, new user review comments are sent to
 *   the agent. When the agent finishes, the Hunk overlay reopens on its reply.
 * - hunk_open tool: the agent opens the Hunk overlay itself, optionally with
 *   notes on changed lines, and its turn continues while the overlay is open.
 */
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	applyNotes,
	buildAgentContext,
	buildFeedbackPrompt,
	findHunkSession,
	type HunkComment,
	type HunkNote,
	hunkArgs,
	listComments,
	navigateToComment,
	normalizeNotePaths,
	reloadHunk,
} from "./hunk.ts";
import { OVERLAY_MARGIN_X, OVERLAY_MARGIN_Y, TermOverlay } from "./overlay.ts";
import { TermSession } from "./term-session.ts";

type Kind = "hunk" | "lazygit" | "nvim";

interface Managed {
	kind: Kind;
	session: TermSession;
	args: string[];
	// hunk
	hunkSessionId?: string;
	/** Resolves with the session id, or undefined if it is not found or hunk exits. */
	hunkSessionReady?: Promise<string | undefined>;
	/** Temporary agent-context sidecar, removed when hunk exits. */
	agentContextFile?: string;
	sentNotes: Map<string, string>;
	snapshot?: HunkComment[];
	/** When the request behind `snapshot` started. */
	snapshotAt?: number;
	/** Last key sent to hunk that may have changed its notes. */
	inputAt?: number;
	awaitingSince?: number;
	// nvim
	nvimSocket?: string;
}

const STATUS_KEY = "term-overlay";
const HUNK_FLAGS = [["--watch"], ["--agent-notes"]];
/** Hunk's default quit keys (`hunk.app.quit`): q and Ctrl+C. */
const HUNK_QUIT_KEYS = new Set(["q", "\x03"]);
/** Longest a quit key is held while the comment snapshot refreshes. */
const QUIT_GATE_MS = 2000;

export default function (pi: ExtensionAPI) {
	const managed = new Map<Kind, Managed>();
	let active: { kind: Kind; close: () => void } | undefined;
	let lastCtx: ExtensionContext | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;

	const updateStatus = () => {
		const ctx = lastCtx;
		if (!ctx?.hasUI) return;
		const bg = [...managed.values()].filter((m) => !m.session.exited).map((m) => m.kind);
		ctx.ui.setStatus(STATUS_KEY, bg.length ? ctx.ui.theme.fg("dim", `⧉ ${bg.join(" · ")}`) : undefined);
	};

	const pendingUserComments = (m: Managed, comments: HunkComment[]) =>
		comments.filter((c) => c.source === "user" && m.sentNotes.get(c.noteId) !== c.body && c.body.trim());

	const sendFeedback = (m: Managed, pending: HunkComment[], all: HunkComment[], alive: boolean) => {
		for (const c of pending) m.sentNotes.set(c.noteId, c.body);
		const content = buildFeedbackPrompt(m.hunkSessionId ?? "?", m.session.cwd, pending, all, alive);
		pi.sendMessage(
			{ customType: "term-overlay-hunk", content, display: true, details: { count: pending.length } },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		if (alive) m.awaitingSince = Date.now() - 1000;
		lastCtx?.ui.notify(`Hunk 코멘트 ${pending.length}개를 에이전트에게 보냈습니다.`, "info");
	};

	const refreshSnapshot = async (m: Managed): Promise<HunkComment[] | undefined> => {
		if (!m.hunkSessionId || m.session.exited) return undefined;
		const startedAt = Date.now();
		const comments = await listComments(pi, m.session.cwd, m.hunkSessionId);
		if (comments && startedAt >= (m.snapshotAt ?? 0)) {
			m.snapshot = comments;
			m.snapshotAt = startedAt;
		}
		return comments;
	};

	/**
	 * Hold Hunk's quit keys until the comment snapshot is current, so notes saved
	 * just before quitting still reach the agent after hunk exits.
	 */
	const hunkQuitGate = (m: Managed) => (key: string) => {
		if (!HUNK_QUIT_KEYS.has(key)) {
			m.inputAt = Date.now();
			return undefined;
		}
		if (!m.hunkSessionId || m.session.exited || m.inputAt === undefined) return undefined;
		if ((m.snapshotAt ?? 0) > m.inputAt) return undefined;
		return Promise.race([refreshSnapshot(m), new Promise((r) => setTimeout(r, QUIT_GATE_MS))]);
	};

	const collectHunkFeedback = async (m: Managed) => {
		const comments = await refreshSnapshot(m);
		if (!comments) return;
		const pending = pendingUserComments(m, comments);
		if (pending.length) sendFeedback(m, pending, comments, true);
	};

	const startPolling = (m: Managed) => {
		stopPolling();
		if (m.kind !== "hunk") return;
		// Keep a snapshot so comments survive if hunk is quit by accident.
		pollTimer = setInterval(() => void refreshSnapshot(m), 3000);
	};
	const stopPolling = () => {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
	};

	const create = (kind: Kind, ctx: ExtensionContext, args: string[], agentContextFile?: string): Managed | undefined => {
		const cols = Math.max(20, (process.stdout.columns || 120) - OVERLAY_MARGIN_X * 2 - 2);
		const rows = Math.max(5, (process.stdout.rows || 40) - OVERLAY_MARGIN_Y * 2 - 2);
		const file: string = kind;
		let spawnArgs = args;
		let nvimSocket: string | undefined;
		if (kind === "hunk") {
			args = hunkArgs(args);
			const context = agentContextFile ? [["--agent-context", agentContextFile]] : [];
			spawnArgs = hunkArgs(args, [...HUNK_FLAGS, ...context]);
		}
		if (kind === "nvim") {
			nvimSocket = `/tmp/pi-term-overlay-nvim-${process.pid}-${Date.now()}.sock`;
			spawnArgs = ["--listen", nvimSocket, ...args];
		}
		let session: TermSession;
		try {
			session = new TermSession({
				name: kind,
				file,
				args: spawnArgs,
				cwd: ctx.cwd,
				cols,
				rows,
				appearance: ctx.ui.theme.appearance,
			});
		} catch (err) {
			ctx.ui.notify(`${kind} 실행 실패: ${err instanceof Error ? err.message : String(err)}`, "error");
			if (agentContextFile) rmSync(agentContextFile, { force: true });
			return undefined;
		}
		const m: Managed = { kind, session, args, sentNotes: new Map(), nvimSocket, agentContextFile };
		managed.set(kind, m);

		session.onExit((code) => {
			if (managed.get(kind) === m) managed.delete(kind);
			if (active?.kind === kind) active.close();
			if (kind === "hunk") stopPolling();
			updateStatus();
			if (kind === "hunk" && m.snapshot) {
				const pending = pendingUserComments(m, m.snapshot);
				if (pending.length) sendFeedback(m, pending, m.snapshot, false);
			}
			if (code !== 0) lastCtx?.ui.notify(`${kind}가 종료되었습니다 (exit ${code}).`, "warning");
			if (m.agentContextFile) rmSync(m.agentContextFile, { force: true });
			setTimeout(() => session.dispose(), 0);
		});

		if (kind === "hunk") {
			const exited = new Promise<undefined>((r) => session.onExit(() => r(undefined)));
			m.hunkSessionReady = Promise.race([findHunkSession(pi, ctx.cwd, session.pid), exited]).then((id) => {
				if (id) m.hunkSessionId = id;
				else if (!session.exited) lastCtx?.ui.notify("Hunk 세션을 찾지 못했습니다. 코멘트 피드백이 동작하지 않습니다.", "warning");
				return id;
			});
		}
		updateStatus();
		return m;
	};

	const show = async (m: Managed, ctx: ExtensionContext, afterOpen?: () => void) => {
		if (active) return;
		let closeFn: (() => void) | undefined;
		let overlay: TermOverlay | undefined;
		const title = [m.kind, ...m.args].join(" ");
		active = { kind: m.kind, close: () => closeFn?.() };
		startPolling(m);
		const promise = ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				closeFn = () => done(undefined);
				const gate = m.kind === "hunk" ? hunkQuitGate(m) : undefined;
				overlay = new TermOverlay(tui, theme, m.session, title, () => done(undefined), gate);
				return overlay;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "100%",
					margin: { top: OVERLAY_MARGIN_Y, bottom: OVERLAY_MARGIN_Y, left: OVERLAY_MARGIN_X, right: OVERLAY_MARGIN_X },
				},
			},
		);
		afterOpen?.();
		try {
			await promise;
		} finally {
			overlay?.dispose();
			active = undefined;
			stopPolling();
			updateStatus();
		}
		if (m.kind === "hunk" && !m.session.exited) await collectHunkFeedback(m);
	};

	/** Tools run during an agent turn; another overlay holds the user's keyboard. */
	const assertOverlayFree = (kind: Kind) => {
		if (active && active.kind !== kind) {
			throw new Error(`The ${active.kind} overlay is open. Ask the user to hide it (Ctrl+\\) and try again.`);
		}
	};

	/** Start or reuse a session for a tool call and show it without waiting for it to close. */
	const startForTool = (kind: Kind, ctx: ExtensionContext, args: string[]) => {
		if (ctx.mode !== "tui") throw new Error(`${kind}_open needs pi's interactive TUI mode.`);
		lastCtx = ctx;
		assertOverlayFree(kind);
		let m = managed.get(kind);
		if (m?.session.exited) m = undefined;
		const started = !m;
		m ??= create(kind, ctx, args);
		if (!m) throw new Error(`Could not start ${kind}. Is it installed and on PATH?`);
		if (!active) void show(m, ctx).catch(() => {});
		return { m, started };
	};

	const toolResult = (m: Managed, action: string, extra = "") => ({
		content: [
			{
				type: "text" as const,
				text: `${m.kind} overlay is open for the user: ${[m.kind, ...m.args].join(" ")} (${action}).${extra} The user is using it now; do not wait for them.`,
			},
		],
		details: { kind: m.kind, action, args: m.args },
	});

	const open = async (kind: Kind, rawArgs: string, ctx: ExtensionContext) => {
		lastCtx = ctx;
		if (ctx.mode !== "tui") {
			ctx.ui.notify(`/${kind}는 TUI 모드에서만 사용할 수 있습니다.`, "error");
			return;
		}
		if (active) return;
		const args = splitArgs(rawArgs);
		let m = managed.get(kind);
		if (m?.session.exited) m = undefined;

		if (m && args.length) {
			if (kind === "hunk" && m.hunkSessionId) {
				const next = hunkArgs(args);
				const err = await reloadHunk(pi, ctx.cwd, m.hunkSessionId, next);
				if (!err) m.args = next;
				else ctx.ui.notify(`hunk reload에 실패했습니다: ${err}`, "warning");
			} else if (kind === "nvim" && m.nvimSocket) {
				for (const f of args.filter((a) => !a.startsWith("-"))) {
					await pi.exec("nvim", ["--server", m.nvimSocket, "--remote", resolve(ctx.cwd, f)], { cwd: ctx.cwd, timeout: 5000 });
				}
				m.args = args;
			} else if (kind === "lazygit") {
				ctx.ui.notify("lazygit이 이미 실행 중입니다. 새 인자를 쓰려면 /term-kill lazygit 후 다시 실행하세요.", "info");
			}
		}
		m ??= create(kind, ctx, args);
		if (m) await show(m, ctx);
	};

	pi.registerCommand("hunk", {
		description: "Hunk diff 뷰어를 overlay로 엽니다 (예: /hunk, /hunk diff main, /hunk show HEAD~1)",
		handler: (args, ctx) => open("hunk", args, ctx),
	});
	pi.registerTool({
		name: "hunk_open",
		label: "Hunk",
		description: [
			"Show a diff to the user in the Hunk viewer, in an overlay inside pi, optionally with your notes on changed lines.",
			"Use it when the user asks to show, open or review changes in Hunk or in a diff viewer.",
			"It returns as soon as the overlay is open and does not wait for the user. When the user hides the overlay, their review notes arrive as a follow-up message.",
			"If Hunk is already running, new args reload it and notes are added to the live session.",
		].join(" "),
		promptSnippet: "Show a diff to the user in the Hunk overlay, with optional notes on changed lines",
		promptGuidelines: [
			"Use hunk_open when the user asks to show or review changes in Hunk or a diff viewer, instead of asking the user to type /hunk.",
			"After hunk_open returns, do not wait or poll for the user's review; their notes arrive as a follow-up message when they hide the overlay.",
		],
		parameters: Type.Object({
			args: Type.Optional(
				Type.Array(Type.String(), {
					description:
						'Hunk command arguments. Default ["diff"] (working tree). Examples: ["diff", "main"], ["diff", "--staged"], ["show", "HEAD~1"], ["diff", "--", "src/a.ts"] (paths after "--").',
				}),
			),
			notes: Type.Optional(
				Type.Array(
					Type.Object({
						file: Type.String({ description: "File path in the diff (repo-relative or relative to the working directory)" }),
						line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line on the new side. Give line or oldLine." })),
						oldLine: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line on the old side, for deleted lines" })),
						summary: Type.String({ description: "Short note shown next to the line" }),
						rationale: Type.Optional(Type.String({ description: "Longer explanation" })),
					}),
					{ description: "Notes to show on changed lines, e.g. a summary of each change" },
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") throw new Error("hunk_open needs pi's interactive TUI mode.");
			lastCtx = ctx;
			const rawArgs = params.args ?? [];
			let notes: HunkNote[] = params.notes ?? [];
			const bad = notes.findIndex((n) => (n.line === undefined) === (n.oldLine === undefined) || !n.summary.trim());
			if (bad >= 0) throw new Error(`notes[${bad}]: give a summary and exactly one of line or oldLine.`);
			if (notes.length && rawArgs.includes("--agent-context")) throw new Error("Pass notes or --agent-context, not both.");
			assertOverlayFree("hunk");
			notes = await normalizeNotePaths(pi, ctx.cwd, notes);

			let m = managed.get("hunk");
			if (m?.session.exited) m = undefined;
			let action: "opened" | "reloaded" | "shown";
			let sidecarIds: string[] = [];
			if (m) {
				action = "shown";
				if (rawArgs.length) {
					const sessionId = await m.hunkSessionReady;
					if (!sessionId) throw new Error("The running Hunk has no session to reload; run /term-kill hunk and try again.");
					const next = hunkArgs(rawArgs);
					const err = await reloadHunk(pi, ctx.cwd, sessionId, next);
					if (err) throw new Error(`hunk session reload failed: ${err}`);
					m.args = next;
					action = "reloaded";
				}
			} else {
				let file: string | undefined;
				if (notes.length) {
					const sidecar = buildAgentContext(notes, `pi-${Date.now().toString(36)}`);
					file = join(tmpdir(), `pi-term-overlay-hunk-${process.pid}-${Date.now()}.json`);
					writeFileSync(file, sidecar.json);
					sidecarIds = sidecar.ids;
				}
				m = create("hunk", ctx, rawArgs, file);
				if (!m) throw new Error("Could not start hunk. Is it installed (npm i -g hunkdiff)?");
				action = "opened";
			}

			if (!active) void show(m, ctx).catch(() => {});
			const sessionId = await m.hunkSessionReady;
			if (m.session.exited) throw new Error(`hunk exited (code ${m.session.exitCode}). Check the args: hunk ${m.args.join(" ")}`);

			let noteError: string | undefined;
			if (sessionId && notes.length) {
				if (sidecarIds.length) {
					const first = notes[0];
					const line = first.line ?? first.oldLine ?? 1;
					await navigateToComment(pi, ctx.cwd, sessionId, {
						noteId: sidecarIds[0],
						source: "agent",
						filePath: first.file,
						body: first.summary,
						...(first.line !== undefined ? { newRange: [line, line] } : { oldRange: [line, line] }),
					});
				}
				else noteError = await applyNotes(ctx.cwd, sessionId, notes);
			}

			const lines = [
				`Hunk overlay is open for the user: hunk ${m.args.join(" ")} (${action}${sessionId ? `, session ${sessionId}` : ""}).`,
				notes.length && !noteError ? `Added ${notes.length} note(s).` : "",
				noteError ? `Adding notes failed: ${noteError}` : "",
				sessionId ? "" : "Hunk session not found, so the user's review notes will not be sent back.",
				"The user is reviewing now. Do not wait for them; their review notes arrive as a follow-up message when they hide the overlay.",
			].filter(Boolean);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { action, sessionId, args: m.args, notes: notes.length, noteError },
			};
		},
	});

	pi.registerTool({
		name: "lazygit_open",
		label: "lazygit",
		description: [
			"Open lazygit for the user in an overlay inside pi.",
			"Use it when the user asks to open lazygit or to look at git status, branches, log or stashes in lazygit.",
			"It returns as soon as the overlay is open and does not wait for the user. A running lazygit is shown again; args apply only when it starts.",
		].join(" "),
		promptSnippet: "Open lazygit for the user in an overlay",
		promptGuidelines: ["Use lazygit_open when the user asks to open lazygit, instead of asking the user to type /lazygit."],
		parameters: Type.Object({
			args: Type.Optional(
				Type.Array(Type.String(), { description: 'lazygit arguments, e.g. ["log"], ["branch"], ["status"], ["-p", "path/to/repo"]' }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const args = params.args ?? [];
			const { m, started } = startForTool("lazygit", ctx, args);
			const note = !started && args.length ? " It was already running, so the args were ignored; /term-kill lazygit restarts it." : "";
			return toolResult(m, started ? "opened" : "shown", note);
		},
	});

	pi.registerTool({
		name: "nvim_open",
		label: "nvim",
		description: [
			"Open nvim for the user in an overlay inside pi, optionally on a file and line.",
			"Use it when the user asks to open or edit a file in nvim/vim/the editor themselves.",
			"It returns as soon as the overlay is open and does not wait for the user. A running nvim is shown again and opens the file in it.",
		].join(" "),
		promptSnippet: "Open a file for the user in nvim in an overlay",
		promptGuidelines: ["Use nvim_open when the user asks to open a file in nvim or vim, instead of asking the user to type /nvim."],
		parameters: Type.Object({
			file: Type.Optional(Type.String({ description: "File to open, relative to the working directory or absolute" })),
			line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line to put the cursor on" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const file = params.file?.replace(/^@/, "");
			const line = params.line;
			const running = managed.get("nvim");
			if (running && !running.session.exited && running.nvimSocket && (file || line)) {
				assertOverlayFree("nvim");
				const cmd = file
					? `execute 'edit ${line ? `+${line} ` : ""}' .. fnameescape('${resolve(ctx.cwd, file).replace(/'/g, "''")}')`
					: `${line}`;
				const r = await pi.exec("nvim", ["--server", running.nvimSocket, "--remote-send", `<C-\\><C-N>:${cmd}<CR>`], {
					cwd: ctx.cwd,
					timeout: 5000,
				});
				if (r.code !== 0) throw new Error(`nvim --remote-send failed: ${(r.stderr || r.stdout).trim()}`);
			}
			const args = file ? [...(line ? [`+${line}`] : []), file] : [];
			// The overlay title shows the last file opened.
			if (running && !running.session.exited && file) running.args = args;
			const { m, started } = startForTool("nvim", ctx, args);
			return toolResult(m, started ? "opened" : "shown", file ? ` File: ${file}${line ? `:${line}` : ""}.` : "");
		},
	});

	pi.registerCommand("lazygit", {
		description: "lazygit을 overlay로 엽니다",
		handler: (args, ctx) => open("lazygit", args, ctx),
	});
	pi.registerCommand("nvim", {
		description: "nvim을 overlay로 엽니다 (예: /nvim src/index.ts)",
		handler: (args, ctx) => open("nvim", args, ctx),
	});
	pi.registerCommand("term-kill", {
		description: "백그라운드 hunk/lazygit/nvim을 종료합니다 (예: /term-kill nvim, /term-kill all)",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const target = args.trim() || "all";
			const kinds = target === "all" ? [...managed.keys()] : ([target] as Kind[]);
			let n = 0;
			for (const k of kinds) {
				const m = managed.get(k);
				if (!m) continue;
				m.session.kill();
				n++;
			}
			ctx.ui.notify(n ? `${n}개 프로세스를 종료했습니다.` : "종료할 프로세스가 없습니다.", "info");
		},
	});

	pi.on("session_start", (_e, ctx) => {
		lastCtx = ctx;
	});

	pi.on("agent_settled", (event, ctx) => {
		lastCtx = ctx;
		const m = managed.get("hunk");
		if (!m?.awaitingSince || m.session.exited || !m.hunkSessionId) return;
		const since = m.awaitingSince;
		m.awaitingSince = undefined;
		if (event.aborted || active || ctx.mode !== "tui") return;
		void (async () => {
			const comments = (await refreshSnapshot(m)) ?? [];
			const reply = comments.find((c) => c.source !== "user" && c.createdAt && Date.parse(c.createdAt) >= since);
			if (!reply) ctx.ui.notify("에이전트가 Hunk에 답글을 남기지 않았습니다. 채팅의 답변을 확인하세요.", "info");
			await show(m, ctx, () => {
				if (reply) void navigateToComment(pi, m.session.cwd, m.hunkSessionId!, reply);
			});
		})();
	});

	pi.on("session_shutdown", () => {
		stopPolling();
		active?.close();
		for (const m of managed.values()) {
			m.session.dispose();
			if (m.agentContextFile) rmSync(m.agentContextFile, { force: true });
		}
		managed.clear();
	});
}

function splitArgs(s: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2] ?? m[3]);
	return out;
}
