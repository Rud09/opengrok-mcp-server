/**
 * Unit tests for SandboxWorkerPool.
 * worker_threads is fully mocked — no real Workers are spawned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("worker_threads", () => ({
  Worker: vi.fn().mockImplementation(() => ({
    terminate: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    postMessage: vi.fn(),
  })),
}));

// Import AFTER mock is registered
import { SandboxWorkerPool } from "../server/worker-pool.js";
import { Worker } from "worker_threads";

const MockWorker = Worker as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  MockWorker.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SandboxWorkerPool", () => {
  it("1. acquire() spawns a new worker when the pool is empty", async () => {
    const pool = new SandboxWorkerPool();
    const handle = await pool.acquire();

    expect(MockWorker).toHaveBeenCalledTimes(1);
    expect(handle.worker).toBeDefined();
    expect(typeof handle.terminate).toBe("function");

    await pool.drain();
  });

  it("2. release() keeps a worker in the pool when below maxIdle", async () => {
    const pool = new SandboxWorkerPool();
    const handle = await pool.acquire();
    pool.release(handle);

    // Acquiring again should NOT spawn a new worker
    const handle2 = await pool.acquire();
    expect(MockWorker).toHaveBeenCalledTimes(1); // only the first spawn
    expect(handle2).toBe(handle);

    await pool.drain();
  });

  it("3. release() terminates worker when pool is at maxIdle", async () => {
    const pool = new SandboxWorkerPool();

    // Fill pool to capacity (maxIdle = 2)
    const h1 = await pool.acquire();
    const h2 = await pool.acquire();
    pool.release(h1);
    pool.release(h2);

    // Third worker should be immediately terminated when released
    const h3 = await pool.acquire(); // spawns fresh (pool had 2 from h1/h2 reuse)
    // Re-acquire two more to fill pool
    const h4 = await pool.acquire();
    const h5 = await pool.acquire(); // this spawns fresh
    pool.release(h4); // pool is now full (h1/h2 were re-acquired, h4 goes back)

    // h5 should be terminated since pool is at capacity (h3 and h4 are in pool)
    const terminateSpy = vi.spyOn(h5, "terminate");
    pool.release(h5);

    expect(terminateSpy).toHaveBeenCalled();

    await pool.drain();
  });

  it("4. acquire() returns the pooled worker on second call (no new spawn)", async () => {
    const pool = new SandboxWorkerPool();

    const first = await pool.acquire();
    pool.release(first);

    const second = await pool.acquire();
    expect(second).toBe(first);
    expect(MockWorker).toHaveBeenCalledTimes(1);

    await pool.drain();
  });

  it("5. idle worker is terminated after 30s idle timeout", async () => {
    const pool = new SandboxWorkerPool();
    const handle = await pool.acquire();
    const terminateSpy = vi.spyOn(handle, "terminate");

    pool.release(handle);
    expect(terminateSpy).not.toHaveBeenCalled();

    // Fast-forward past idle timeout
    vi.advanceTimersByTime(30_001);

    expect(terminateSpy).toHaveBeenCalled();

    await pool.drain();
  });

  it("6. drain() terminates all idle workers and clears the pool", async () => {
    const pool = new SandboxWorkerPool();

    const h1 = await pool.acquire();
    const h2 = await pool.acquire();
    const t1 = vi.spyOn(h1, "terminate");
    const t2 = vi.spyOn(h2, "terminate");
    pool.release(h1);
    pool.release(h2);

    await pool.drain();

    expect(t1).toHaveBeenCalled();
    expect(t2).toHaveBeenCalled();

    // Pool should be empty — next acquire spawns fresh
    MockWorker.mockClear();
    const h3 = await pool.acquire();
    expect(MockWorker).toHaveBeenCalledTimes(1);
    await h3.terminate();
  });
});
