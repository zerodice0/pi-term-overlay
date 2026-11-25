/**
 * Translate keyboard input that pi received (possibly encoded with the Kitty
 * keyboard protocol or xterm modifyOtherKeys) into legacy terminal sequences
 * that ordinary TUI apps (nvim, lazygit, hunk) understand.
 */

const KITTY_FUNCTIONAL: Record<number, string> = {
	27: "\x1b",
	13: "\r",
	9: "\t",
	127: "\x7f",
	8: "\x7f",
	57414: "\r", // keypad enter
};

// CSI-u: ESC [ code(:shifted(:base))? (; mods(:event)? (; text)?)? u
const CSI_U = /\x1b\[(\d+)(?::(\d*))?(?::\d*)?(?:;(\d*)(?::(\d))?)?(?:;[\d:]*)?u/g;
// modifyOtherKeys: ESC [ 27 ; mods ; code ~
const MOK = /\x1b\[27;(\d+);(\d+)~/g;
// Legacy CSI with event-type suffix (Kitty flag 2): ESC [ 1 ; mods:event X  or ESC [ n ; mods:event ~
const CSI_EVENT = /\x1b\[(\d*)(?:;(\d+)(?::(\d))?)?([A-DFHPQRS~])/g;

function encode(code: number, shifted: number | undefined, mods: number): string {
	const m = Math.max(0, mods - 1);
	const shift = (m & 1) !== 0;
	const alt = (m & 2) !== 0;
	const ctrl = (m & 4) !== 0;

	let s: string;
	if (KITTY_FUNCTIONAL[code] !== undefined) {
		s = KITTY_FUNCTIONAL[code];
		if (code === 9 && shift) return "\x1b[Z";
		if (ctrl && code === 127) s = "\x08";
	} else if (code >= 57344) {
		// Private-use functional keys (lone modifiers, etc.): drop.
		return "";
	} else {
		let ch = String.fromCodePoint(shift && shifted ? shifted : code);
		if (shift && !shifted && ch.length === 1) ch = ch.toUpperCase();
		if (ctrl) {
			const lower = ch.toLowerCase();
			if (lower >= "a" && lower <= "z") ch = String.fromCharCode(lower.charCodeAt(0) - 96);
			else if (ch === " " || ch === "2" || ch === "@") ch = "\x00";
			else if (ch === "[" || ch === "3") ch = "\x1b";
			else if (ch === "\\" || ch === "4") ch = "\x1c";
			else if (ch === "]" || ch === "5") ch = "\x1d";
			else if (ch === "^" || ch === "6") ch = "\x1e";
			else if (ch === "_" || ch === "-" || ch === "7") ch = "\x1f";
			else if (ch === "/") ch = "\x1f";
		}
		s = ch;
	}
	return alt ? `\x1b${s}` : s;
}

export function translateInput(data: string, opts: { applicationCursorKeys: boolean; bracketedPaste: boolean }): string {
	let out = data;

	// Bracketed paste: strip markers if the app did not ask for them.
	if (!opts.bracketedPaste && out.includes("\x1b[200~")) {
		out = out.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
		return out;
	}
	if (out.startsWith("\x1b[200~")) return out;

	out = out.replace(CSI_U, (_m, code, shifted, mods, event) => {
		if (event === "3") return ""; // key release
		return encode(Number(code), shifted ? Number(shifted) : undefined, mods ? Number(mods) : 1);
	});
	out = out.replace(MOK, (_m, mods, code) => encode(Number(code), undefined, Number(mods)));
	out = out.replace(CSI_EVENT, (m, num, mods, event, final) => {
		if (event === "3") return "";
		if (!mods && !event) {
			// Plain arrows/home/end: honour application cursor mode.
			if (opts.applicationCursorKeys && !num && "ABCDHF".includes(final)) return `\x1bO${final}`;
			return m;
		}
		if (mods === "1") {
			if (final === "~") return `\x1b[${num}~`;
			if (opts.applicationCursorKeys && "ABCDHF".includes(final)) return `\x1bO${final}`;
			return `\x1b[${final}`;
		}
		return `\x1b[${num || "1"};${mods}${final}`;
	});
	if (opts.applicationCursorKeys) {
		out = out.replace(/\x1b\[([ABCDHF])/g, "\x1bO$1");
	}
	return out;
}
