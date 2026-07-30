import { useEffect, useRef } from "react";
import type { ActiveCommand, CommandTranscript } from "../shared/types";

export type ActivityStatus = "running" | "success" | "error";

export interface ActivityCommand extends CommandTranscript {
  key: string;
  repoName: string;
}

export interface ActivityRepoOperation {
  repoId: string;
  repoName: string;
  name: string;
  startedAt: string;
  currentCommand: ActiveCommand | null;
}

export interface ActivityState {
  id: number;
  label: string;
  startedAt: string;
  finishedAt: string | null;
  status: ActivityStatus;
  commands: ActivityCommand[];
  activeOperations: ActivityRepoOperation[];
}

interface ActivityPanelProps {
  activity: ActivityState;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  onDismiss: () => void;
}

function statusLabel(status: ActivityStatus): string {
  if (status === "success") {
    return "Complete";
  }
  if (status === "error") {
    return "Failed";
  }
  return "Working";
}

export function ActivityPanel({
  activity,
  isCollapsed,
  onToggleCollapsed,
  onDismiss
}: ActivityPanelProps): JSX.Element {
  const logRef = useRef<HTMLDivElement>(null);
  const runningCommands = activity.activeOperations.filter(
    (operation) => operation.currentCommand
  );

  useEffect(() => {
    if (!isCollapsed && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [activity.commands.length, activity.activeOperations, activity.status, isCollapsed]);

  return (
    <aside
      className={`activity-panel ${activity.status}${isCollapsed ? " collapsed" : ""}`}
      aria-label="Command activity"
    >
      <header className="activity-panel-header">
        <div className="activity-panel-heading">
          <span className="activity-status-mark" aria-hidden="true" />
          <div>
            <span className="activity-status-label">{statusLabel(activity.status)}</span>
            <strong>{activity.label}</strong>
          </div>
        </div>
        <div className="activity-panel-controls">
          <button
            type="button"
            className="activity-panel-control"
            aria-label={isCollapsed ? "Expand command activity" : "Collapse command activity"}
            aria-expanded={!isCollapsed}
            onClick={onToggleCollapsed}
          >
            {isCollapsed ? "↑" : "↓"}
          </button>
          {activity.status !== "running" && (
            <button
              type="button"
              className="activity-panel-control"
              aria-label="Dismiss command activity"
              onClick={onDismiss}
            >
              ×
            </button>
          )}
        </div>
      </header>

      {!isCollapsed && (
        <div className="activity-panel-body">
          <div className="activity-summary" aria-live="polite">
            {activity.status === "running" && activity.activeOperations.length === 0 && (
              <span className="activity-waiting">Preparing next command…</span>
            )}
            {activity.activeOperations.map((operation) => (
              <span className="activity-operation" key={`${operation.repoId}_${operation.startedAt}`}>
                <strong>{operation.repoName}</strong>
                <span>{operation.name}</span>
              </span>
            ))}
            {activity.status !== "running" && (
              <span>
                Finished at{" "}
                {new Date(activity.finishedAt ?? Date.now()).toLocaleTimeString()}
              </span>
            )}
          </div>

          <div
            ref={logRef}
            className="activity-terminal"
            role="log"
            aria-live="polite"
            aria-label="Command output"
          >
            {runningCommands.map((operation) => (
              <section
                className="activity-command live"
                key={`${operation.repoId}_${operation.currentCommand?.startedAt}`}
              >
                <div className="activity-command-meta">
                  <span>{operation.repoName}</span>
                  <span className="running">running</span>
                </div>
                <pre className="activity-command-line">
                  <span aria-hidden="true">$ </span>
                  {operation.currentCommand?.command}
                </pre>
                {operation.currentCommand?.stdout && (
                  <pre className="activity-command-output stdout">
                    {operation.currentCommand.stdout}
                  </pre>
                )}
                {operation.currentCommand?.stderr && (
                  <pre className="activity-command-output stderr">
                    {operation.currentCommand.stderr}
                  </pre>
                )}
              </section>
            ))}
            {activity.commands.length === 0 && runningCommands.length === 0 ? (
              <div className="activity-terminal-empty">
                {activity.status === "running"
                  ? "Command output will appear here."
                  : "No terminal commands were needed."}
              </div>
            ) : (
              activity.commands.map((command) => (
                <section className="activity-command" key={command.key}>
                  <div className="activity-command-meta">
                    <span>{command.repoName}</span>
                    <span className={command.exitCode === 0 ? "ok" : "failed"}>
                      exit {command.exitCode ?? "?"}
                    </span>
                  </div>
                  <pre className="activity-command-line">
                    <span aria-hidden="true">$ </span>
                    {command.command}
                  </pre>
                  {command.stdout && (
                    <pre className="activity-command-output stdout">{command.stdout}</pre>
                  )}
                  {command.stderr && (
                    <pre className="activity-command-output stderr">{command.stderr}</pre>
                  )}
                  {!command.stdout && !command.stderr && (
                    <div className="activity-command-silent">(no output)</div>
                  )}
                </section>
              ))
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
