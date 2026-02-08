import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DashboardSettings, RepoRecord } from "../shared/types";

export interface PersistedState {
  settings: DashboardSettings;
  repos: RepoRecord[];
}

export const defaultSettings: DashboardSettings = {
  windowsRoots: [],
  wslRoots: [],
  ignorePatterns: ["node_modules", "dist", "build", ".venv", ".idea"],
  editorCommandWindows: "code <path>",
  editorCommandWsl: "code <path>",
  refreshIntervalSeconds: 180,
  fetchOnRefresh: true
};

export class JsonStateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<PersistedState> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      return {
        settings: {
          ...defaultSettings,
          ...parsed.settings,
          windowsRoots: parsed.settings?.windowsRoots ?? [],
          wslRoots: parsed.settings?.wslRoots ?? [],
          ignorePatterns: parsed.settings?.ignorePatterns ?? defaultSettings.ignorePatterns
        },
        repos: Array.isArray(parsed.repos) ? parsed.repos : []
      };
    } catch {
      return {
        settings: { ...defaultSettings },
        repos: []
      };
    }
  }

  async save(state: PersistedState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }
}
