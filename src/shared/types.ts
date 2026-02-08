export type RepoEnvironmentKind = "windows" | "wsl";

export interface WindowsEnvironment {
  kind: "windows";
}

export interface WslEnvironment {
  kind: "wsl";
  distro: string;
}

export type RepoEnvironment = WindowsEnvironment | WslEnvironment;

export interface WslScanRoot {
  id: string;
  distro: string;
  path: string;
}

export interface DashboardSettings {
  windowsRoots: string[];
  wslRoots: WslScanRoot[];
  ignorePatterns: string[];
  ignoredRepos: string[];
  editorCommandWindows: string;
  editorCommandWsl: string;
  refreshIntervalSeconds: number;
  fetchOnRefresh: boolean;
}

export interface CommandTranscript {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  timedOut: boolean;
}

export interface ActiveOperation {
  id: string;
  name: string;
  startedAt: string;
}

export interface ChangedFile {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  isUntracked: boolean;
  isStaged: boolean;
  isUnstaged: boolean;
  isConflicted: boolean;
}

export interface RepoStatusSummary {
  needsAttention: boolean;
  isDirty: boolean;
  hasStaged: boolean;
  hasUntracked: boolean;
  stagedCount: number;
  modifiedCount: number;
  untrackedCount: number;
  conflictedCount: number;
  changedFiles: ChangedFile[];
  branch: string;
  isDetached: boolean;
  hasUpstream: boolean;
  ahead: number;
  behind: number;
  mergeInProgress: boolean;
  rebaseInProgress: boolean;
  inaccessible: boolean;
  refreshedAt: string;
}

export interface RepoRecord {
  id: string;
  displayName: string;
  path: string;
  environment: RepoEnvironment;
  createdAt: string;
  updatedAt: string;
  status: RepoStatusSummary | null;
  activeOperation: ActiveOperation | null;
  lastError: string | null;
  lastErrorTranscript: CommandTranscript | null;
  transcripts: CommandTranscript[];
}

export interface DashboardSnapshot {
  repos: RepoRecord[];
  settings: DashboardSettings;
  generatedAt: string;
}

export interface AddRepoInput {
  displayName?: string;
  path: string;
  environment: RepoEnvironment;
}

export interface RepoActionResult {
  ok: boolean;
  message: string;
  transcript?: CommandTranscript;
  snapshot: DashboardSnapshot;
}

export interface RepoStatusResult {
  ok: boolean;
  status?: RepoStatusSummary;
  transcript?: CommandTranscript;
}

export type WindowStateListener = (isMaximized: boolean) => void;

export interface UpdateSettingsInput {
  windowsRoots?: string[];
  wslRoots?: WslScanRoot[];
  ignorePatterns?: string[];
  ignoredRepos?: string[];
  editorCommandWindows?: string;
  editorCommandWsl?: string;
  refreshIntervalSeconds?: number;
  fetchOnRefresh?: boolean;
}

export interface KachinaApi {
  getSnapshot: () => Promise<DashboardSnapshot>;
  refreshAll: () => Promise<DashboardSnapshot>;
  scanConfiguredRoots: () => Promise<DashboardSnapshot>;
  addRepo: (input: AddRepoInput) => Promise<DashboardSnapshot>;
  removeRepo: (repoId: string) => Promise<DashboardSnapshot>;
  updateSettings: (input: UpdateSettingsInput) => Promise<DashboardSnapshot>;
  stageFile: (repoId: string, filePath: string) => Promise<RepoActionResult>;
  unstageFile: (repoId: string, filePath: string) => Promise<RepoActionResult>;
  commitRepo: (repoId: string, message: string) => Promise<RepoActionResult>;
  pushRepo: (repoId: string) => Promise<RepoActionResult>;
  syncRepo: (repoId: string) => Promise<RepoActionResult>;
  openInEditor: (repoId: string) => Promise<RepoActionResult>;
  openInFileManager: (repoId: string) => Promise<RepoActionResult>;
  openInTerminal: (repoId: string) => Promise<RepoActionResult>;
  cancelRepoOperation: (repoId: string) => Promise<DashboardSnapshot>;
  windowMinimize: () => Promise<void>;
  windowToggleMaximize: () => Promise<boolean>;
  windowClose: () => Promise<void>;
  isWindowMaximized: () => Promise<boolean>;
  onWindowStateChanged: (listener: WindowStateListener) => () => void;
}
