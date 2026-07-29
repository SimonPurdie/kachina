# Windows handoff: Electron plus HBOX/browser refactor

## Goal

Keep the existing Electron application functional while adding an on-demand
browser flow managed by HBOX:

1. Activating Kachina in HBOX starts a Windows process Session.
2. That process serves Kachina at `http://127.0.0.1:47831`.
3. HBOX waits for `/health`, then opens the app in the default browser.
4. Nothing Kachina-specific runs at Windows login.
5. Electron remains an alternative frontend over the same service code and
   persisted state.

The intended architecture is:

```text
                         +-- Electron host -> IPC -> Electron renderer
Shared RepoService ------+
                         +-- Web host -> HTTP -> browser renderer
```

Electron and browser mode are currently intended as alternative launch modes,
not simultaneous independent backends. A shared lock prevents both processes
from writing the JSON state or running overlapping Git operations.

## Continuation status

Work resumed from WSL using Windows PowerShell as the native execution
boundary. The refactor is now implemented and verified:

- Windows `npm run typecheck` and `npm run build` pass.
- The browser host passes native Windows health, static UI, API, loopback
  security, crash-lock recovery, and graceful-shutdown tests.
- Electron was launched natively with isolated user data and remained running.
- HBOX validation/registration passes with the existing Entry identity.
- The real HBOX action reaches `running`, opens the browser, and remains
  single-instance on repeated activation.
- HBOX Stop uses `npm run stop:web`; the session exits, port 47831 closes, and
  the backend lock is removed.

The detailed sections below preserve the state and reasoning at the original
crash handoff, followed by the then-planned continuation checklist.

## Important worktree warning

Everything is uncommitted. Do not reset or discard the worktree.

These changes existed before this refactor and belong to the user:

- `src/renderer/assets/halftone-corner.svg`
- `visual-design-brief.md`
- `.hbox/icon.svg` (untracked custom HBOX icon)

Preserve them. In particular, `git diff --check` reports line-ending/trailing
whitespace noise in the first two files; do not “fix” that as part of this
refactor without checking with the user.

Current status at handoff:

```text
 M .hbox/entry.json
 M README.md
 M package-lock.json
 M package.json
 M src/main/index.ts
 M src/main/repo-service.ts
 M src/preload/index.ts
 M src/renderer/App.tsx
 M src/renderer/assets/halftone-corner.svg
 M src/renderer/vite-env.d.ts
 M src/shared/types.ts
 M tsconfig.main.json
 M visual-design-brief.md
?? .hbox/icon.svg
?? src/main/app-paths.ts
?? src/main/desktop-launcher.ts
?? src/main/electron-desktop-launcher.ts
?? src/main/instance-lock.ts
?? src/renderer/browser-api.ts
?? src/web/
```

## HBOX contract established before the crash

The live HBOX contract was queried using the `hbox-integration` skill after
HBOX was updated. It confirmed:

- Process Sessions support both Windows and WSL Entries.
- Windows commands run from the Entry folder using Windows executable search
  rules, including `.cmd` resolution (`npm` can resolve to `npm.cmd`).
- `readyUrl`, `openUrl`, `singleInstance`, and optional `stopCommand` are
  supported.
- Windows Sessions use a native runner, Job Object, process-tree ownership,
  and persisted identity verification.
- Without `stopCommand`, HBOX attempts Ctrl+Break and then force-stops the
  process tree after its grace period.

Kachina is already registered in HBOX as the Windows Entry
`E:\_Projects\kachina`.

The drafted `.hbox/entry.json` now declares:

- default action `open-kachina`;
- Windows process Session `kachina-web`;
- command `npm run start:web`;
- readiness URL `http://127.0.0.1:47831/health`;
- open URL `http://127.0.0.1:47831`;
- `singleInstance: true`.

It was subsequently verified and refreshed through the HBOX integration
helper; the existing Entry identity was retained.

## Implemented so far

### Shared service/platform boundary

`RepoService` no longer imports Electron directly. It now receives a
`DesktopLauncher`:

