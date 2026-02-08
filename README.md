# Kachina

Single-user desktop dashboard for monitoring and operating many Git repositories across Windows and WSL.

## Stack

- Electron (desktop shell + native process control)
- TypeScript (main/preload/renderer)
- React + Vite (renderer UI)

## What Is Implemented

- Persistent repository catalog (manual add/remove).
- Discovery scan from configured Windows roots and WSL roots.
- Native environment execution:
  - Windows repos run with Windows `git`.
  - WSL repos run inside chosen WSL distro with WSL `git`.
- Status summary per repo:
  - dirty/staged/untracked/conflicts
  - branch/detached
  - upstream configured or not
  - ahead/behind counts
  - merge/rebase indicators (best-effort via git refs)
- Queue-based serial execution for git operations.
- Refresh all on demand, on startup, and on a background interval.
- Actions:
  - stage/unstage file
  - commit (auto `git add -A` when no staged files but changes exist)
  - push
  - open in editor / file manager / terminal
- Transcript capture for command failures (command, exit code, stdout/stderr, timing).

## Configure Roots

In the right-side settings panel:

- `Windows roots`: one path per line.
- `WSL roots`: one line per root in `distro:/path` format.
- Click `Save Settings`, then `Scan Roots`.

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run start
```

## Notes

- Commands are intentionally non-interactive (`GIT_TERMINAL_PROMPT=0`), so auth prompts fail fast and are shown via transcript.
- State is stored in Electron user data as `kachina-state.json`.
