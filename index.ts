/**
 * term-overlay: run hunk, lazygit and nvim inside a pi overlay.
 *
 * - Each tool runs in a PTY that stays alive in the background when the
 *   overlay is hidden (Ctrl+\ by default), so it cannot be closed by accident.
 * - /hunk: after the overlay is hidden, new user review comments are sent to
 *   the agent. When the agent finishes, the Hunk overlay reopens on its reply.
 */
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildFeedbackPrompt,
	findHunkSession,
	type HunkComment,
	listComments,
	navigateToComment,
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
	sentNotes: Map<string, string>;
	snapshot?: HunkComment[];
	awaitingSince?: number;
	// nvim
	nvimSocket?: string;
}

const STATUS_KEY = "term-overlay";
const HUNK_DEFAULT_ARGS = ["diff"];
const HUNK_FLAGS = ["--watch", "--agent-notes"];

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

	const collectHunkFeedback = async (m: Managed) => {
		if (!m.hunkSessionId || m.session.exited) return;
		const comments = await listComments(pi, m.session.cwd, m.hunkSessionId);
		if (!comments) return;
		m.snapshot = comments;
		const pending = pendingUserComments(m, comments);
		if (pending.length) sendFeedback(m, pending, comments, true);
	};

	const startPolling = (m: Managed) => {
		stopPolling();
		if (m.kind !== "hunk") return;
		// Keep a snapshot so comments survive if hunk is quit by accident.
		pollTimer = setInterval(async () => {
			if (!m.hunkSessionId || m.session.exited) return;
			const comments = await listComments(pi, m.session.cwd, m.hunkSessionId);
			if (comments) m.snapshot = comments;
		}, 3000);
	};
	const stopPolling = () => {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
	};

	const create = (kind: Kind, ctx: ExtensionContext, args: string[]): Managed | undefined => {
		const cols = Math.max(20, (process.stdout.columns || 120) - OVERLAY_MARGIN_X * 2 - 2);
		const rows = Math.max(5, (process.stdout.rows || 40) - OVERLAY_MARGIN_Y * 2 - 2);
		const file: string = kind;
		let spawnArgs = args;
		let nvimSocket: string | undefined;
		if (kind === "hunk") spawnArgs = [...(args.length ? args : HUNK_DEFAULT_ARGS), ...HUNK_FLAGS];
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
			return undefined;
		}
		const m: Managed = { kind, session, args, sentNotes: new Map(), nvimSocket };
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
			setTimeout(() => session.dispose(), 0);
		});

		if (kind === "hunk") {
			findHunkSession(pi, ctx.cwd, session.pid).then((id) => {
				if (id) m.hunkSessionId = id;
				else lastCtx?.ui.notify("Hunk 세션을 찾지 못했습니다. 코멘트 피드백이 동작하지 않습니다.", "warning");
			});
		}
		updateStatus();
		return m;
	};

	const show = async (m: Managed, ctx: ExtensionContext, afterOpen?: () => void) => {
		if (active) return;
		let closeFn: (() => void) | undefined;
		let overlay: TermOverlay | undefined;
		const title = m.kind === "hunk" ? `hunk ${(m.args.length ? m.args : HUNK_DEFAULT_ARGS).join(" ")}` : [m.kind, ...m.args].join(" ");
		active = { kind: m.kind, close: () => closeFn?.() };
		startPolling(m);
		const promise = ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				closeFn = () => done(undefined);
				overlay = new TermOverlay(tui, theme, m.session, title, () => done(undefined));
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
				if (await reloadHunk(pi, ctx.cwd, m.hunkSessionId, args)) m.args = args;
				else ctx.ui.notify("hunk reload에 실패했습니다.", "warning");
			} else if (kind === "nvim" && m.nvimSocket) {
				for (const f of args.filter((a) => !a.startsWith("-"))) {
					await pi.exec("nvim", ["--server", m.nvimSocket, "--remote", resolve(ctx.cwd, f)], { cwd: ctx.cwd, timeout: 5000 });
				}
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
			const comments = (await listComments(pi, m.session.cwd, m.hunkSessionId!)) ?? [];
			m.snapshot = comments;
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
		for (const m of managed.values()) m.session.dispose();
		managed.clear();
	});
}

function splitArgs(s: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2] ?? m[3]);
	return out;
}
