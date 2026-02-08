import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  AddRepoInput,
  DashboardSnapshot,
  KachinaApi,
  RepoActionResult,
  RepoRecord
} from "../shared/types";

type RepoFilter = "all" | "attention" | "dirty" | "ahead";

interface ManualRepoForm {
  displayName: string;
  path: string;
  environment: "windows" | "wsl";
  distro: string;
}

interface SettingsEditor {
  windowsRootsText: string;
  wslRootsText: string;
  ignorePatternsText: string;
  editorCommandWindows: string;
  editorCommandWsl: string;
  refreshIntervalSeconds: number;
  fetchOnRefresh: boolean;
}

const emptyManualForm: ManualRepoForm = {
  displayName: "",
  path: "",
  environment: "windows",
  distro: ""
};

function toSettingsEditor(snapshot: DashboardSnapshot): SettingsEditor {
  return {
    windowsRootsText: snapshot.settings.windowsRoots.join("\n"),
    wslRootsText: snapshot.settings.wslRoots.map((item) => `${item.distro}:${item.path}`).join("\n"),
    ignorePatternsText: snapshot.settings.ignorePatterns.join("\n"),
    editorCommandWindows: snapshot.settings.editorCommandWindows,
    editorCommandWsl: snapshot.settings.editorCommandWsl,
    refreshIntervalSeconds: snapshot.settings.refreshIntervalSeconds,
    fetchOnRefresh: snapshot.settings.fetchOnRefresh
  };
}

function formatEnv(repo: RepoRecord): string {
  if (repo.environment.kind === "windows") {
    return "Windows";
  }
  return `WSL:${repo.environment.distro}`;
}

