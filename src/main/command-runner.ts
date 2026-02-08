import { spawn } from "node:child_process";
import type { CommandTranscript, RepoEnvironment } from "../shared/types";

export interface RunCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  environment?: RepoEnvironment;
}

export class CommandFailedError extends Error {
  constructor(
    message: string,
    public readonly transcript: CommandTranscript
  ) {
    super(message);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatInvocation(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<CommandTranscript> {
  const startedAt = nowIso();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never"
  };

  return await new Promise<CommandTranscript>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finished = false;

    const onAbort = (): void => {
      if (finished) {
        return;
      }
      child.kill("SIGTERM");
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);

    options.signal?.addEventListener("abort", onAbort);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const transcript: CommandTranscript = {
        command: formatInvocation(command, args),
        exitCode: null,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        startedAt,
        finishedAt: nowIso(),
        timedOut
      };
      reject(new CommandFailedError(error.message, transcript));
    });

    child.on("close", (exitCode) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const transcript: CommandTranscript = {
        command: formatInvocation(command, args),
        exitCode,
        stdout,
        stderr,
        startedAt,
        finishedAt: nowIso(),
        timedOut
      };
      if (exitCode === 0 && !timedOut) {
        resolve(transcript);
        return;
      }
      reject(new CommandFailedError("Command failed", transcript));
    });
  });
}

export async function runGitCommand(
  environment: RepoEnvironment,
  repoPath: string,
  gitArgs: string[],
  options: Omit<RunCommandOptions, "cwd" | "environment"> = {}
): Promise<CommandTranscript> {
  if (environment.kind === "windows") {
    return await runCommand("git", gitArgs, {
      ...options,
      cwd: repoPath
    });
  }

  const script = `cd ${shellEscape(repoPath)} && GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=Never git ${gitArgs
    .map(shellEscape)
    .join(" ")}`;
  return await runCommand(
    "wsl.exe",
    ["-d", environment.distro, "--", "bash", "-lc", script],
    options
  );
}

export async function runWslScript(
  distro: string,
  script: string,
  options: Omit<RunCommandOptions, "cwd" | "environment"> = {}
): Promise<CommandTranscript> {
  return await runCommand(
    "wsl.exe",
    ["-d", distro, "--", "bash", "-lc", script],
    options
  );
}
