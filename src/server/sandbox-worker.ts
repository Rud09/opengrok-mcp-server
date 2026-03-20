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

// ---------------------------------------------------------------------------
// Buffer layout constants (must match sandbox.ts)
// ---------------------------------------------------------------------------

const SHARED_BUFFER_SIZE = 20 + 1024 * 1024;

// ---------------------------------------------------------------------------
// Main IIFE — required for CJS compatibility (no top-level await)
// ---------------------------------------------------------------------------

(async () => {
  const { sharedBuffer, code } = workerData as {
    sharedBuffer: SharedArrayBuffer;
    code: string;
  };

  // Typed views into the shared buffer (layout pinned — must match sandbox.ts)
  const statusArray = new Int32Array(sharedBuffer, 0, 4);  // bytes 0–15
  const lengthArray = new Uint32Array(sharedBuffer, 16, 1); // bytes 16–19
  const dataArray   = new Uint8Array(sharedBuffer, 20);     // bytes 20+

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

    // Write call payload into the buffer
    lengthArray[0] = encoded.length;
    dataArray.set(encoded, 0);

    // Signal: pending_call (main thread polls for this)
    Atomics.store(statusArray, 0, 1);
    // No Atomics.notify here — main thread polls via setImmediate, not Atomics.wait

    // Block until main thread writes result (sets status to 2) and notifies
    Atomics.wait(statusArray, 0, 1);

    // Read response
    const resLen = lengthArray[0];
    const resBytes = dataArray.subarray(0, resLen);
    const resJson = Buffer.from(resBytes).toString("utf8");
    const res = JSON.parse(resJson) as Record<string, unknown>;

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
      search:          makeMethod("search"),
      batchSearch:     makeMethod("batchSearch"),
      getFileContent:  makeMethod("getFileContent"),
      getSymbolContext: makeMethod("getSymbolContext"),
      getFileSymbols:  makeMethod("getFileSymbols"),
      getFileHistory:  makeMethod("getFileHistory"),
      getFileAnnotate: makeMethod("getFileAnnotate"),
      browseDir:       makeMethod("browseDir"),
      findFile:        makeMethod("findFile"),
      getFileOverview: makeMethod("getFileOverview"),
      traceCallChain:  makeMethod("traceCallChain"),
      searchSuggest:   makeMethod("searchSuggest"),
      getCompileInfo:  makeMethod("getCompileInfo"),
      indexHealth:     makeMethod("indexHealth"),
      readMemory:      makeMethod("readMemory"),
      writeMemory:     makeMethod("writeMemory"),
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

  try {
    const { runSandboxed } = await loadQuickJs(variant);

    // Wrap LLM code: inner IIFE captures `return`, outer exports via `export default`
    const wrappedCode = `const __result = (() => { ${code} })();\nexport default __result;`;

    const result = await runSandboxed(
      async ({ evalCode }) => evalCode(wrappedCode),
      options
    );

    parentPort!.postMessage(result);
  } catch (err) {
    const error = err as Error;
    parentPort!.postMessage({
      ok: false,
      error: {
        name: error.name ?? "Error",
        message: error.message ?? "Unknown sandbox error",
      },
    });
  }
})();
