# Changelog

## [0.1.2] - 2026-11-26

- Hunk: find the Hunk session on macOS (no `/proc`) via `ps`, so the review loop works when `hunk` runs through a wrapper process (e.g. npm's `hunkdiff`).

## [0.1.1] - 2026-11-25

- Hunk: `q` / `Ctrl+C` is held until the comment snapshot is refreshed, so notes saved right before quitting Hunk are no longer lost.

## [0.1.0] - 2026-11-25

- Initial release: `/hunk`, `/lazygit`, `/nvim` overlays backed by a persistent PTY, `/term-kill`.
- Hunk review comments are sent to the agent when the overlay is hidden; the overlay reopens on the agent's reply.
