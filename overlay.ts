import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, KeyId, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { translateInput } from "./input.ts";
import type { TermSession } from "./term-session.ts";

export const DETACH_KEY = (process.env.PI_TERM_OVERLAY_DETACH_KEY || "ctrl+\\") as KeyId;

/** Vertical space (rows) the overlay leaves free above and below. */
export const OVERLAY_MARGIN_Y = 1;
export const OVERLAY_MARGIN_X = 2;

export class TermOverlay implements Component, Focusable {
	focused = false;
	private unsubscribe: (() => void) | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly session: TermSession,
		private readonly title: string,
		private readonly onDetach: () => void,
	) {
		this.unsubscribe = session.onRender(() => this.tui.requestRender());
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(20, width - 2);
		const totalH = Math.max(8, this.tui.terminal.rows - OVERLAY_MARGIN_Y * 2);
		const innerH = totalH - 2;
		this.session.resize(innerW, innerH);

		const border = (s: string) => th.fg(this.focused ? "borderAccent" : "borderMuted", s);
		const title = ` ${this.title} `;
		const hint = ` ${DETACH_KEY} 숨기기 (백그라운드 유지) `;
		const fill = Math.max(0, innerW - visibleWidth(title) - visibleWidth(hint) - 1);
		const top = border("╭─") + th.fg("accent", th.bold(title)) + border("─".repeat(fill)) + th.fg("dim", hint) + border("╮");

		const lines = [truncateToWidth(top, width)];
		for (const l of this.session.renderLines()) {
			const w = visibleWidth(l);
			const body = w > innerW ? truncateToWidth(l, innerW) : l + " ".repeat(innerW - w);
			lines.push(border("│") + body + border("│"));
		}
		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, DETACH_KEY)) {
			this.onDetach();
			return;
		}
		this.session.write(
			translateInput(data, {
				applicationCursorKeys: this.session.applicationCursorKeys,
				bracketedPaste: this.session.bracketedPaste,
			}),
		);
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
}
