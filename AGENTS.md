# pi-term-overlay maintenance notes

pi extension that hosts `hunk`, `lazygit` and `nvim` in a pi overlay through a PTY.

## Layout

- `index.ts`: commands (`/hunk`, `/lazygit`, `/nvim`, `/term-kill`), agent tools `hunk_open`, `lazygit_open`, `nvim_open` (open the overlay without awaiting it), background session registry, Hunk feedback loop (`agent_settled` reopens the overlay).
- `term-session.ts`: `zigpty` PTY + `@xterm/headless` emulator. Answers OSC 4/10/11 and CSI 14t/18t queries; renders cells to ANSI lines.
- `overlay.ts`: overlay component, border, detach key (`Ctrl+\`, `PI_TERM_OVERLAY_DETACH_KEY`).
- `input.ts`: translates Kitty CSI-u / modifyOtherKeys input from pi to legacy sequences; honours DECCKM and bracketed paste.
- `hunk.ts`: `hunk session` CLI helpers, `hunkArgs` (puts flags before `--`), agent-context sidecar and `comment apply` helpers, and the feedback prompt.

## Rules

- Never add `@earendil-works/*` to `dependencies` or let them be installed into `node_modules`; pi supplies them. They are optional peers.
- Validate with `npm run check` (temporarily links pi's packages for `tsc`).
- For end-to-end checks, drive a real `pi` inside a PTY + `@xterm/headless` harness (spawn pi, type `/hunk`, dump the screen). The Hunk loop triggers a real model turn.
- `typebox` is supplied by pi like `@earendil-works/*`: optional peer, linked only by `npm run check`.
- Hunk facts (0.25): `session reload` refuses an `--agent-context` path outside the session's repo root, so notes for a running session go through `comment apply`; live comments survive reloads, sidecar notes vanish when a reload drops the sidecar; user notes come from the TUI `c` key and `Ctrl+S`; `comment list --type all --json` returns `noteId`, `parentId`, `source`; replies use `--reply-to`; agent notes need `--agent-notes` to be visible; `navigate --comment` works only for non-`user:` ids.
- Bump `version` in `package.json` and add a `CHANGELOG.md` entry for each release, then tag `vX.Y.Z` and create a GitHub release.

## Known gaps

- Only the mouse wheel is forwarded (`TermOverlay.handleMouse`, fullscreen pi only); clicks and drags stay with pi's text selection. In regular `tuiMode` pi does not enable mouse reporting, so the terminal scrolls its own scrollback.
- Kitty input translation is unit-tested only.
- Processes die with pi; no reattach across pi restarts.
