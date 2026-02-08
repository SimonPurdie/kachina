# Kachina

Single-user desktop utility for tracking many Git repositories on Windows and WSL.

## Overview

- Electron + React + TypeScript desktop app.
- Discovers repositories from configured Windows and WSL roots.
- Persists catalog and settings in Electron user data (`kachina-state.json`).
- Runs Git commands in each repo's native environment:
  - Windows repo -> Windows `git`
  - WSL repo -> `git` inside that WSL distro

## Current Features

- Repository list with filters (`Attention`, `Dirty`, `Ahead`, `All`).
- Status summary per repo:
  - branch / detached
  - dirty, staged, untracked, conflicted counts
  - upstream + ahead/behind
  - merge/rebase indicators
- Changed-files table with stage/unstage actions.
- Commit action (auto `git add -A` when needed).
- Sync action (`fetch --all --prune`, `pull --rebase`, `push --porcelain`).
- Open in editor, file manager, and terminal.
- Per-repo operation queue with in-progress/cancel UI.
- Command transcripts captured for failed operations.

## Configuration

In **Discovery Settings**:

- `Windows roots`: one path per line
- `WSL roots`: one `distro:/path` entry per line
- `Ignore patterns`: substring tokens to skip while scanning
- `Ignored repos`: normalized repo keys to exclude

Use **Save Settings**, then **Scan Roots**.

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

## License

MIT. See `LICENSE`.
