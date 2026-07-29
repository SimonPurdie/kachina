import { spawn } from "node:child_process";

export interface DesktopLauncher {
  openExternal(url: string): Promise<void>;
  openPath(target: string): Promise<string>;
}

export class WindowsDesktopLauncher implements DesktopLauncher {
  async openExternal(url: string): Promise<void> {
    await launchExplorer(url);
  }

  async openPath(target: string): Promise<string> {
    await launchExplorer(target);
    return "";
  }
}

async function launchExplorer(target: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("explorer.exe", [target], {
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
