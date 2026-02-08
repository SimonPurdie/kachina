import * as path from "node:path";
import * as fs from "node:fs";
import { app, BrowserWindow, Menu } from "electron";
import { JsonStateStore } from "./storage";
import { RepoService } from "./repo-service";
import { registerIpcHandlers } from "./ipc";

let mainWindow: BrowserWindow | null = null;
let service: RepoService | null = null;

function resolveWindowIcon(): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }

  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "assets", "kachina.ico")]
    : [path.join(process.cwd(), "build", "icons", "kachina.ico")];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function createMainWindow(): Promise<void> {
  const preloadPath = path.join(__dirname, "../preload/index.js");
  const iconPath = resolveWindowIcon();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    titleBarStyle: "hidden",
    autoHideMenuBar: true,
    backgroundColor: "#f7f4ec",
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.setMenuBarVisibility(false);

  const emitWindowState = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.webContents.send("kachina:windowStateChanged", mainWindow.isMaximized());
  };

  mainWindow.on("maximize", emitWindowState);
  mainWindow.on("unmaximize", emitWindowState);

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

  emitWindowState();
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

app.setName("Kachina");
if (process.platform === "win32") {
  app.setAppUserModelId("com.kachina.desktop");
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
