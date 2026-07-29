import { shell } from "electron";
import type { DesktopLauncher } from "./desktop-launcher";

export class ElectronDesktopLauncher implements DesktopLauncher {
  async openExternal(url: string): Promise<void> {
    await shell.openExternal(url);
  }

  async openPath(target: string): Promise<string> {
    return await shell.openPath(target);
  }
}
