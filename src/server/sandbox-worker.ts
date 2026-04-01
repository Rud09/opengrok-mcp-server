/**
 * Sandbox worker — runs inside a worker_threads.Worker.
 * Loads QuickJS WASM VM and executes LLM-written JavaScript in isolation.
 *
 * Communication with the main thread uses two channels:
 *   - SharedArrayBuffer + Atomics: synchronous bridge for mid-execution API calls
 *   - parentPort.postMessage: final result (or error) after code completes
 *
 * Buffer layout (must exactly match sandbox.ts):
 *   Bytes 0–15:  Int32Array  statusArray  — [0]: 0=idle, 1=pending_call, 2=result_ready
 *   Bytes 16–19: Uint32Array lengthArray  — [0]: byte count of JSON payload in dataArray
 *   Bytes 20+:   Uint8Array  dataArray    — JSON payload (max 1 MB)
 *   TOTAL: SHARED_BUFFER_SIZE = 20 + 1024 * 1024
 *
 * Design decisions:
 *   - Wrapped in IIFE (no top-level await — CJS compatibility, issue #2)
 *   - callHostSync() uses Atomics.wait() to block the worker thread while the
 *     main thread processes the async API call (issue #3, #7)
 *   - LLM code uses `return value`; IIFE wrapper captures it (issue #4)
 *   - No Atomics.notify after store(1) — main thread polls, nobody listens (issue #11)
 *   - 9s executionTimeout covers infinite loops; main thread hardTimeout covers the rest
 */

import { workerData, parentPort } from "worker_threads";
import { loadQuickJs, type SandboxOptions } from "@sebastianwessel/quickjs";
import variant from "@jitl/quickjs-ng-wasmfile-release-sync";
import { STATUS_OFFSET, LENGTH_OFFSET, DATA_OFFSET } from "./sandbox-protocol.js";

// ---------------------------------------------------------------------------
// Buffer layout imported from sandbox-protocol.ts (shared with sandbox.ts)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// runJob — execute one unit of LLM code inside QuickJS with the given buffer
// ---------------------------------------------------------------------------

type RunSandboxed = Awaited<ReturnType<typeof loadQuickJs>>["runSandboxed"];

