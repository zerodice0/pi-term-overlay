# Changelog

## [0.2.0] - 2026-11-27

- New `hunk_open` tool: the agent opens the Hunk overlay itself, optionally with notes on changed lines (a temporary `--agent-context` file for a new Hunk, `hunk session comment apply` for a running one). It returns once the overlay is open instead of waiting for it to close; review notes still come back when the overlay is hidden.
- `/hunk`: the extension's `--watch --agent-notes` now go before a `--` path separator, so `/hunk diff -- src/a.ts` works. Args that start with an option (`/hunk --staged`) review with `diff`.
- New `lazygit_open` and `nvim_open` tools (`nvim_open` takes `file` and `line`; a running nvim opens the file in place). Like `hunk_open`, they return once the overlay is open.
- `/hunk` reload failures now show Hunk's error message.
- `/nvim <file>` on a running nvim now updates the overlay title.
- Mouse wheel over the overlay now scrolls the hosted app (wheel reports when the app enables mouse tracking, arrow keys on the alternate screen otherwise) instead of pi's transcript behind it. Requires pi's fullscreen mode.

## [0.1.2] - 2026-11-26

- Hunk: find the Hunk session on macOS (no `/proc`) via `ps`, so the review loop works when `hunk` runs through a wrapper process (e.g. npm's `hunkdiff`).

## [0.1.1] - 2026-11-25

- Hunk: `q` / `Ctrl+C` is held until the comment snapshot is refreshed, so notes saved right before quitting Hunk are no longer lost.

## [0.1.0] - 2026-11-25

- Initial release: `/hunk`, `/lazygit`, `/nvim` overlays backed by a persistent PTY, `/term-kill`.
- Hunk review comments are sent to the agent when the overlay is hidden; the overlay reopens on the agent's reply.
