# Multi-Repo Git Dashboard (Windows + WSL) — Rough Spec

## Purpose
A single GUI dashboard that keeps track of *all* local git repositories across both Windows and WSL, so repository state and required actions are visible at a glance.

## Core User Requirements
- Maintain an inventory of repositories across:
  - Windows filesystem repos
  - WSL (Linux) filesystem repos
- Provide an at-a-glance overview highlighting repos that need attention.
- Provide GUI actions to complete the common loop:
  - review changes (button to open repo in editor)
  - stage/unstage (at least minimally)
  - commit (with message - if there are changed files and none staged, commit should automatically stage all changes, including untracked files unless explicitly ignored)
  - push to remote

## Guiding Pattern (Cross-Environment Correctness)
Treat repositories as belonging to their native environment:
- Windows repos are operated on using the Windows git environment.
- WSL repos are operated on *within WSL* using the WSL git environment.

Avoid relying on Windows treating WSL repos “as just files” for core operations, to prevent filesystem boundary quirks, performance issues, and credential/signing mismatches.

## Repository Inventory
- Persistent catalogue of repositories.
- Discovery should support:
  - scanning one or more configured roots per environment
  - manual add/remove
  - ignore rules to avoid irrelevant directories
- Each repo record should retain:
  - display name
  - location (path) and environment (Windows vs WSL distro)
  - last-known status summary + timestamp

## Status Summary (What the Dashboard Surfaces)
For each repository, show:
- “Needs attention” = dirty OR staged OR untracked OR ahead>0 OR behind>0 OR error state
- Working tree state:
  - clean vs modified
  - staged changes present
  - untracked files present (or count)
- Current branch (or detached state)
- Upstream tracking state (when configured):
  - ahead/behind counts vs upstream
  - explicit “no upstream configured” state
- Error/attention states (where detectable):
  - repo inaccessible
  - auth/credentials failure
  - merge/rebase in progress

## Refresh Behaviour
- “Refresh all” action also triggered on app open.
- Background refresh on a sensible cadence with throttling.
- UI should render quickly from cached state, refreshing asynchronously.
- Fetch is permitted as a diagnostic/informational operation to keep upstream tracking (ahead/behind) accurate (no pull/merge behaviour implied).
- Optional enhancement: change detection per environment to trigger targeted refreshes (without constant full rescans).

## Execution Model & Failure Modes
- Core git operations are executed by running the native git CLI for the repository’s environment (Windows git for Windows repos, WSL git for WSL repos).
- Operations are processed in series (queue-based), prioritising simplicity and avoiding cross-operation contention.
  - (Future option) parallelism across repositories may be added later, but each repository’s operations remain serial.
- The primary “source of truth” for failures is the captured command transcript:
  - command invoked
  - exit code
  - stdout/stderr
- The GUI should surface failures plainly as repo error states, and allow viewing the full transcript without attempting lossy categorisation or remediation workflows.
- Operations must be non-interactive:
  - if a command requires user input (credentials prompt, SSH host key prompt, etc.), treat it as a failure and surface the transcript so the user can resolve it outside the tool.
- Long-running operations must not hang the UI:
  - timeouts and cancellation (best-effort)
  - clear “in progress” indication per repo/operation

## Primary User Flows
- Main list view:
  - filter/sort (e.g. dirty first, ahead/behind first)
- Repo detail view:
  - list of changed files and basic change indicators
  - stage/unstage controls (MVP level)
  - commit message entry + commit action
  - push action
- Convenience:
  - open repository in file manager
  - open in editor via configurable CLI command executed in the repo folder (separately configurable for Windows and WSL; defaults for both: `code <path>`)
  - open Windows Terminal in repo (Windows repos) / open WSL shell in repo (WSL repos)

## Non-Goals (Initial)
- Full replacement for a dedicated git client’s advanced UX (complex interactive staging, advanced rebase UI, etc.) unless deliberately expanded later.
- Forcing a single filesystem layout across Windows and WSL.

## Success Criteria
- One place to see “what needs committing/pushing” across all repos.
- GUI actions work reliably for WSL repos by operating within WSL.
- Scales to many repositories without becoming slow, noisy, or error-prone.