function requireApi(): KachinaApi {
  if (!window.kachinaApi) {
    throw new Error(
      "Electron preload API unavailable. Restart `npm run dev` after a successful main-process compile."
    );
  }
  return window.kachinaApi;
}

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [filter, setFilter] = useState<RepoFilter>("attention");
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [manualForm, setManualForm] = useState<ManualRepoForm>(emptyManualForm);
  const [settingsEditor, setSettingsEditor] = useState<SettingsEditor | null>(null);
  const [commitMessage, setCommitMessage] = useState("");

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

  useEffect(() => {
    void loadSnapshot();
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

  async function loadSnapshot(): Promise<void> {
    setIsBusy(true);
    try {
      const next = await requireApi().getSnapshot();
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
    setIsBusy(true);
    try {
      const next = await requireApi().refreshAll();
      setSnapshot(next);
      setMessage("Refreshed all repositories.");
    } catch (error) {
      setMessage(`Refresh failed: ${(error as Error).message}`);
    } finally {
      setIsBusy(false);
    }
  }

  async function scanConfiguredRoots(): Promise<void> {
    setIsBusy(true);
    try {
      const next = await requireApi().scanConfiguredRoots();
      setSnapshot(next);
      setMessage("Scan complete.");
    } catch (error) {
      setMessage(`Scan failed: ${(error as Error).message}`);
    } finally {
      setIsBusy(false);
    }
  }

  async function performAction(action: Promise<RepoActionResult>): Promise<void> {
    setIsBusy(true);
    try {
      const result = await action;
      setSnapshot(result.snapshot);
      setMessage(result.message);
      if (!result.ok) {
        return;
      }
      if (result.message.toLowerCase().includes("commit completed")) {
        setCommitMessage("");
      }
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleAddRepo(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = {
      ...manualForm,
      path: manualForm.path.trim(),
      displayName: manualForm.displayName.trim(),
      distro: manualForm.distro.trim()
    };
    if (!form.path) {
      setMessage("Path is required.");
      return;
    }
    if (form.environment === "wsl" && !form.distro) {
      setMessage("WSL distro is required for WSL repos.");
      return;
    }
    const payload: AddRepoInput = {
      path: form.path,
      displayName: form.displayName || undefined,
      environment:
        form.environment === "windows"
          ? { kind: "windows" }
          : { kind: "wsl", distro: form.distro }
    };

    setIsBusy(true);
    try {
      const next = await requireApi().addRepo(payload);
      setSnapshot(next);
      setManualForm(emptyManualForm);
      setMessage("Repository added.");
    } catch (error) {
      setMessage(`Add repo failed: ${(error as Error).message}`);
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
      const next = await requireApi().updateSettings({
        windowsRoots,
        wslRoots,
        ignorePatterns,
        editorCommandWindows: settingsEditor.editorCommandWindows,
        editorCommandWsl: settingsEditor.editorCommandWsl,
        refreshIntervalSeconds: Math.max(30, settingsEditor.refreshIntervalSeconds),
        fetchOnRefresh: settingsEditor.fetchOnRefresh
      });
      setSnapshot(next);
      setMessage("Settings updated.");
    } catch (error) {
      setMessage(`Settings update failed: ${(error as Error).message}`);
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Kachina</p>
          <h1>Multi-Repo Git Dashboard</h1>
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

      {message && <div className="message-strip">{message}</div>}

      <main className="layout">
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
            <div className="empty-state">Add or discover repositories to begin.</div>
          ) : (
            <>
              <div className="detail-header">
                <div>
                  <p className="eyebrow">{formatEnv(selectedRepo)}</p>
                  <h2>{selectedRepo.displayName}</h2>
                  <p className="repo-path">{selectedRepo.path}</p>
                </div>
                <div className="detail-actions">
                  <button onClick={() => performAction(requireApi().openInEditor(selectedRepo.id))}>
                    Open Editor
                  </button>
                  <button
                    onClick={() => performAction(requireApi().openInFileManager(selectedRepo.id))}
                  >
                    Open Folder
                  </button>
                  <button onClick={() => performAction(requireApi().openInTerminal(selectedRepo.id))}>
                    Open Shell
                  </button>
                  <button
                    className="danger"
                    onClick={async () => {
                      setIsBusy(true);
                      try {
                        const next = await requireApi().removeRepo(selectedRepo.id);
                        setSnapshot(next);
                        setMessage("Repository removed.");
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
                      const next = await requireApi().cancelRepoOperation(selectedRepo.id);
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
                      {!selectedRepo.status?.mergeInProgress && !selectedRepo.status?.rebaseInProgress
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
                  <h3>Commit & Push</h3>
                  <textarea
                    rows={3}
                    value={commitMessage}
                    onChange={(event) => setCommitMessage(event.target.value)}
                    placeholder="Commit message"
                  />
                  <div className="inline-actions">
                    <button
                      onClick={() => performAction(requireApi().commitRepo(selectedRepo.id, commitMessage))}
                      disabled={isBusy}
                    >
                      Commit
                    </button>
                    <button
                      onClick={() => performAction(requireApi().pushRepo(selectedRepo.id))}
                      disabled={isBusy}
                    >
                      Push
                    </button>
                  </div>
                </section>
              </div>

              <section className="card">
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
                                  performAction(requireApi().unstageFile(selectedRepo.id, file.path))
                                }
                                disabled={isBusy}
                              >
                                Unstage
                              </button>
                            ) : (
                              <button
                                onClick={() =>
                                  performAction(requireApi().stageFile(selectedRepo.id, file.path))
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
            <h3>Add Repository</h3>
            <form onSubmit={handleAddRepo} className="stack-form">
              <input
                value={manualForm.displayName}
                onChange={(event) =>
                  setManualForm((current) => ({ ...current, displayName: event.target.value }))
                }
                placeholder="Display name (optional)"
              />
              <input
                value={manualForm.path}
                onChange={(event) =>
                  setManualForm((current) => ({ ...current, path: event.target.value }))
                }
                placeholder="Path"
              />
              <div className="inline-form">
                <select
                  value={manualForm.environment}
                  onChange={(event) =>
                    setManualForm((current) => ({
                      ...current,
                      environment: event.target.value as "windows" | "wsl"
                    }))
                  }
                >
                  <option value="windows">Windows</option>
                  <option value="wsl">WSL</option>
                </select>
                <input
                  value={manualForm.distro}
                  onChange={(event) =>
                    setManualForm((current) => ({ ...current, distro: event.target.value }))
                  }
                  placeholder="WSL distro"
                  disabled={manualForm.environment !== "wsl"}
                />
              </div>
              <button type="submit" disabled={isBusy}>
                Add
              </button>
            </form>
          </section>

          <section className="card">
            <h3>Discovery Settings</h3>
            {settingsEditor && (
              <form onSubmit={saveSettings} className="stack-form">
                <label>
                  Windows roots (one path per line)
                  <textarea
                    rows={3}
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
                    rows={3}
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
                    rows={3}
                    value={settingsEditor.ignorePatternsText}
                    onChange={(event) =>
                      setSettingsEditor((current) =>
                        current ? { ...current, ignorePatternsText: event.target.value } : current
                      )
                    }
                  />
                </label>
                <label>
                  Editor command (Windows)
                  <input
                    value={settingsEditor.editorCommandWindows}
                    onChange={(event) =>
                      setSettingsEditor((current) =>
                        current
                          ? { ...current, editorCommandWindows: event.target.value }
                          : current
                      )
                    }
                    placeholder="code <path>"
                  />
                </label>
                <label>
                  Editor command (WSL)
                  <input
                    value={settingsEditor.editorCommandWsl}
                    onChange={(event) =>
                      setSettingsEditor((current) =>
                        current ? { ...current, editorCommandWsl: event.target.value } : current
                      )
                    }
                    placeholder="code <path>"
                  />
                </label>
                <label>
                  Refresh interval (seconds)
                  <input
                    type="number"
                    min={30}
                    value={settingsEditor.refreshIntervalSeconds}
                    onChange={(event) =>
                      setSettingsEditor((current) =>
                        current
                          ? {
                              ...current,
                              refreshIntervalSeconds: Number.parseInt(event.target.value, 10) || 30
                            }
                          : current
                      )
                    }
                  />
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settingsEditor.fetchOnRefresh}
                    onChange={(event) =>
                      setSettingsEditor((current) =>
                        current ? { ...current, fetchOnRefresh: event.target.checked } : current
                      )
                    }
                  />
                  Run fetch during refresh
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
  );
}

