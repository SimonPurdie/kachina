import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  CommandTranscript,
  DashboardSnapshot,
  RepoActionResult,
  RepoRecord
} from "../shared/types";
import {
  ActivityPanel,
  type ActivityCommand,
  type ActivityRepoOperation,
  type ActivityState,
  type ActivityStatus
} from "./ActivityPanel";
import twirlyIcon from "./assets/kachina-twirly-icon.svg";
import { getKachinaApi } from "./browser-api";

type RepoFilter = "all" | "attention" | "dirty" | "ahead";

const SIMPLE_COMMIT_MESSAGE = "update";

interface SettingsEditor {
  windowsRootsText: string;
  wslRootsText: string;
  ignorePatternsText: string;
  ignoredReposText: string;
}

function toSettingsEditor(snapshot: DashboardSnapshot): SettingsEditor {
  return {
    windowsRootsText: snapshot.settings.windowsRoots.join("\n"),
    wslRootsText: snapshot.settings.wslRoots.map((item) => `${item.distro}:${item.path}`).join("\n"),
    ignorePatternsText: snapshot.settings.ignorePatterns.join("\n"),
    ignoredReposText: snapshot.settings.ignoredRepos.join("\n")
  };
}

function formatEnv(repo: RepoRecord): string {
  if (repo.environment.kind === "windows") {
    return "Windows";
  }
  return `WSL:${repo.environment.distro}`;
}

