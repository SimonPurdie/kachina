import { ipcMain } from "electron";
import type { AddRepoInput, UpdateSettingsInput } from "../shared/types";
import { RepoService } from "./repo-service";

export function registerIpcHandlers(service: RepoService): void {
  ipcMain.handle("kachina:getSnapshot", async () => service.getSnapshot());
  ipcMain.handle("kachina:refreshAll", async () => service.refreshAll());
  ipcMain.handle("kachina:scanConfiguredRoots", async () => service.scanConfiguredRoots());
  ipcMain.handle("kachina:addRepo", async (_event, input: AddRepoInput) =>
    service.addRepo(input)
  );
  ipcMain.handle("kachina:removeRepo", async (_event, repoId: string) =>
    service.removeRepo(repoId)
  );
  ipcMain.handle("kachina:setTags", async (_event, repoId: string, tags: string[]) =>
    service.setTags(repoId, tags)
  );
  ipcMain.handle("kachina:updateSettings", async (_event, input: UpdateSettingsInput) =>
    service.updateSettings(input)
  );
  ipcMain.handle("kachina:stageFile", async (_event, repoId: string, filePath: string) =>
    service.stageFile(repoId, filePath)
  );
  ipcMain.handle("kachina:unstageFile", async (_event, repoId: string, filePath: string) =>
    service.unstageFile(repoId, filePath)
  );
  ipcMain.handle("kachina:commitRepo", async (_event, repoId: string, message: string) =>
    service.commitRepo(repoId, message)
  );
  ipcMain.handle("kachina:pushRepo", async (_event, repoId: string) => service.pushRepo(repoId));
  ipcMain.handle("kachina:openInEditor", async (_event, repoId: string) =>
    service.openInEditor(repoId)
  );
  ipcMain.handle("kachina:openInFileManager", async (_event, repoId: string) =>
    service.openInFileManager(repoId)
  );
  ipcMain.handle("kachina:openInTerminal", async (_event, repoId: string) =>
    service.openInTerminal(repoId)
  );
  ipcMain.handle("kachina:cancelRepoOperation", async (_event, repoId: string) =>
    service.cancelRepoOperation(repoId)
  );
}
