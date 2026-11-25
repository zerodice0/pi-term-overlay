# pi-term-overlay

Run `hunk`, `lazygit` and `nvim` inside a [pi](https://pi.dev) overlay. Each tool lives in a
persistent PTY (rendered through `@xterm/headless`), so hiding the overlay never kills it.

Hunk gets a review loop: leave comments in Hunk, hide the overlay, and pi sends them to the
agent. The agent answers inside Hunk, and the overlay reopens on its reply.

## Install

```bash
pi install git:github.com/zerodice0/pi-term-overlay
```

Requirements on `PATH`:

- [`hunk`](https://github.com/modem-dev/hunk): `npm i -g hunkdiff`
- [`lazygit`](https://github.com/jesseduffield/lazygit)
- [`nvim`](https://neovim.io)

Linux and macOS (anything `zigpty` ships native PTY bindings for). TUI mode only.

## Commands

| Command | Action |
| --- | --- |
| `/hunk [args]` | Open Hunk (`hunk diff --watch --agent-notes` by default). On a running session, args reload it, e.g. `/hunk show HEAD~1`, `/hunk diff main`. |
| `/lazygit` | Open lazygit. |
| `/nvim [file]` | Open nvim. On a running session, opens the file in it via `nvim --server --remote`. |
| `/term-kill [hunk\|lazygit\|nvim\|all]` | Kill background processes. |

- `Ctrl+\` hides the overlay; the process keeps running (the footer shows `⧉ hunk · nvim`).
  Override with `PI_TERM_OVERLAY_DETACH_KEY` (a pi key id such as `ctrl+]`).
- Quitting the app itself (`q` in hunk/lazygit, `:q` in nvim) ends the process.
- Processes end when pi quits or the session is switched or reloaded.

## Hunk review loop

1. In Hunk, press `c` on a line, write a note, save with `Ctrl+S`.
2. Hide the overlay with `Ctrl+\`. New or edited user notes are sent to the agent.
3. The agent replies with `hunk session comment add <session> --reply-to <noteId>` and edits code
   if asked (`--watch` reloads the diff).
4. When the agent settles, the Hunk overlay reopens on the first reply.

If Hunk is quit by accident (`q` or `Ctrl+C`), the overlay holds that key until it has refreshed
the comment snapshot, so notes saved right before quitting are still sent. The agent answers in
chat because the Hunk session is gone.

## Development

```bash
git clone https://github.com/zerodice0/pi-term-overlay
cd pi-term-overlay && npm install
pi install ./            # load the local checkout
npm run check            # type-check against the installed pi
```

## License

MIT