- `src/main/desktop-launcher.ts` contains the interface and the Windows/browser
  implementation using `explorer.exe`.
- `src/main/electron-desktop-launcher.ts` contains the Electron `shell`
  implementation.
- `src/main/repo-service.ts` uses that injected launcher for external URLs and
  opening folders.

This is the key extraction that lets the Git/WSL/storage/queue logic remain
shared.

### Electron path retained

`src/main/index.ts` still creates the Electron window, initializes
`RepoService`, registers the existing IPC handlers, starts auto-refresh, and
loads the existing renderer.

It now:

- constructs `ElectronDesktopLauncher`;
- acquires a backend lock beside the state file;
- shows an Electron error dialog if another backend owns the lock;
- releases the lock during `before-quit`.

The preload now exposes two separate bridges:

- `window.kachinaApi` for repository/domain operations;
- `window.kachinaWindowApi` for minimize/maximize/close and window-state events.

`KachinaApi` and `KachinaWindowApi` were correspondingly separated in
`src/shared/types.ts`.

### Browser renderer adapter

`src/renderer/browser-api.ts` implements `KachinaApi` using
`POST /api/invoke`.

`src/renderer/App.tsx` chooses:

- Electron preload API when `window.kachinaApi` exists;
- browser HTTP API otherwise.

The custom frameless-window title bar and window controls render only when
`window.kachinaWindowApi` exists.

### Browser host

`src/web/index.ts`:

- resolves the shared state file;
- acquires the backend lock;
- initializes the same `RepoService`;
- starts auto-refresh;
- serves on `127.0.0.1:47831`;
- listens for `SIGINT`, `SIGTERM`, and Windows `SIGBREAK`;
- supports `KACHINA_STATE_PATH`, `KACHINA_WEB_PORT`, and
  `KACHINA_SKIP_INITIAL_REFRESH=1` for testing.

`src/web/server.ts`:

- serves the production Vite bundle from `dist`;
- exposes `GET /health`;
- exposes the complete domain API through `POST /api/invoke`;
- limits request bodies;
- validates API method arguments at a basic level;
- restricts `Host` and `Origin` to loopback Kachina URLs;
- requires JSON for API requests;
- returns no CORS permission;
- applies CSP, frame, referrer, and content-type security headers;
- prevents static path traversal.

The current CSP permits the existing Google Fonts stylesheet/font origins.

### State path and process exclusion

`src/main/app-paths.ts` resolves browser state to:

```text
%APPDATA%\Kachina\kachina-state.json
```

This is intended to match Electron’s
`app.getPath("userData")\kachina-state.json`. Confirm that exact equivalence on
Windows.

`src/main/instance-lock.ts` creates:

```text
%APPDATA%\Kachina\kachina-backend.lock
```

It stores PID, mode, token, and creation time; detects live owners with
`process.kill(pid, 0)`; removes stale locks; and verifies its token before
release.

### Build and documentation

- `tsconfig.main.json` now compiles `src/web`.
- `package.json` adds:

  ```json
  "start:web": "node scripts/start-web.mjs",
  "start:web:built": "node dist-electron/web/index.js",
  "stop:web": "node scripts/stop-web.mjs"
  ```

- `start:web` builds only when output is missing or older than its source.
- `README.md` documents Electron and browser launch modes.

## Verification completed before the crash

### Passed

```text
npm run typecheck
```

Both renderer and main/web TypeScript checks passed.

The first WSL build failed because the existing shared `node_modules` lacked
Rollup’s Linux optional binary (`@rollup/rollup-linux-x64-gnu`). Running
`npm install` repaired that local install, after which this passed:

```text
npm run build
```

The successful build produced both:

- `dist/index.html`
- `dist-electron/web/index.js`

### WSL-only HTTP smoke test passed

The built web host was started with a temporary state path and initial refresh
disabled:

```bash
KACHINA_STATE_PATH=/tmp/kachina-web-smoke-state.json \
KACHINA_SKIP_INITIAL_REFRESH=1 \
node dist-electron/web/index.js
```

