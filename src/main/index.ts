import * as path from "node:path";
import { app, BrowserWindow } from "electron";
import { JsonStateStore } from "./storage";
import { RepoService } from "./repo-service";
import { registerIpcHandlers } from "./ipc";

let mainWindow: BrowserWindow | null = null;
let service: RepoService | null = null;

async function createMainWindow(): Promise<void> {
  const preloadPath = path.join(__dirname, "../preload/index.js");
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#f7f4ec",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    const rendererPath = path.join(__dirname, "../../dist/index.html");
    await mainWindow.loadFile(rendererPath);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function bootstrap(): Promise<void> {
  const store = new JsonStateStore(path.join(app.getPath("userData"), "kachina-state.json"));
  service = new RepoService(store);
  await service.initialize();
  registerIpcHandlers(service);
  service.startAutoRefresh();
  await createMainWindow();
  void service.refreshAll();
}

app.whenReady().then(() => {
  void bootstrap();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  service?.dispose();
});
