import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { pathToFileURL } from "node:url";
import { shell } from "electron";
import {
  CommandFailedError,
  runCommand,
  runGitCommand,
  runWslScript,
  shellEscape
} from "./command-runner";
import { newId } from "./ids";
import { OperationQueue } from "./operation-queue";
import {
  defaultSettings,
  JsonStateStore,
  type PersistedState
} from "./storage";
import type {
  AddRepoInput,
  CommandTranscript,
  DashboardSnapshot,
  RepoActionResult,
  RepoEnvironment,
  RepoRecord,
  RepoStatusSummary,
  UpdateSettingsInput
} from "../shared/types";

const HISTORY_LIMIT = 40;

function nowIso(): string {
  return new Date().toISOString();
}

function ensureName(repoPath: string): string {
  const cleaned = repoPath.replace(/[\\/]+$/, "");
  const win = path.win32.basename(cleaned);
  const posix = path.posix.basename(cleaned);
  if (win && win !== cleaned) {
    return win;
  }
  if (posix && posix !== cleaned) {
    return posix;
  }
  return cleaned || repoPath;
}

function normalizePathKey(repoPath: string, environment: RepoEnvironment): string {
  if (environment.kind === "windows") {
    return `windows:${path.resolve(repoPath).toLowerCase()}`;
  }
  return `wsl:${environment.distro}:${repoPath}`;
}

function parseChangedPath(raw: string): string {
  const arrowIndex = raw.indexOf(" -> ");
  if (arrowIndex === -1) {
    return raw;
  }
  return raw.slice(arrowIndex + 4);
}

function parseStatusOutput(stdout: string): Omit<RepoStatusSummary, "refreshedAt" | "mergeInProgress" | "rebaseInProgress" | "inaccessible"> {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const header = lines.find((line) => line.startsWith("## ")) ?? "## HEAD (no branch)";
  const changedLines = lines.filter((line) => !line.startsWith("## "));

  let branch = "detached";
  let isDetached = false;
  let hasUpstream = false;
  let ahead = 0;
  let behind = 0;

  const summary = header.slice(3).trim();
  if (summary.startsWith("HEAD (")) {
    isDetached = true;
    branch = "detached";
  } else if (summary.startsWith("No commits yet on ")) {
    branch = summary.replace("No commits yet on ", "");
  } else {
    const [localBranch, remoteInfo] = summary.split("...");
    branch = (localBranch || "unknown").trim();
    if (remoteInfo) {
      hasUpstream = true;
      const bracketsMatch = remoteInfo.match(/\[(.+?)\]/);
      if (bracketsMatch) {
        const details = bracketsMatch[1];
        const aheadMatch = details.match(/ahead (\d+)/);
        const behindMatch = details.match(/behind (\d+)/);
        ahead = aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0;
        behind = behindMatch ? Number.parseInt(behindMatch[1], 10) : 0;
      }
    }
  }

  let stagedCount = 0;
  let modifiedCount = 0;
  let untrackedCount = 0;
  let conflictedCount = 0;

  const changedFiles = changedLines
    .map((line) => {
      if (line.startsWith("?? ")) {
        untrackedCount += 1;
        return {
          path: parseChangedPath(line.slice(3)),
          indexStatus: "?",
          worktreeStatus: "?",
          isUntracked: true,
          isStaged: false,
          isUnstaged: true,
          isConflicted: false
        };
      }

      if (line.length < 4) {
        return null;
      }

      const indexStatus = line[0];
      const worktreeStatus = line[1];
      const changedPath = parseChangedPath(line.slice(3));
      const isStaged = indexStatus !== " " && indexStatus !== "?";
      const isUnstaged = worktreeStatus !== " ";
      const isConflicted =
        indexStatus === "U" ||
        worktreeStatus === "U" ||
        (indexStatus === "A" && worktreeStatus === "A") ||
        (indexStatus === "D" && worktreeStatus === "D");

      if (isStaged) {
        stagedCount += 1;
      }
      if (isUnstaged) {
        modifiedCount += 1;
      }
      if (isConflicted) {
        conflictedCount += 1;
      }

      return {
        path: changedPath,
        indexStatus,
        worktreeStatus,
        isUntracked: false,
        isStaged,
        isUnstaged,
        isConflicted
      };
    })
    .filter((file): file is NonNullable<typeof file> => Boolean(file));

  const hasStaged = stagedCount > 0;
  const hasUntracked = untrackedCount > 0;
  const isDirty = stagedCount > 0 || modifiedCount > 0 || untrackedCount > 0;
  const needsAttention = isDirty || ahead > 0 || behind > 0 || conflictedCount > 0;

  return {
    needsAttention,
    isDirty,
    hasStaged,
    hasUntracked,
    stagedCount,
    modifiedCount,
    untrackedCount,
    conflictedCount,
    changedFiles,
    branch,
    isDetached,
    hasUpstream,
    ahead,
    behind
  };
}