Observed:

- `GET /health` returned `200 {"status":"ok"}`.
- `HEAD /` and `GET /` returned the production HTML and security headers.
- Same-origin `POST /api/invoke` with `getSnapshot` returned an empty valid
  dashboard snapshot.
- A request with `Origin: https://example.com` returned 403.

### Smoke-test shutdown was inconclusive

Sending Ctrl+C through the Codex WSL PTY produced exit code 1 and left the
temporary `/tmp/kachina-backend.lock`. Codex tool calls run in isolated PID
namespaces where the Node process reported PID 2, and a later tool call also
had PID 2. That makes this particular lock result unreliable and not
representative of Windows.

The next planned command was going to inspect the compiled dependency graph,
check Windows `node`/`npm`, and clean the temporary WSL smoke files. It was
aborted by the machine crash, so none of those results should be assumed.

## Known cleanup item

The WSL `npm install` made an incidental `package-lock.json` change: it removed
six `"peer": true` lines without changing declared dependencies. This was not
intentional feature work.

Review it under Windows and preferably restore only those six lines (or
otherwise regenerate the lockfile consistently under the project’s normal
Windows npm version). Do not broadly reset the worktree because of the user’s
unrelated changes.

`npm install` also reported 13 audit findings. No audit fix was attempted;
dependency upgrades are outside this refactor.

## Windows continuation checklist

### 1. Establish the native toolchain

From a native PowerShell session in `E:\_Projects\kachina`:

```powershell
node --version
npm --version
npm install
npm run typecheck
npm run build
```

The shared `node_modules` was last repaired from WSL, so Windows optional
Rollup/esbuild packages may need reinstalling. Avoid deleting user files or
resetting the worktree.

### 2. Review the backend lock before relying on it

Pay particular attention to `src/main/instance-lock.ts`:

- confirm `process.kill(pid, 0)` behaves as expected with Windows Node;
- confirm stale locks are recovered;
- consider improving handling for a malformed/empty lock file (the current
  code retries briefly and then fails rather than aging out an unreadable
  stale lock);
- confirm clean release after normal Electron quit;
- confirm clean release after HBOX Stop/Ctrl+Break;
- confirm browser mode is rejected while Electron owns the lock, and vice
  versa, with understandable feedback.

The current product decision is that only one backend runs at a time. Attaching
an Electron window to an already-running web backend is a possible future
enhancement, not part of this draft.

### 3. Native browser-host smoke test

Use an isolated Windows state path so real repositories are not refreshed:

```powershell
$smokeRoot = Join-Path $env:TEMP 'kachina-web-smoke'
New-Item -ItemType Directory -Path $smokeRoot -Force | Out-Null
$env:KACHINA_STATE_PATH = Join-Path $smokeRoot 'kachina-state.json'
$env:KACHINA_SKIP_INITIAL_REFRESH = '1'
npm run start:web
```

In a second PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:47831/health
Invoke-WebRequest http://127.0.0.1:47831/

$headers = @{ Origin = 'http://127.0.0.1:47831' }
$body = @{ method = 'getSnapshot'; args = @() } | ConvertTo-Json -Compress
$request = @{
  Method      = 'Post'
  Uri         = 'http://127.0.0.1:47831/api/invoke'
  Headers     = $headers
  ContentType = 'application/json'
  Body        = $body
}
Invoke-RestMethod @request
```

Open `http://127.0.0.1:47831` in a browser and confirm:

- the page renders without the Electron title bar;
- the initial snapshot loads;
- settings and normal API interactions work;
- Open Editor, Open Folder, and Open Shell work from the Windows-hosted server.

Stop it normally and verify the temporary lock disappears.

### 4. Electron regression test

Clear the smoke-test environment variables, ensure browser mode is stopped,
then run:

