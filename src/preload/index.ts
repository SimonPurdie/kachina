import { contextBridge, ipcRenderer } from "electron";
import type { KachinaApi } from "../shared/types";

const api: KachinaApi = {
  getSnapshot: () => ipcRenderer.invoke("kachina:getSnapshot"),
  refreshAll: () => ipcRenderer.invoke("kachina:refreshAll"),
  scanConfiguredRoots: () => ipcRenderer.invoke("kachina:scanConfiguredRoots"),
  addRepo: (input) => ipcRenderer.invoke("kachina:addRepo", input),
  removeRepo: (repoId) => ipcRenderer.invoke("kachina:removeRepo", repoId),
  updateSettings: (input) => ipcRenderer.invoke("kachina:updateSettings", input),
  stageFile: (repoId, filePath) =>
    ipcRenderer.invoke("kachina:stageFile", repoId, filePath),
  unstageFile: (repoId, filePath) =>
    ipcRenderer.invoke("kachina:unstageFile", repoId, filePath),
  commitRepo: (repoId, message) => ipcRenderer.invoke("kachina:commitRepo", repoId, message),
  pushRepo: (repoId) => ipcRenderer.invoke("kachina:pushRepo", repoId),
  openInEditor: (repoId) => ipcRenderer.invoke("kachina:openInEditor", repoId),
  openInFileManager: (repoId) => ipcRenderer.invoke("kachina:openInFileManager", repoId),
  openInTerminal: (repoId) => ipcRenderer.invoke("kachina:openInTerminal", repoId),
  cancelRepoOperation: (repoId) =>
    ipcRenderer.invoke("kachina:cancelRepoOperation", repoId)
};

contextBridge.exposeInMainWorld("kachinaApi", api);