export class RepoService {
  private readonly queue: OperationQueue;
  private state: PersistedState = {
    settings: { ...defaultSettings },
    repos: []
  };
  private autoRefreshTimer: NodeJS.Timeout | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(private readonly store: JsonStateStore) {
    this.queue = new OperationQueue({
      onStart: (repoId, operation) => {
        const repo = this.state.repos.find((item) => item.id === repoId);
        if (!repo) {
          return;
        }
        repo.activeOperation = operation;
      },
      onFinish: (repoId) => {
        const repo = this.state.repos.find((item) => item.id === repoId);
        if (!repo) {
          return;
        }
        repo.activeOperation = null;
      }
    });
  }

  async initialize(): Promise<void> {
    this.state = await this.store.load();
    this.state.settings = {
      ...defaultSettings,
      ...this.state.settings
    };
    for (const repo of this.state.repos) {
      repo.activeOperation = null;
      repo.transcripts = Array.isArray(repo.transcripts) ? repo.transcripts : [];
      delete (repo as RepoRecord & { tags?: unknown }).tags;
      repo.lastError = repo.lastError ?? null;
      repo.lastErrorTranscript = repo.lastErrorTranscript ?? null;
    }
  }

  dispose(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }

  startAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
    }

    const everyMs = Math.max(30, this.state.settings.refreshIntervalSeconds) * 1_000;
    this.autoRefreshTimer = setInterval(() => {
      void this.refreshAll();
    }, everyMs);
    this.autoRefreshTimer.unref();
  }

  getSnapshot(): DashboardSnapshot {
    return {
      repos: [...this.state.repos].sort((a, b) => {
        const aAttention = a.status?.needsAttention ? 1 : 0;
        const bAttention = b.status?.needsAttention ? 1 : 0;
        if (aAttention !== bAttention) {
          return bAttention - aAttention;
        }
        return a.displayName.localeCompare(b.displayName);
      }),
      settings: { ...this.state.settings },
      generatedAt: nowIso()
    };
  }

  async addRepo(input: AddRepoInput): Promise<DashboardSnapshot> {
    const candidate = {
      ...input,
      path: input.path.trim()
    };

    if (!candidate.path) {
      throw new Error("Repository path is required.");
    }

    await this.assertIsGitRepository(candidate.path, candidate.environment);
    this.registerRepo({
      displayName: input.displayName || ensureName(candidate.path),
      path: candidate.path,
      environment: candidate.environment
    });
    await this.persist();
    return this.getSnapshot();
  }

  async removeRepo(repoId: string): Promise<DashboardSnapshot> {
    this.state.repos = this.state.repos.filter((repo) => repo.id !== repoId);
    await this.persist();
    return this.getSnapshot();
  }

  async updateSettings(input: UpdateSettingsInput): Promise<DashboardSnapshot> {
    this.state.settings = {
      ...this.state.settings,
      ...input,
      windowsRoots: input.windowsRoots ?? this.state.settings.windowsRoots,
      wslRoots: input.wslRoots ?? this.state.settings.wslRoots,
      ignorePatterns: input.ignorePatterns ?? this.state.settings.ignorePatterns
    };
    await this.persist();
    this.startAutoRefresh();
    return this.getSnapshot();
  }

  async scanConfiguredRoots(): Promise<DashboardSnapshot> {
    await this.pruneMissingRepos();

    const discovered: Array<{
      path: string;
      environment: RepoEnvironment;
    }> = [];

    for (const root of this.state.settings.windowsRoots) {
      const paths = await this.scanWindowsRoot(root);
      for (const found of paths) {
        discovered.push({
          path: found,
          environment: { kind: "windows" }
        });
      }
    }

    for (const root of this.state.settings.wslRoots) {
      const paths = await this.scanWslRoot(root.distro, root.path);
      for (const found of paths) {
        discovered.push({
          path: found,
          environment: { kind: "wsl", distro: root.distro }
        });
      }
    }

    for (const item of discovered) {
      this.registerRepo({
        displayName: ensureName(item.path),
        path: item.path,
        environment: item.environment
      });
    }

    await this.persist();
    return await this.refreshAll();
  }

  async refreshAll(): Promise<DashboardSnapshot> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshAllInternal().finally(() => {
        this.refreshPromise = null;
      });
    }
    await this.refreshPromise;
    return this.getSnapshot();
  }

  async stageFile(repoId: string, filePath: string): Promise<RepoActionResult> {
    return await this.runGitAction(
      repoId,
      `Stage ${filePath}`,
      ["add", "--", filePath]
    );
  }

  async unstageFile(repoId: string, filePath: string): Promise<RepoActionResult> {
    return await this.runGitAction(
      repoId,
      `Unstage ${filePath}`,
      ["restore", "--staged", "--", filePath]
    );
  }

  async commitRepo(repoId: string, message: string): Promise<RepoActionResult> {
    const trimmed = message.trim();
    if (!trimmed) {
      return {
        ok: false,
        message: "Commit message is required.",
        snapshot: this.getSnapshot()
      };
    }

    const repo = this.getRepo(repoId);
    try {
      let transcript: CommandTranscript | undefined;
      await this.queue.enqueue(
        repo.id,
        "Commit",
        async (signal) => {
          const statusTranscript = await runGitCommand(
            repo.environment,
            repo.path,
            ["status", "--porcelain=v1", "--branch", "-uall"],
            { signal, timeoutMs: 20_000 }
          );
          transcript = statusTranscript;
          const parsed = parseStatusOutput(statusTranscript.stdout);
          if (!parsed.isDirty) {
            throw new Error("No changes to commit.");
          }
          if (!parsed.hasStaged) {
            transcript = await runGitCommand(repo.environment, repo.path, ["add", "-A"], {
              signal,
              timeoutMs: 20_000
            });
            this.pushTranscript(repo, transcript);
          }
          transcript = await runGitCommand(
            repo.environment,
            repo.path,
            ["commit", "-m", trimmed],
            { signal, timeoutMs: 45_000 }
          );
          this.pushTranscript(repo, transcript);
          await this.refreshRepoDirect(repo, signal);
          repo.lastError = null;
          repo.lastErrorTranscript = null;
          repo.updatedAt = nowIso();
          await this.persist();
        },
        60_000
      );
      return {
        ok: true,
        message: "Commit completed.",
        transcript,
        snapshot: this.getSnapshot()
      };
    } catch (error) {
      return await this.handleActionFailure(repo, "Commit failed.", error);
    }
  }

  async pushRepo(repoId: string): Promise<RepoActionResult> {
    return await this.runGitAction(repoId, "Push", ["push", "--porcelain"], 90_000);
  }

  async syncRepo(repoId: string): Promise<RepoActionResult> {
    const repo = this.getRepo(repoId);
    try {
      let transcript: CommandTranscript | undefined;
      await this.queue.enqueue(
        repo.id,
        "Sync",
        async (signal) => {
          const steps: Array<{ args: string[]; timeoutMs: number }> = [
            { args: ["fetch", "--all", "--prune"], timeoutMs: 60_000 },
            { args: ["pull"], timeoutMs: 90_000 },
            { args: ["push", "--porcelain"], timeoutMs: 90_000 }
          ];

          for (const step of steps) {
            transcript = await runGitCommand(repo.environment, repo.path, step.args, {
              signal,
              timeoutMs: step.timeoutMs
            });
            this.pushTranscript(repo, transcript);
          }

          await this.refreshRepoDirect(repo, signal);
          repo.lastError = null;
          repo.lastErrorTranscript = null;
          repo.updatedAt = nowIso();
          await this.persist();
        },
        255_000
      );
      return {
        ok: true,
        message: "Sync completed.",
        transcript,
        snapshot: this.getSnapshot()
      };
    } catch (error) {
      return await this.handleActionFailure(repo, "Sync failed.", error);
    }
  }

  async openInEditor(repoId: string): Promise<RepoActionResult> {
    const repo = this.getRepo(repoId);
    try {
      const windowsTemplate = this.state.settings.editorCommandWindows.trim();
      const wslTemplate = this.state.settings.editorCommandWsl.trim();
      const codeExecutable = await this.findVsCodeExecutable();
      if (repo.environment.kind === "windows") {
        if (windowsTemplate === "code <path>") {
          if (codeExecutable) {
            await this.launchDetached(codeExecutable, [repo.path]);
          } else {
            try {
              const folderUri = pathToFileURL(repo.path).toString();
              await this.launchDetached("code", ["--folder-uri", folderUri]);
            } catch {
              const vscodeUri = `vscode://file${pathToFileURL(repo.path).pathname}`;
              await shell.openExternal(vscodeUri);
            }
          }
        } else {
          const rendered = this.renderEditorCommand(
            this.state.settings.editorCommandWindows,
            repo.path
          );
          await this.launchShell(rendered, repo.path);
        }
      } else {
        if (wslTemplate === "code <path>") {
          const wslArgs = ["-d", repo.environment.distro];
          const inferredUser = this.inferWslUserFromPath(repo.path);
          if (inferredUser) {
            wslArgs.push("-u", inferredUser);
          }
          const script = `
cd ${shellEscape(repo.path)}
if command -v code >/dev/null 2>&1; then
  code .
  exit $?
fi
for base in "$HOME/.vscode-server" "$HOME/.vscode-server-insiders" "$HOME/.vscode-server-cli"; do
  if [ -d "$base" ]; then
    cli_path="$(find -L "$base" \\( -path "*/bin/remote-cli/code" -o -path "*/bin/code" \\) 2>/dev/null | head -n 1)"
    if [ -n "$cli_path" ]; then
      "$cli_path" .
      exit $?
    fi
  fi
done
echo "code CLI not found in PATH or VS Code server directories under $HOME" >&2
exit 127
`.trim();
          try {
            await runCommand("wsl.exe", [...wslArgs, "--", "bash", "-ilc", script]);
          } catch (error) {
            if (error instanceof CommandFailedError) {
              const detail = (error.transcript.stderr || error.transcript.stdout || "")
                .trim()
                .replace(/\s+/g, " ");
              throw new Error(
                detail
                  ? `WSL editor command failed: ${detail}`
                  : "WSL editor command failed: `code .` did not launch."
              );
            }
            throw error;
          }
        } else {
          const command = this.renderEditorCommand(
            this.state.settings.editorCommandWsl,
            repo.path,
            true
          );
          await this.launchDetached("wsl.exe", [
            "-d",
            repo.environment.distro,
            "--",
            "bash",
            "-lc",
            `cd ${shellEscape(repo.path)} && ${command}`
          ]);
        }
      }
      return {
        ok: true,
        message: "Editor command launched.",
        snapshot: this.getSnapshot()
      };
    } catch (error) {
      return {
        ok: false,
        message: `Failed to open editor: ${(error as Error).message}`,
        snapshot: this.getSnapshot()
      };
    }
  }

  async openInFileManager(repoId: string): Promise<RepoActionResult> {
    const repo = this.getRepo(repoId);
    try {
      const target =
        repo.environment.kind === "windows"
          ? repo.path
          : this.wslPathToUnc(repo.environment.distro, repo.path);
      const openError = await shell.openPath(target);
      if (openError) {
        await this.launchDetached("explorer.exe", [target]);
      }
      return {
        ok: true,
        message: "File manager opened.",
        snapshot: this.getSnapshot()
      };
    } catch (error) {
      return {
        ok: false,
        message: `Failed to open file manager: ${(error as Error).message}`,
        snapshot: this.getSnapshot()
      };
    }
  }

  async openInTerminal(repoId: string): Promise<RepoActionResult> {
    const repo = this.getRepo(repoId);
    try {
      const targetDirectory =
        repo.environment.kind === "windows"
          ? repo.path
          : this.wslPathToUnc(repo.environment.distro, repo.path);
      await this.openWindowsTerminal(targetDirectory);
      return {
        ok: true,
        message: "Terminal opened.",
        snapshot: this.getSnapshot()
      };
    } catch (error) {
      return {
        ok: false,
        message: `Failed to open terminal: ${(error as Error).message}`,
        snapshot: this.getSnapshot()
      };
    }
  }

  async cancelRepoOperation(repoId: string): Promise<DashboardSnapshot> {
    this.queue.cancelRepo(repoId);
    return this.getSnapshot();
  }

  private async refreshAllInternal(): Promise<void> {
    if (await this.pruneMissingRepos()) {
      await this.persist();
    }

    for (const repo of this.state.repos) {
      try {
        await this.queue.enqueue(
          repo.id,
          "Refresh",
          async (signal) => {
            await this.refreshRepoDirect(repo, signal);
            await this.persist();
          },
          60_000
        );
      } catch {
        // Failures are captured in repo status and transcripts.
      }
    }
  }

  private async runGitAction(
    repoId: string,
    actionName: string,
    args: string[],
    timeoutMs = 45_000
  ): Promise<RepoActionResult> {
    const repo = this.getRepo(repoId);
    try {
      let transcript: CommandTranscript | undefined;
      await this.queue.enqueue(
        repo.id,
        actionName,
        async (signal) => {
          transcript = await runGitCommand(repo.environment, repo.path, args, {
            signal,
            timeoutMs
          });
          if (transcript) {
            this.pushTranscript(repo, transcript);
          }
          await this.refreshRepoDirect(repo, signal);
          repo.lastError = null;
          repo.lastErrorTranscript = null;
          repo.updatedAt = nowIso();
          await this.persist();
        },
        timeoutMs + 15_000
      );
      return {
        ok: true,
        message: `${actionName} completed.`,
        transcript,
        snapshot: this.getSnapshot()
      };
    } catch (error) {
      return await this.handleActionFailure(repo, `${actionName} failed.`, error);
    }
  }

  private async handleActionFailure(
    repo: RepoRecord,
    fallbackMessage: string,
    error: unknown
  ): Promise<RepoActionResult> {
    if (error instanceof CommandFailedError) {
      repo.lastError = `${fallbackMessage} Exit code ${error.transcript.exitCode ?? "unknown"}.`;
      repo.lastErrorTranscript = error.transcript;
      this.pushTranscript(repo, error.transcript);
      repo.updatedAt = nowIso();
      await this.persist();
      return {
        ok: false,
        message: repo.lastError,
        transcript: error.transcript,
        snapshot: this.getSnapshot()
      };
    }

    const message = (error as Error).message || fallbackMessage;
    repo.lastError = message;
    repo.updatedAt = nowIso();
    await this.persist();
    return {
      ok: false,
      message,
      snapshot: this.getSnapshot()
    };
  }

  private async refreshRepoDirect(repo: RepoRecord, signal: AbortSignal): Promise<void> {
    let statusTranscript: CommandTranscript | null = null;
    let fetchError: CommandTranscript | null = null;

    if (this.state.settings.fetchOnRefresh) {
      try {
        const transcript = await runGitCommand(
          repo.environment,
          repo.path,
          ["fetch", "--all", "--prune", "--quiet"],
          {
            signal,
            timeoutMs: 45_000
          }
        );
        this.pushTranscript(repo, transcript);
      } catch (error) {
        if (error instanceof CommandFailedError) {
          fetchError = error.transcript;
          this.pushTranscript(repo, error.transcript);
        }
      }
    }

    try {
      statusTranscript = await runGitCommand(
        repo.environment,
        repo.path,
        ["status", "--porcelain=v1", "--branch", "-uall"],
        {
          signal,
          timeoutMs: 30_000
        }
      );
      this.pushTranscript(repo, statusTranscript);
      const parsed = parseStatusOutput(statusTranscript.stdout);
      const mergeInProgress = await this.gitPathExists(repo, "MERGE_HEAD", "any", signal);
      const rebaseInProgress =
        (await this.gitPathExists(repo, "rebase-merge", "dir", signal)) ||
        (await this.gitPathExists(repo, "rebase-apply", "dir", signal));

      repo.status = {
        ...parsed,
        mergeInProgress,
        rebaseInProgress,
        inaccessible: false,
        needsAttention:
          parsed.needsAttention ||
          mergeInProgress ||
          rebaseInProgress ||
          Boolean(fetchError),
        refreshedAt: nowIso()
      };
      repo.lastError = fetchError
        ? `Fetch failed (see transcript). Status may be stale against upstream.`
        : null;
      repo.lastErrorTranscript = fetchError;
      repo.updatedAt = nowIso();
    } catch (error) {
      if (error instanceof CommandFailedError) {
        const failedStatus = error.transcript;
        this.pushTranscript(repo, failedStatus);
        repo.status = {
          needsAttention: true,
          isDirty: false,
          hasStaged: false,
          hasUntracked: false,
          stagedCount: 0,
          modifiedCount: 0,
          untrackedCount: 0,
          conflictedCount: 0,
          changedFiles: [],
          branch: "unknown",
          isDetached: false,
          hasUpstream: false,
          ahead: 0,
          behind: 0,
          mergeInProgress: false,
          rebaseInProgress: false,
          inaccessible: true,
          refreshedAt: nowIso()
        };
        repo.lastError = "Repository inaccessible or git command failed.";
        repo.lastErrorTranscript = failedStatus;
        repo.updatedAt = nowIso();
        return;
      }
      throw error;
    }
  }

  private async gitPathExists(
    repo: RepoRecord,
    gitPathName: string,
    pathType: "any" | "dir",
    signal: AbortSignal
  ): Promise<boolean> {
    try {
      const transcript = await runGitCommand(
        repo.environment,
        repo.path,
        ["rev-parse", "--git-path", gitPathName],
        {
          signal,
          timeoutMs: 10_000
        }
      );
      const resolvedPath = transcript.stdout.trim();
      if (!resolvedPath) {
        return false;
      }

      if (repo.environment.kind === "windows") {
        const absolutePath = path.isAbsolute(resolvedPath)
          ? resolvedPath
          : path.join(repo.path, resolvedPath);
        try {
          const stats = await fs.stat(absolutePath);
          return pathType === "dir" ? stats.isDirectory() : true;
        } catch {
          return false;
        }
      }

      const testFlag = pathType === "dir" ? "-d" : "-e";
      await runWslScript(
        repo.environment.distro,
        `cd ${shellEscape(repo.path)} && [ ${testFlag} ${shellEscape(resolvedPath)} ]`,
        {
          signal,
          timeoutMs: 10_000
        }
      );
      return true;
    } catch {
      return false;
    }
  }

  private getRepo(repoId: string): RepoRecord {
    const repo = this.state.repos.find((item) => item.id === repoId);
    if (!repo) {
      throw new Error("Repository not found.");
    }
    return repo;
  }

  private registerRepo(input: {
    displayName: string;
    path: string;
    environment: RepoEnvironment;
  }): RepoRecord {
    const key = normalizePathKey(input.path, input.environment);
    const existing = this.state.repos.find(
      (repo) => normalizePathKey(repo.path, repo.environment) === key
    );
    if (existing) {
      return existing;
    }

    const now = nowIso();
    const repo: RepoRecord = {
      id: newId("repo"),
      displayName: input.displayName,
      path: input.path,
      environment: input.environment,
      createdAt: now,
      updatedAt: now,
      status: null,
      activeOperation: null,
      lastError: null,
      lastErrorTranscript: null,
      transcripts: []
    };
    this.state.repos.push(repo);
    return repo;
  }

  private pushTranscript(repo: RepoRecord, transcript: CommandTranscript): void {
    repo.transcripts.push(transcript);
    if (repo.transcripts.length > HISTORY_LIMIT) {
      repo.transcripts = repo.transcripts.slice(-HISTORY_LIMIT);
    }
  }

  private async assertIsGitRepository(
    repoPath: string,
    environment: RepoEnvironment
  ): Promise<void> {
    await runGitCommand(environment, repoPath, ["rev-parse", "--is-inside-work-tree"], {
      timeoutMs: 20_000
    });
  }

  private async pruneMissingRepos(): Promise<boolean> {
    const existingRepos: RepoRecord[] = [];
    const removedRepoIds: string[] = [];

    for (const repo of this.state.repos) {
      const exists = await this.repoPathExists(repo.environment, repo.path);
      if (exists === false) {
        removedRepoIds.push(repo.id);
        continue;
      }
      existingRepos.push(repo);
    }

    if (removedRepoIds.length === 0) {
      return false;
    }

    for (const repoId of removedRepoIds) {
      this.queue.cancelRepo(repoId);
    }
    this.state.repos = existingRepos;
    return true;
  }

  private async repoPathExists(
    environment: RepoEnvironment,
    repoPath: string
  ): Promise<boolean | null> {
    if (environment.kind === "windows") {
      try {
        await fs.access(repoPath);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          return false;
        }
        return null;
      }
    }

    try {
      const transcript = await runWslScript(
        environment.distro,
        `[ -d ${shellEscape(repoPath)} ] && printf '1' || printf '0'`,
        { timeoutMs: 10_000 }
      );
      const marker = transcript.stdout.trim();
      if (marker === "1") {
        return true;
      }
      if (marker === "0") {
        return false;
      }
      return null;
    } catch {
      return null;
    }
  }

  private shouldIgnore(targetPath: string): boolean {
    const normalized = targetPath.toLowerCase();
    for (const pattern of this.state.settings.ignorePatterns) {
      const token = pattern.trim().toLowerCase();
      if (!token) {
        continue;
      }
      if (normalized.includes(token)) {
        return true;
      }
    }
    return false;
  }

  private async scanWindowsRoot(rootPath: string): Promise<string[]> {
    const repos: string[] = [];
    const root = rootPath.trim();
    if (!root) {
      return repos;
    }

    const walk = async (current: string, depth: number): Promise<void> => {
      if (depth > 8 || this.shouldIgnore(current)) {
        return;
      }

      let entries: Dirent<string>[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true, encoding: "utf8" });
      } catch {
        return;
      }

      if (entries.some((entry) => entry.isDirectory() && entry.name === ".git")) {
        repos.push(current);
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          continue;
        }
        if (entry.name === ".git") {
          continue;
        }
        const next = path.join(current, entry.name);
        if (this.shouldIgnore(next)) {
          continue;
        }
        await walk(next, depth + 1);
      }
    };

    await walk(root, 0);
    return repos;
  }

  private async scanWslRoot(distro: string, rootPath: string): Promise<string[]> {
    const root = rootPath.trim();
    if (!root) {
      return [];
    }

    const script = `if [ -d ${shellEscape(root)} ]; then find ${shellEscape(
      root
    )} -type d -name .git -prune 2>/dev/null; fi`;
    try {
      const transcript = await runWslScript(distro, script, { timeoutMs: 90_000 });
      return transcript.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !this.shouldIgnore(line))
        .map((gitPath) => gitPath.replace(/\/\.git$/, ""));
    } catch {
      return [];
    }
  }

  private async launchShell(command: string, cwd?: string): Promise<void> {
    await this.launchDetached("cmd.exe", ["/c", command], cwd);
  }

  private renderEditorCommand(template: string, repoPath: string, forWsl = false): string {
    if (template.includes("<path>")) {
      return template.replaceAll(
        "<path>",
        forWsl ? shellEscape(repoPath) : `"${repoPath.replaceAll('"', '\\"')}"`
      );
    }
    if (forWsl) {
      return `${template} ${shellEscape(repoPath)}`;
    }
    return `${template} "${repoPath.replaceAll('"', '\\"')}"`;
  }

  private async launchDetached(command: string, args: string[], cwd?: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      let completed = false;
      child.once("error", (error) => {
        if (completed) {
          return;
        }
        completed = true;
        reject(error);
      });
      child.once("spawn", () => {
        if (completed) {
          return;
        }
        completed = true;
        child.unref();
        resolve();
      });
    });
  }

  private async findVsCodeExecutable(): Promise<string | null> {
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    const candidates = [
      localAppData
        ? path.join(localAppData, "Programs", "Microsoft VS Code", "Code.exe")
        : null,
      programFiles ? path.join(programFiles, "Microsoft VS Code", "Code.exe") : null,
      programFilesX86 ? path.join(programFilesX86, "Microsoft VS Code", "Code.exe") : null
    ].filter((item): item is string => Boolean(item));

    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // Try next path.
      }
    }

    return null;
  }

  private inferWslUserFromPath(repoPath: string): string | null {
    const match = repoPath.match(/^\/home\/([^/]+)/);
    if (!match || !match[1]) {
      return null;
    }
    return match[1];
  }

  private async findWindowsTerminalExecutable(): Promise<string | null> {
    const localAppData = process.env.LOCALAPPDATA;
    const candidates = [
      localAppData ? path.join(localAppData, "Microsoft", "WindowsApps", "wt.exe") : null
    ].filter((item): item is string => Boolean(item));

    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // Try next path.
      }
    }

    return null;
  }

  private async openWindowsTerminal(targetDirectory: string): Promise<void> {
    const escapedTarget = targetDirectory.replaceAll('"', '\\"');
    const wtExecutable = await this.findWindowsTerminalExecutable();

    const attempts = [
      wtExecutable
        ? `start "" "${wtExecutable.replaceAll('"', '\\"')}" -d "${escapedTarget}"`
        : null,
      `start "" wt -d "${escapedTarget}"`,
      `start "" wt.exe -d "${escapedTarget}"`
    ].filter((item): item is string => Boolean(item));

    let lastError: unknown = null;
    for (const command of attempts) {
      try {
        await runCommand("cmd.exe", ["/d", "/s", "/c", command], {
          timeoutMs: 15_000
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }

    const reason =
      lastError instanceof CommandFailedError
        ? lastError.transcript.stderr || lastError.transcript.stdout || "unknown error"
        : (lastError as Error | null)?.message ?? "unknown error";
    throw new Error(`Windows Terminal launch failed: ${reason}`);
  }

  private wslPathToUnc(distro: string, wslPath: string): string {
    const normalized = wslPath.replace(/\//g, "\\").replace(/^\\+/, "");
    return `\\\\wsl$\\${distro}\\${normalized}`;
  }

  private async persist(): Promise<void> {
    await this.store.save(this.state);
  }
}
