import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const webEntry = path.join(projectDirectory, "dist-electron", "web", "index.js");
const rendererEntry = path.join(projectDirectory, "dist", "index.html");

if (buildIsMissingOrStale()) {
  console.log("Kachina build output is missing or stale; building it now...");
  const buildCommand =
    process.platform === "win32"
      ? {
          executable: process.env.ComSpec ?? "cmd.exe",
          args: ["/d", "/s", "/c", "npm.cmd run build"]
        }
      : {
          executable: "npm",
          args: ["run", "build"]
        };
  const result = spawnSync(buildCommand.executable, buildCommand.args, {
    cwd: projectDirectory,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const child = spawn(process.execPath, [webEntry], {
  cwd: projectDirectory,
  env: process.env,
  stdio: "inherit"
});

let forwardingSignal = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  if (signal === "SIGBREAK" && process.platform !== "win32") {
    continue;
  }
  process.on(signal, () => {
    if (forwardingSignal) {
      return;
    }
    forwardingSignal = true;
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.once("error", (error) => {
  console.error(`Could not start Kachina: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

function buildIsMissingOrStale() {
  if (!existsSync(webEntry) || !existsSync(rendererEntry)) {
    return true;
  }

  const oldestOutput = Math.min(
    statSync(webEntry).mtimeMs,
    statSync(rendererEntry).mtimeMs
  );
  const inputs = [
    path.join(projectDirectory, "src"),
    path.join(projectDirectory, "index.html"),
    path.join(projectDirectory, "package.json"),
    path.join(projectDirectory, "package-lock.json"),
    path.join(projectDirectory, "tsconfig.main.json"),
    path.join(projectDirectory, "tsconfig.renderer.json"),
    path.join(projectDirectory, "vite.config.ts")
  ];

  return inputs.some((input) => newestModification(input) > oldestOutput);
}

function newestModification(target) {
  const stats = statSync(target);
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }

  let newest = stats.mtimeMs;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const entryPath = path.join(target, entry.name);
    newest = Math.max(newest, newestModification(entryPath));
  }
  return newest;
}
