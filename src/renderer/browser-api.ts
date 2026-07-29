import type { KachinaApi } from "../shared/types";

interface ApiErrorResponse {
  error?: string;
}

async function invoke<T>(method: keyof KachinaApi, args: unknown[] = []): Promise<T> {
  const response = await fetch("/api/invoke", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ method, args })
  });

  if (!response.ok) {
    let message = `Kachina request failed with status ${response.status}.`;
    try {
      const body = (await response.json()) as ApiErrorResponse;
      if (body.error) {
        message = body.error;
      }
    } catch {
      // Preserve the status-based message when the response is not JSON.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export const browserApi: KachinaApi = {
  getSnapshot: () => invoke("getSnapshot"),
  refreshAll: () => invoke("refreshAll"),
  scanConfiguredRoots: () => invoke("scanConfiguredRoots"),
  addRepo: (input) => invoke("addRepo", [input]),
  removeRepo: (repoId) => invoke("removeRepo", [repoId]),
  updateSettings: (input) => invoke("updateSettings", [input]),
  stageFile: (repoId, filePath) => invoke("stageFile", [repoId, filePath]),
  unstageFile: (repoId, filePath) => invoke("unstageFile", [repoId, filePath]),
  commitRepo: (repoId, message) => invoke("commitRepo", [repoId, message]),
  pushRepo: (repoId) => invoke("pushRepo", [repoId]),
  syncRepo: (repoId) => invoke("syncRepo", [repoId]),
  openInEditor: (repoId) => invoke("openInEditor", [repoId]),
  openInFileManager: (repoId) => invoke("openInFileManager", [repoId]),
  openInTerminal: (repoId) => invoke("openInTerminal", [repoId]),
  cancelRepoOperation: (repoId) => invoke("cancelRepoOperation", [repoId])
};

export function getKachinaApi(): KachinaApi {
  return window.kachinaApi ?? browserApi;
}
