import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

interface LockMetadata {
  pid: number;
  mode: string;
  token: string;
  createdAt: string;
}

export class BackendInstanceLock {
  private released = false;

  private constructor(
    private readonly filePath: string,
    private readonly metadata: LockMetadata
  ) {}

  static async acquire(filePath: string, mode: string): Promise<BackendInstanceLock> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    let invalidReadCount = 0;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const metadata: LockMetadata = {
        pid: process.pid,
        mode,
        token: randomUUID(),
        createdAt: new Date().toISOString()
      };

      try {
        const descriptor = openSync(filePath, "wx", 0o600);
        try {
          writeFileSync(descriptor, `${JSON.stringify(metadata)}\n`, "utf8");
        } finally {
          closeSync(descriptor);
        }
        return new BackendInstanceLock(filePath, metadata);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }

      const existing = await readLock(filePath);
      if (!existing) {
        invalidReadCount += 1;
        if (invalidReadCount >= 3) {
          await removeLock(filePath);
          invalidReadCount = 0;
        }
        await delay(75);
        continue;
      }
      invalidReadCount = 0;
      if (isProcessAlive(existing.pid)) {
        throw new Error(
          `Kachina's ${existing.mode} backend is already running (process ${existing.pid}).`
        );
      }

      await removeLock(filePath);
    }

    throw new Error("Kachina could not acquire its backend lock.");
  }

  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;

    try {
      const existing = parseLock(readFileSync(this.filePath, "utf8"));
      if (existing?.token === this.metadata.token) {
        unlinkSync(this.filePath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`Could not release Kachina backend lock: ${(error as Error).message}`);
      }
    }
  }
}

async function removeLock(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function readLock(filePath: string): Promise<LockMetadata | null> {
  try {
    return parseLock(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function parseLock(raw: string): LockMetadata | null {
  try {
    const value = JSON.parse(raw) as Partial<LockMetadata>;
    if (
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.mode !== "string" ||
      typeof value.token !== "string" ||
      typeof value.createdAt !== "string"
    ) {
      return null;
    }
    return value as LockMetadata;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
