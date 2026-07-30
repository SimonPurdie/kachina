import * as path from "node:path";
import { JsonStateStore } from "../main/storage";
import { RepoService } from "../main/repo-service";
import { WindowsDesktopLauncher } from "../main/desktop-launcher";
import { BackendInstanceLock } from "../main/instance-lock";
import {
  backendLockPath,
  resolveWebStateFilePath
} from "../main/app-paths";
import { createKachinaWebServer } from "./server";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 47831;

let shuttingDown = false;

void bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function bootstrap(): Promise<void> {
  const port = resolvePort();
  const stateFilePath = resolveWebStateFilePath();
  const lock = await BackendInstanceLock.acquire(
    backendLockPath(stateFilePath),
    "browser"
  );
  const service = new RepoService(
    new JsonStateStore(stateFilePath),
    new WindowsDesktopLauncher()
  );

  try {
    await service.initialize();
    service.startAutoRefresh();

    const webServer = createKachinaWebServer(service, {
      host: HOST,
      port,
      staticDirectory: path.join(__dirname, "../../dist"),
      requestShutdown: shutdown
    });
    const { server } = webServer;

    function shutdown(): void {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      webServer.announceShutdown();
      service.dispose();
      server.close(() => {
        lock.release();
        process.exit(0);
      });
      setTimeout(() => {
        lock.release();
        process.exit(1);
      }, 10_000).unref();
    }

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    if (process.platform === "win32") {
      process.on("SIGBREAK", shutdown);
    }
    process.on("exit", () => lock.release());

    console.log(`Kachina is ready at http://${HOST}:${port}`);
    if (process.env.KACHINA_SKIP_INITIAL_REFRESH !== "1") {
      void service.refreshAll();
    }
  } catch (error) {
    service.dispose();
    lock.release();
    throw error;
  }
}

function resolvePort(): number {
  const raw = process.env.KACHINA_WEB_PORT?.trim();
  if (!raw) {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error("KACHINA_WEB_PORT must be an integer between 1024 and 65535.");
  }
  return port;
}