function transcriptKey(repoId: string, transcript: CommandTranscript): string {
  return [
    repoId,
    transcript.startedAt,
    transcript.finishedAt,
    transcript.command
  ].join("\u0000");
}

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [filter, setFilter] = useState<RepoFilter>("attention");
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [settingsEditor, setSettingsEditor] = useState<SettingsEditor | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [isSettingsPanelOpen, setIsSettingsPanelOpen] = useState(false);
  const [isSettingsPanelAnimating, setIsSettingsPanelAnimating] = useState(false);
  const [isSimpleCommitDialogOpen, setIsSimpleCommitDialogOpen] = useState(false);
  const [activity, setActivity] = useState<ActivityState | null>(null);
  const [isActivityPanelCollapsed, setIsActivityPanelCollapsed] = useState(false);
  const simpleCommitCancelRef = useRef<HTMLButtonElement>(null);
  const primaryActionButtonRef = useRef<HTMLButtonElement>(null);
  const activitySequenceRef = useRef(0);
  const activeActivityIdRef = useRef<number | null>(null);
  const knownActivityTranscriptsRef = useRef<Set<string>>(new Set());

  const selectedRepo = useMemo(
    () => snapshot?.repos.find((repo) => repo.id === selectedRepoId) ?? null,
    [snapshot, selectedRepoId]
  );

  const filteredRepos = useMemo(() => {
    const repos = snapshot?.repos ?? [];
    return repos.filter((repo) => {
      if (!repo.status) {
        return filter === "all";
      }
      if (filter === "all") {
        return true;
      }
      if (filter === "attention") {
        return repo.status.needsAttention || Boolean(repo.lastError);
      }
      if (filter === "dirty") {
        return repo.status.isDirty;
      }
      if (filter === "ahead") {
        return repo.status.ahead > 0;
      }
      return true;
    });
  }, [snapshot, filter]);

  const hasChangedFiles = Boolean(selectedRepo?.status?.changedFiles.length);
  const needsSync = Boolean(
    selectedRepo?.status && (selectedRepo.status.ahead > 0 || selectedRepo.status.behind > 0)
  );
  const primaryActionLabel = hasChangedFiles ? "Commit" : needsSync ? "Sync" : "Synced";
  const primaryActionDisabled = isBusy || (!hasChangedFiles && !needsSync);
  const statusMessage = message || "Let's go, Twirly!";
  const isPlaceholderMessage = !message;
  const isElectronHost = Boolean(window.kachinaWindowApi);

  useEffect(() => {
    let isMounted = true;
    const windowApi = window.kachinaWindowApi;

    void loadSnapshot();
    if (!windowApi) {
      return () => {
        isMounted = false;
      };
    }

    void windowApi
      .isWindowMaximized()
      .then((next) => {
        if (isMounted) {
          setIsWindowMaximized(next);
        }
      })
      .catch(() => {
        if (isMounted) {
          setIsWindowMaximized(false);
        }
      });

    const dispose = windowApi.onWindowStateChanged((next) => {
      setIsWindowMaximized(next);
    });

    return () => {
      isMounted = false;
      dispose();
    };
  }, []);

  useEffect(() => {
    if (!snapshot) {
      return;
    }

    if (!selectedRepoId || !snapshot.repos.some((repo) => repo.id === selectedRepoId)) {
      const next = snapshot.repos[0];
      setSelectedRepoId(next ? next.id : null);
      return;
    }
  }, [snapshot, selectedRepoId]);

  useEffect(() => {
    if (!isSettingsPanelAnimating) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setIsSettingsPanelAnimating(false);
    }, 360);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isSettingsPanelAnimating, isSettingsPanelOpen]);

  useEffect(() => {
    if (isSimpleCommitDialogOpen) {
      simpleCommitCancelRef.current?.focus();
    }
  }, [isSimpleCommitDialogOpen]);

  useEffect(() => {
    if (!activity || activity.status !== "running") {
      return;
    }

    let isCancelled = false;
    const activityId = activity.id;

    const pollActivity = async (): Promise<void> => {
      try {
        const next = await getKachinaApi().getSnapshot();
        if (!isCancelled) {
          setSnapshot(next);
          updateActivityFromSnapshot(activityId, next);
        }
      } catch {
        // The action request reports connection failures through its normal result path.
      }
    };

    void pollActivity();
    const intervalId = window.setInterval(() => void pollActivity(), 500);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activity?.id, activity?.status]);

  function collectActivityCommands(snapshotToRead: DashboardSnapshot): ActivityCommand[] {
    const commands: ActivityCommand[] = [];

    for (const repo of snapshotToRead.repos) {
      for (const transcript of repo.transcripts) {
        const key = transcriptKey(repo.id, transcript);
        if (knownActivityTranscriptsRef.current.has(key)) {
          continue;
        }
        knownActivityTranscriptsRef.current.add(key);
        commands.push({
          ...transcript,
          key,
          repoName: repo.displayName
        });
      }
    }

    return commands.sort(
      (left, right) =>
        new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime()
    );
  }

  function activeRepoOperations(
    snapshotToRead: DashboardSnapshot
  ): ActivityRepoOperation[] {
    return snapshotToRead.repos.flatMap((repo) =>
      repo.activeOperation
        ? [
            {
              repoId: repo.id,
              repoName: repo.displayName,
              name: repo.activeOperation.name,
              startedAt: repo.activeOperation.startedAt,
              currentCommand: repo.activeOperation.currentCommand
            }
          ]
        : []
    );
  }

  function beginActivity(label: string): number {
    const id = activitySequenceRef.current + 1;
    activitySequenceRef.current = id;
    activeActivityIdRef.current = id;
    knownActivityTranscriptsRef.current = new Set(
      (snapshot?.repos ?? []).flatMap((repo) =>
        repo.transcripts.map((transcript) => transcriptKey(repo.id, transcript))
      )
    );
    setActivity({
      id,
      label,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: "running",
      commands: [],
      activeOperations: []
    });
    setIsActivityPanelCollapsed(false);
    return id;
  }

  function updateActivityFromSnapshot(
    activityId: number,
    next: DashboardSnapshot
  ): void {
    if (activeActivityIdRef.current !== activityId) {
      return;
    }
    const commands = collectActivityCommands(next);
    const activeOperations = activeRepoOperations(next);
    setActivity((current) =>
      current?.id === activityId
        ? {
            ...current,
            commands: [...current.commands, ...commands],
            activeOperations
          }
        : current
    );
  }

  function finishActivity(
    activityId: number,
    status: Exclude<ActivityStatus, "running">,
    finalSnapshot?: DashboardSnapshot
  ): void {
    if (activeActivityIdRef.current !== activityId) {
      return;
    }
    const commands = finalSnapshot ? collectActivityCommands(finalSnapshot) : [];
    activeActivityIdRef.current = null;
    setActivity((current) =>
      current?.id === activityId
        ? {
            ...current,
            status,
            finishedAt: new Date().toISOString(),
            commands: [...current.commands, ...commands],
            activeOperations: []
          }
        : current
    );
  }

  async function loadSnapshot(): Promise<void> {
    setIsBusy(true);
    try {
      const next = await getKachinaApi().getSnapshot();
      setSnapshot(next);
      setSettingsEditor(toSettingsEditor(next));
      setMessage("");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setIsBusy(false);
    }
  }

  async function refreshAll(): Promise<void> {
    const activityId = beginActivity("Refresh All");
    setIsBusy(true);
    try {
      const next = await getKachinaApi().refreshAll();
      setSnapshot(next);
      setMessage("Refreshed all repositories.");
      finishActivity(activityId, "success", next);
    } catch (error) {
      setMessage(`Refresh failed: ${(error as Error).message}`);
      finishActivity(activityId, "error");
    } finally {
      setIsBusy(false);
    }
  }

  async function scanConfiguredRoots(): Promise<void> {
    const activityId = beginActivity("Scan Roots");
    setIsBusy(true);
    try {
      const next = await getKachinaApi().scanConfiguredRoots();
      setSnapshot(next);
      setMessage("Scan complete.");
      finishActivity(activityId, "success", next);
    } catch (error) {
      setMessage(`Scan failed: ${(error as Error).message}`);
      finishActivity(activityId, "error");
    } finally {
      setIsBusy(false);
    }
  }

  async function performAction(
    action: Promise<RepoActionResult>,
    activityLabel?: string
  ): Promise<void> {
    const activityId = activityLabel ? beginActivity(activityLabel) : null;
    setIsBusy(true);
    try {
      const result = await action;
      setSnapshot(result.snapshot);
      setMessage(result.message);
      if (activityId !== null) {
        finishActivity(activityId, result.ok ? "success" : "error", result.snapshot);
      }
      if (!result.ok) {
        return;
      }
      if (result.message.toLowerCase().includes("commit completed")) {
        setCommitMessage("");
      }
    } catch (error) {
      setMessage((error as Error).message);
      if (activityId !== null) {
        finishActivity(activityId, "error");
      }
    } finally {
      setIsBusy(false);
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!settingsEditor) {
      return;
    }
    const windowsRoots = settingsEditor.windowsRootsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const ignorePatterns = settingsEditor.ignorePatternsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const ignoredRepos = settingsEditor.ignoredReposText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const wslRoots = settingsEditor.wslRootsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(":");
        if (separator < 1) {
          return null;
        }
        return {
          id: `wsl_${line}`,
          distro: line.slice(0, separator).trim(),
          path: line.slice(separator + 1).trim()
        };
      })
      .filter((value): value is NonNullable<typeof value> => Boolean(value));

    setIsBusy(true);
    try {
      const next = await getKachinaApi().updateSettings({
        windowsRoots,
        wslRoots,
        ignorePatterns,
        ignoredRepos
      });
      setSnapshot(next);
      setSettingsEditor(toSettingsEditor(next));
      setMessage("Settings updated.");
    } catch (error) {
      setMessage(`Settings update failed: ${(error as Error).message}`);
    } finally {
      setIsBusy(false);
    }
  }

  async function handlePrimaryRepoAction(): Promise<void> {
    if (!selectedRepo?.status) {
      return;
    }

    if (selectedRepo.status.changedFiles.length > 0) {
      if (!commitMessage.trim()) {
        setIsSimpleCommitDialogOpen(true);
        return;
      }
      await performAction(
        getKachinaApi().commitRepo(selectedRepo.id, commitMessage),
        `Commit · ${selectedRepo.displayName}`
      );
      return;
    }

    if (selectedRepo.status.ahead > 0 || selectedRepo.status.behind > 0) {
      await performAction(
        getKachinaApi().syncRepo(selectedRepo.id),
        `Sync · ${selectedRepo.displayName}`
      );
    }
  }

  async function confirmSimpleCommit(): Promise<void> {
    if (!selectedRepo?.status?.changedFiles.length || isBusy) {
      setIsSimpleCommitDialogOpen(false);
      return;
    }

    setCommitMessage(SIMPLE_COMMIT_MESSAGE);
    setIsSimpleCommitDialogOpen(false);
    await performAction(
      getKachinaApi().commitRepo(selectedRepo.id, SIMPLE_COMMIT_MESSAGE),
      `Commit · ${selectedRepo.displayName}`
    );
  }

  function closeSimpleCommitDialog(): void {
    setIsSimpleCommitDialogOpen(false);
    window.requestAnimationFrame(() => primaryActionButtonRef.current?.focus());
  }

  function handleSimpleCommitDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSimpleCommitDialog();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")
    );
    const firstButton = buttons[0];
    const lastButton = buttons.at(-1);

    if (event.shiftKey && document.activeElement === firstButton) {
      event.preventDefault();
      lastButton?.focus();
    } else if (!event.shiftKey && document.activeElement === lastButton) {
      event.preventDefault();
      firstButton?.focus();
    }
  }

  async function handleWindowMinimize(): Promise<void> {
    await window.kachinaWindowApi?.windowMinimize();
  }

  async function handleWindowToggleMaximize(): Promise<void> {
    const next = await window.kachinaWindowApi?.windowToggleMaximize();
    if (next === undefined) {
      return;
    }
    setIsWindowMaximized(next);
  }

  async function handleWindowClose(): Promise<void> {
    await window.kachinaWindowApi?.windowClose();
  }

  function handleSettingsToggle(): void {
    setIsSettingsPanelAnimating(true);
    setIsSettingsPanelOpen((current) => !current);
  }

  return (
    <div className="app-shell">
      {isElectronHost && (
        <header className="window-titlebar">
          <div className="window-titlebar-brand">
            <img src={twirlyIcon} alt="" aria-hidden="true" className="window-titlebar-icon" />
            <div className="window-titlebar-copy">
              <strong>Kachina</strong>
            </div>
          </div>
          <div className="window-titlebar-controls">
            <button
              type="button"
              className="window-control"
              aria-label="Minimize window"
              onClick={() => void handleWindowMinimize()}
            >
              <span className="window-control-icon minimize" />
            </button>
            <button
              type="button"
              className="window-control"
              aria-label={isWindowMaximized ? "Restore window" : "Maximize window"}
              onClick={() => void handleWindowToggleMaximize()}
            >
              <span
                className={`window-control-icon ${
                  isWindowMaximized ? "restore" : "maximize"
                }`}
              />
            </button>
            <button
              type="button"
              className="window-control close"
              aria-label="Close window"
              onClick={() => void handleWindowClose()}
            >
              <span className="window-control-icon close" />
            </button>
          </div>
        </header>
      )}

      <div className="app-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">Multi-Repo Git Dashboard</p>
            <h1>Kachina</h1>
          </div>
          <div className="topbar-actions">
            <button onClick={refreshAll} disabled={isBusy}>
              Refresh All
            </button>
            <button onClick={scanConfiguredRoots} disabled={isBusy}>
              Scan Roots
            </button>
          </div>
        </header>

        <div className="message-row">
          <div className={`message-strip${isPlaceholderMessage ? " placeholder" : ""}`}>
            {statusMessage}
          </div>
          <button
            type="button"
            className={`settings-toggle${isSettingsPanelOpen ? " pressed" : ""}${
              isSettingsPanelAnimating ? " animating" : ""
            }`}
            aria-label={isSettingsPanelOpen ? "Hide settings panel" : "Show settings panel"}
            aria-pressed={isSettingsPanelOpen}
            onClick={handleSettingsToggle}
          >
            <svg
              className="settings-cog"
              viewBox="0 0 24 24"
              role="img"
              aria-hidden="true"
              focusable="false"
            >
              <circle cx="12" cy="12" r="3.45" />
              <circle cx="12" cy="12" r="7.15" />
              <path d="M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3M4.1 4.1l2.1 2.1M17.8 17.8l2.1 2.1M19.9 4.1l-2.1 2.1M6.2 17.8l-2.1 2.1" />
            </svg>
          </button>
        </div>
        <main className={`layout ${isSettingsPanelOpen ? "settings-open" : "settings-closed"}`}>
          <aside className="repo-panel">
            <div className="filter-row">
              <button
                className={filter === "attention" ? "active" : ""}
                onClick={() => setFilter("attention")}
              >
                Attention
              </button>
              <button
                className={filter === "dirty" ? "active" : ""}
                onClick={() => setFilter("dirty")}
              >
                Dirty
              </button>
              <button
                className={filter === "ahead" ? "active" : ""}
                onClick={() => setFilter("ahead")}
              >
                Ahead
              </button>
              <button
                className={filter === "all" ? "active" : ""}
                onClick={() => setFilter("all")}
              >
                All
              </button>
            </div>

            <div className="repo-list">
              {filteredRepos.map((repo) => {
                const isActive = repo.id === selectedRepoId;
                return (
                  <button
                    key={repo.id}
                    className={`repo-card ${isActive ? "selected" : ""}`}
                    onClick={() => setSelectedRepoId(repo.id)}
                  >
                    <div className="repo-card-head">
                      <strong>{repo.displayName}</strong>
                      <span className={`state-pill ${repo.status?.needsAttention ? "warn" : "ok"}`}>
                        {repo.status?.needsAttention ? "Needs Attention" : "Clean"}
                      </span>
                    </div>
                    <p className="repo-meta">{formatEnv(repo)}</p>
                    <p className="repo-path">{repo.path}</p>
                    {repo.status && (
                      <div className="repo-stats">
                        <span>Branch {repo.status.branch}</span>
                        <span>Staged {repo.status.stagedCount}</span>
                        <span>Changed {repo.status.modifiedCount}</span>
                        <span>Untracked {repo.status.untrackedCount}</span>
                        <span>
                          Ahead/Behind {repo.status.ahead}/{repo.status.behind}
                        </span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="detail-panel">
            {!selectedRepo ? (
              <div className="empty-state">Use Discovery Settings to find repositories.</div>
            ) : (
              <>
                <div className="detail-header">
                  <div className="detail-title">
                    <p className="eyebrow">{formatEnv(selectedRepo)}</p>
                    <h2>{selectedRepo.displayName}</h2>
                    <p className="repo-path">{selectedRepo.path}</p>
                  </div>
                  <div className="detail-actions">
                    <button
                      onClick={() =>
                        performAction(getKachinaApi().openInEditor(selectedRepo.id))
                      }
                    >
                      Open Editor
                    </button>
                    <button
                      onClick={() =>
                        performAction(getKachinaApi().openInFileManager(selectedRepo.id))
                      }
                    >
                      Open Folder
                    </button>
                    <button
                      onClick={() =>
                        performAction(getKachinaApi().openInTerminal(selectedRepo.id))
                      }
                    >
                      Open Shell
                    </button>
                    <button
                      className="danger"
                      onClick={async () => {
                        setIsBusy(true);
                        try {
                          const next = await getKachinaApi().removeRepo(selectedRepo.id);
                          setSnapshot(next);
                          setSettingsEditor(toSettingsEditor(next));
                          setMessage("Repository removed and added to ignored repos.");
                        } catch (error) {
                          setMessage((error as Error).message);
                        } finally {
                          setIsBusy(false);
                        }
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {selectedRepo.activeOperation && (
                  <div className="operation-banner">
                    <span>
                      In progress: {selectedRepo.activeOperation.name} since{" "}
                      {new Date(selectedRepo.activeOperation.startedAt).toLocaleTimeString()}
                    </span>
                    <button
                      className="danger"
                      onClick={async () => {
                        const next = await getKachinaApi().cancelRepoOperation(selectedRepo.id);
                        setSnapshot(next);
                        setMessage("Cancel requested.");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                )}

                <div className="detail-grid">
                  <section className="card">
                    <h3>Status</h3>
                    <div className="status-grid">
                      <span>Branch</span>
                      <span>{selectedRepo.status?.branch ?? "Unknown"}</span>
                      <span>Upstream</span>
                      <span>{selectedRepo.status?.hasUpstream ? "Configured" : "None"}</span>
                      <span>Ahead/Behind</span>
                      <span>
                        {selectedRepo.status?.ahead ?? 0}/{selectedRepo.status?.behind ?? 0}
                      </span>
                      <span>Dirty</span>
                      <span>{selectedRepo.status?.isDirty ? "Yes" : "No"}</span>
                      <span>Merge/Rebase</span>
                      <span>
                        {selectedRepo.status?.mergeInProgress ? "Merge " : ""}
                        {selectedRepo.status?.rebaseInProgress ? "Rebase" : ""}
                        {!selectedRepo.status?.mergeInProgress &&
                        !selectedRepo.status?.rebaseInProgress
                          ? "None"
                          : ""}
                      </span>
                      <span>Last Refresh</span>
                      <span>
                        {selectedRepo.status?.refreshedAt
                          ? new Date(selectedRepo.status.refreshedAt).toLocaleString()
                          : "Never"}
                      </span>
                    </div>
                  </section>

                  <section className="card">
                    <h3>Actions</h3>
                    <textarea
                      rows={3}
                      spellCheck={false}
                      value={commitMessage}
                      onChange={(event) => setCommitMessage(event.target.value)}
                      placeholder="Commit message"
                    />
                    <div className="inline-actions">
                      <button
                        ref={primaryActionButtonRef}
                        onClick={() => void handlePrimaryRepoAction()}
                        disabled={primaryActionDisabled}
                      >
                        {primaryActionLabel}
                      </button>
                    </div>
                  </section>
                </div>

                <section className="card changed-files-card">
                  <h3>Changed Files</h3>
                  {selectedRepo.status?.changedFiles.length ? (
                    <table className="files-table">
                      <thead>
                        <tr>
                          <th>Path</th>
                          <th>Index</th>
                          <th>Worktree</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedRepo.status.changedFiles.map((file) => (
                          <tr key={`${file.path}_${file.indexStatus}_${file.worktreeStatus}`}>
                            <td>{file.path}</td>
                            <td>{file.indexStatus}</td>
                            <td>{file.worktreeStatus}</td>
                            <td>
                              {file.isStaged ? (
                                <button
                                  onClick={() =>
                                    performAction(
                                      getKachinaApi().unstageFile(selectedRepo.id, file.path),
                                      `Unstage · ${selectedRepo.displayName}`
                                    )
                                  }
                                  disabled={isBusy}
                                >
                                  Unstage
                                </button>
                              ) : (
                                <button
                                  onClick={() =>
                                    performAction(
                                      getKachinaApi().stageFile(selectedRepo.id, file.path),
                                      `Stage · ${selectedRepo.displayName}`
                                    )
                                  }
                                  disabled={isBusy}
                                >
                                  Stage
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p>No changed files.</p>
                  )}
                </section>

                {selectedRepo.lastErrorTranscript && (
                  <details className="card">
                    <summary>Last Error Transcript</summary>
                    <pre>
                      {selectedRepo.lastErrorTranscript.command}
                      {"\n\n"}
                      {selectedRepo.lastErrorTranscript.stderr || "(no stderr)"}
                      {"\n\n"}
                      {selectedRepo.lastErrorTranscript.stdout || "(no stdout)"}
                    </pre>
                  </details>
                )}
              </>
            )}
          </section>

          <aside className="settings-panel">
            <section className="card">
              <h3>Discovery Settings</h3>
              {settingsEditor && (
                <form onSubmit={saveSettings} className="stack-form discovery-form">
                  <label>
                    Windows roots (one path per line)
                    <textarea
                      className="discovery-textarea"
                      rows={3}
                      spellCheck={false}
                      value={settingsEditor.windowsRootsText}
                      onChange={(event) =>
                        setSettingsEditor((current) =>
                          current ? { ...current, windowsRootsText: event.target.value } : current
                        )
                      }
                    />
                  </label>
                  <label>
                    WSL roots (`distro:/path`, one per line)
                    <textarea
                      className="discovery-textarea"
                      rows={3}
                      spellCheck={false}
                      value={settingsEditor.wslRootsText}
                      onChange={(event) =>
                        setSettingsEditor((current) =>
                          current ? { ...current, wslRootsText: event.target.value } : current
                        )
                      }
                    />
                  </label>
                  <label>
                    Ignore patterns (one token per line)
                    <textarea
                      className="discovery-textarea"
                      rows={3}
                      spellCheck={false}
                      value={settingsEditor.ignorePatternsText}
                      onChange={(event) =>
                        setSettingsEditor((current) =>
                          current ? { ...current, ignorePatternsText: event.target.value } : current
                        )
                      }
                    />
                  </label>
                  <label>
                    Ignored repos (`windows:C:\repo` or `wsl:distro:/path`, one per line)
                    <textarea
                      className="discovery-textarea"
                      rows={3}
                      spellCheck={false}
                      value={settingsEditor.ignoredReposText}
                      onChange={(event) =>
                        setSettingsEditor((current) =>
                          current ? { ...current, ignoredReposText: event.target.value } : current
                        )
                      }
                    />
                  </label>
                  <button type="submit" disabled={isBusy}>
                    Save Settings
                  </button>
                </form>
              )}
            </section>
          </aside>
        </main>
      </div>

      {isSimpleCommitDialogOpen && (
        <div className="modal-backdrop">
          <div
            className="confirmation-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="simple-commit-dialog-title"
            onKeyDown={handleSimpleCommitDialogKeyDown}
          >
            <p className="eyebrow">Commit message required</p>
            <h2 id="simple-commit-dialog-title">
              Commit with simple message: <span>&quot;update&quot;</span> ?
            </h2>
            <div className="confirmation-dialog-actions">
              <button
                ref={simpleCommitCancelRef}
                type="button"
                className="secondary"
                onClick={closeSimpleCommitDialog}
              >
                Cancel
              </button>
              <button type="button" onClick={() => void confirmSimpleCommit()}>
                Commit
              </button>
            </div>
          </div>
        </div>
      )}

      {activity && (
        <ActivityPanel
          activity={activity}
          isCollapsed={isActivityPanelCollapsed}
          onToggleCollapsed={() => setIsActivityPanelCollapsed((current) => !current)}
          onDismiss={() => setActivity(null)}
        />
      )}
    </div>
  );
}
