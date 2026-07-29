import * as os from "node:os";
import * as path from "node:path";

const APP_DIRECTORY_NAME = "Kachina";
const STATE_FILE_NAME = "kachina-state.json";

export function resolveWebStateFilePath(): string {
  const override = process.env.KACHINA_STATE_PATH?.trim();
  if (override) {
    return path.resolve(override);
  }

  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA?.trim() ||
      path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, APP_DIRECTORY_NAME, STATE_FILE_NAME);
  }

  const configRoot =
    process.env.XDG_CONFIG_HOME?.trim() ||
    path.join(os.homedir(), ".config");
  return path.join(configRoot, APP_DIRECTORY_NAME, STATE_FILE_NAME);
}

export function backendLockPath(stateFilePath: string): string {
  return path.join(path.dirname(stateFilePath), "kachina-backend.lock");
}