```powershell
Remove-Item Env:KACHINA_STATE_PATH -ErrorAction SilentlyContinue
Remove-Item Env:KACHINA_SKIP_INITIAL_REFRESH -ErrorAction SilentlyContinue
npm start
```

Confirm:

- Electron opens normally;
- custom title bar/window controls still work;
- the existing real state loads;
- refresh, Git actions, editor/folder/terminal launchers still work;
- quitting removes `%APPDATA%\Kachina\kachina-backend.lock`.

Also run `npm run package:win` and smoke the packaged Electron app if practical.
The packaging script was not changed; it already copies `dist` and all of
`dist-electron`.

### 5. Decide whether `start:web` should build

The current HBOX command assumes `dist` and `dist-electron` already exist.
Those folders are ignored by Git. A fresh checkout with only `npm install`
will therefore fail when HBOX activates Kachina.

Choose one:

- keep fast startup and require `npm run build` after source updates;
- add a build-on-demand launcher that only rebuilds when outputs are missing or
  stale;
- package a dedicated web-host artifact.

Avoid an unconditional full Vite/TypeScript build on every activation if fast
startup is the main motivation.

### 6. Verify and register the HBOX integration

Use the Windows Codex `hbox-integration` skill and query the live contract
again. Then run its helper with the native Windows project path, first with
`-VerifyOnly`, then without it to update the existing registration.

If using the helper from the HBOX repository, it was previously located under:

```text
E:\_Projects\hbox\skills\hbox-integration\scripts\integrate-project.ps1
```

Example:

```powershell
$helperPath = 'E:\_Projects\hbox\skills\hbox-integration\scripts\integrate-project.ps1'
$helperArgs = @(
  '-NoLogo',
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', $helperPath,
  '-Path', 'E:\_Projects\kachina',
  '-VerifyOnly'
)
& pwsh @helperArgs
if ($LASTEXITCODE -ne 0) {
  throw "HBOX verification failed with exit code $LASTEXITCODE."
}
```

After verification, run the same command without `-VerifyOnly`. Confirm the
existing pinned Kachina Entry keeps its identity/position, its custom icon
remains valid, activation starts one Session, readiness opens the browser, a
second activation reopens it, and HBOX Stop shuts it down cleanly.

A `stopCommand` was subsequently added after native testing showed the default
Ctrl+Break/force path stopped the process tree but bypassed lock cleanup. It
invokes `npm run stop:web`, which calls a loopback-only shutdown endpoint with
the same Host, Origin, method, and JSON restrictions as the domain API.

### 7. Final review

Run:

```powershell
npm run typecheck
npm run build
git diff --check
git status --short
```

When reviewing `git diff --check`, distinguish the pre-existing user
line-ending changes from new refactor errors. Review all new files, restore the
incidental lockfile noise, and only then commit the coherent refactor.

## Areas worth a focused code review

- Confirm `%APPDATA%\Kachina` exactly matches Electron’s `userData` directory.
- Verify Windows `explorer.exe` behavior in `WindowsDesktopLauncher` for both
  URLs and filesystem paths.
- Verify HBOX stopping the `npm -> node` process tree invokes the Node
  `SIGBREAK` handler and releases the lock.
- Consider returning 400 rather than 500 for malformed `/api/invoke` payloads;
  this is polish, not a functional blocker.
- Confirm a fresh browser load sends the expected same-origin `Origin` header
  on POST requests in the target browser.
- Check that the CSP allows the existing renderer and Google Fonts without
  console errors.
- Decide how stale build output should be detected before HBOX activation.

## Scope not yet completed at the original crash

- No Windows-native execution was completed.
- No Electron runtime regression test was completed.
- No packaged Electron test was completed.
- No HBOX verification/registration was completed after editing
  `.hbox/entry.json`.
- No real-repository browser-mode operations were exercised.
- No commit was created.

The originating environment did not have PSScriptAnalyzer installed. The
PowerShell blocks above were manually reviewed as interactive continuation
commands, but were not formally linted. If they are promoted into a `.ps1`
file, install/use PSScriptAnalyzer in the Windows session first.
