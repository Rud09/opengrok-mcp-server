import { Worker } from "worker_threads";
import * as fs from "fs";
import * as path from "path";

// Use __dirname via CommonJS (sandbox.ts uses the same approach)
declare const __dirname: string;

export interface WorkerHandle {
  worker: Worker;
  terminate(): Promise<void>;
}

/**
 * Pre-warmed pool of sandbox workers (QuickJS WASM).
 *
 * Maintains up to `maxIdle` idle worker threads so that consecutive
 * `opengrok_execute` calls avoid the ~50ms Worker spawn + WASM load cost.
 * Workers that stay idle beyond `idleTimeoutMs` are terminated automatically.
 */
export class SandboxWorkerPool {
  private idle: WorkerHandle[] = [];
  private readonly maxIdle = 2;
  private readonly idleTimeoutMs = 30_000;
  private idleTimers = new Map<WorkerHandle, ReturnType<typeof setTimeout>>();

  async acquire(): Promise<WorkerHandle> {
    const handle = this.idle.pop();
    if (handle) {
      const timer = this.idleTimers.get(handle);
      if (timer) clearTimeout(timer);
      this.idleTimers.delete(handle);
      return handle;
    }
    return this.spawnWorker();
  }

  release(handle: WorkerHandle): void {
    if (this.idle.length < this.maxIdle) {
      this.idle.push(handle);
      const timer = setTimeout(() => {
        const idx = this.idle.indexOf(handle);
        if (idx >= 0) {
          this.idle.splice(idx, 1);
          this.idleTimers.delete(handle);
          void handle.terminate();
        }
      }, this.idleTimeoutMs);
      this.idleTimers.set(handle, timer);
    } else {
      void handle.terminate();
    }
  }

  async drain(): Promise<void> {
    for (const [handle, timer] of this.idleTimers) {
      clearTimeout(timer);
      await handle.terminate();
    }
    this.idle = [];
    this.idleTimers.clear();
  }

  private spawnWorker(): WorkerHandle {
    // Match the path resolution used by sandbox.ts
    const localWorkerPath = path.join(__dirname, "sandbox-worker.js");
    const devWorkerPath = path.join(__dirname, "..", "..", "out", "server", "sandbox-worker.js");
    const workerPath = fs.existsSync(localWorkerPath) ? localWorkerPath : devWorkerPath;
    const worker = new Worker(workerPath);
    const handle: WorkerHandle = {
      worker,
      terminate: () => worker.terminate().then(() => undefined),
    };
    return handle;
  }
}
