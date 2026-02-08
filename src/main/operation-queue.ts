import { newId } from "./ids";
import type { ActiveOperation } from "../shared/types";

interface QueueTask<T> {
  id: string;
  repoId: string;
  name: string;
  timeoutMs: number;
  run: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

interface QueueCallbacks {
  onStart: (repoId: string, operation: ActiveOperation) => void;
  onFinish: (repoId: string, operationId: string) => void;
}

export class OperationQueue {
  private readonly tasks: QueueTask<unknown>[] = [];
  private active:
    | {
        task: QueueTask<unknown>;
        controller: AbortController;
      }
    | undefined;

  constructor(private readonly callbacks: QueueCallbacks) {}

  enqueue<T>(
    repoId: string,
    name: string,
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs = 30_000
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.tasks.push({
        id: newId("op"),
        repoId,
        name,
        timeoutMs,
        run,
        resolve: resolve as (value: unknown) => void,
        reject
      });
      this.pump();
    });
  }

  cancelRepo(repoId: string): void {
    if (this.active?.task.repoId === repoId) {
      this.active.controller.abort();
    }

    const pending = this.tasks.filter((task) => task.repoId === repoId);
    if (pending.length === 0) {
      return;
    }

    const remaining = this.tasks.filter((task) => task.repoId !== repoId);
    this.tasks.length = 0;
    this.tasks.push(...remaining);
    for (const task of pending) {
      task.reject(new Error("Operation cancelled before execution"));
    }
  }

  private pump(): void {
    if (this.active || this.tasks.length === 0) {
      return;
    }

    const task = this.tasks.shift();
    if (!task) {
      return;
    }

    const controller = new AbortController();
    this.active = { task, controller };
    this.callbacks.onStart(task.repoId, {
      id: task.id,
      name: task.name,
      startedAt: new Date().toISOString()
    });

    const timeout = setTimeout(() => controller.abort(), task.timeoutMs);
    task
      .run(controller.signal)
      .then((value) => task.resolve(value))
      .catch((error) => task.reject(error))
      .finally(() => {
        clearTimeout(timeout);
        this.callbacks.onFinish(task.repoId, task.id);
        this.active = undefined;
        this.pump();
      });
  }
}