async function runJob(
  runSandboxed: RunSandboxed,
  sharedBuffer: SharedArrayBuffer,
  code: string
): Promise<void> {
  // Typed views into the shared buffer (layout pinned — must match sandbox.ts)
  const statusArray = new Int32Array(sharedBuffer, STATUS_OFFSET, 4);
  const lengthArray = new Uint32Array(sharedBuffer, LENGTH_OFFSET, 1);
  const dataArray   = new Uint8Array(sharedBuffer, DATA_OFFSET);

  // ---------------------------------------------------------------------------
  // callHostSync — synchronous bridge to main thread async API
  // ---------------------------------------------------------------------------

  /**
   * Encode a host API call request into the shared buffer, block this worker
   * thread until the main thread writes the result, then return it.
   *
   * The main thread is polling via setImmediate and will process the call
   * asynchronously while this thread is blocked in Atomics.wait().
   */
  function callHostSync(methodName: string, args: unknown[]): unknown {
    const payload = JSON.stringify({ method: methodName, args });
    const encoded = Buffer.from(payload, "utf8");

    if (encoded.length > dataArray.length) {
      throw new Error(`callHostSync payload too large: ${encoded.length} bytes (max ${dataArray.length})`);
    }

    // Write call payload into the buffer
    lengthArray[0] = encoded.length;
    dataArray.set(encoded, 0);

    // Signal: pending_call (main thread polls for this)
    Atomics.store(statusArray, 0, 1);
    // No Atomics.notify here — main thread polls via setImmediate, not Atomics.wait

    // Block until main thread writes result (sets status to 2) and notifies
    const waitResult = Atomics.wait(statusArray, 0, 1);
    if (waitResult !== "ok") {
      // "not-equal": status was already != 1 when we called wait (result arrived before we blocked).
      // "timed-out": sandbox execution timeout — this should not happen (no timeout param here).
      // In both cases the buffer contents are indeterminate; throw to surface the problem.
      throw new Error(`callHostSync: unexpected Atomics.wait result "${waitResult}" for method "${methodName}"`);
    }

    // Read response
    const resLen = lengthArray[0];
    const resBytes = dataArray.subarray(0, resLen);
    const resJson = Buffer.from(resBytes).toString("utf8");
    let res: Record<string, unknown>;
    try {
      res = JSON.parse(resJson) as Record<string, unknown>;
    } catch {
      throw new Error(`callHostSync: malformed response from main thread (first 100 chars: ${resJson.slice(0, 100)})`);
    }

    if ("__error" in res) throw new Error(res["__error"] as string);
    return res["data"];
  }

  // ---------------------------------------------------------------------------
  // env.opengrok — 16 methods, all wired through callHostSync
  // ---------------------------------------------------------------------------

  const makeMethod = (name: string) =>
    (...args: unknown[]) => callHostSync(name, args);

  const env = {
    opengrok: {
      search:           makeMethod("search"),
      batchSearch:      makeMethod("batchSearch"),
      getFileContent:   makeMethod("getFileContent"),
      getSymbolContext: makeMethod("getSymbolContext"),
      getFileSymbols:   makeMethod("getFileSymbols"),
      getFileHistory:   makeMethod("getFileHistory"),
      getFileAnnotate:  makeMethod("getFileAnnotate"),
      browseDir:        makeMethod("browseDir"),
      findFile:         makeMethod("findFile"),
      getFileOverview:  makeMethod("getFileOverview"),
      traceCallChain:   makeMethod("traceCallChain"),
      searchSuggest:    makeMethod("searchSuggest"),
      getCompileInfo:   makeMethod("getCompileInfo"),
      indexHealth:      makeMethod("indexHealth"),
      readMemory:       makeMethod("readMemory"),
      writeMemory:      makeMethod("writeMemory"),
      getFileDiff:      makeMethod("getFileDiff"),
      elicit:           makeMethod("elicit"),
      sample:           makeMethod("sample"),
    },
  };

  // ---------------------------------------------------------------------------
  // QuickJS sandbox options
  // ---------------------------------------------------------------------------

  const options: SandboxOptions = {
    executionTimeout: 9_000,          // interrupt-based; covers tight loops
    memoryLimit:      128 * 1024 * 1024, // 128 MB
    maxStackSize:     4 * 1024 * 1024,   // 4 MB
    allowFetch:       false,
    allowFs:          false,
    env:              env as Record<string, unknown>,
  };

  // ---------------------------------------------------------------------------
  // Execute
  // ---------------------------------------------------------------------------

  if (!parentPort) throw new Error("parentPort is null — worker must run inside worker_threads");

  try {
    // Wrap LLM code: async IIFE captures `return` (including `return await …`),
    // outer exports via `export default`. Without the async wrapper, code that
    // returns a Promise would export the Promise object rather than its resolved
    // value, causing silent empty results for any LLM-written async code.
    const wrappedCode = `const __result = await (async () => { ${code} })();\nexport default __result;`;

    const result = await runSandboxed(
      async ({ evalCode }) => evalCode(wrappedCode),
      options
    );

    parentPort.postMessage(result);
  } catch (err) {
    const error = err as Error;
    parentPort.postMessage({
      ok: false,
      error: {
        name: error.name ?? "Error",
        message: error.message ?? "Unknown sandbox error",
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Main IIFE — required for CJS compatibility (no top-level await)
// ---------------------------------------------------------------------------

void (async () => {
  if (!parentPort) throw new Error("parentPort is null — worker must run inside worker_threads");

  const data = workerData as { sharedBuffer?: SharedArrayBuffer; code?: string } | null;

  if (data?.code !== undefined) {
    // Immediate mode (existing behavior): workerData supplies sharedBuffer + code
    const { runSandboxed } = await loadQuickJs(variant);
    if (!data.sharedBuffer) throw new Error("sandbox error: sharedBuffer missing");
    await runJob(runSandboxed, data.sharedBuffer, data.code);
    return;
  }

  // Pool mode: preload QuickJS WASM (warm-up), then wait for jobs via postMessage
  const { runSandboxed } = await loadQuickJs(variant);
  parentPort.postMessage({ type: "ready" });

  parentPort.on("message", (msg: { sharedBuffer: SharedArrayBuffer; code: string }) => {
    void runJob(runSandboxed, msg.sharedBuffer, msg.code);
  });
})();
