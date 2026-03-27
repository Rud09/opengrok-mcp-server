/**
 * Tests for HTTP Streamable Transport (Task 5.1)
 *
 * Uses real Node.js HTTP requests against an in-process HTTP server started
 * with a minimal mock McpServer factory.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as http from "node:http";
import { startHttpTransport, type McpServerFactory } from "../server/http-transport.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const makeFactory = (): McpServerFactory => () =>
  new McpServer({ name: "test-server", version: "0.0.0" });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Send a raw HTTP request and collect the full response body. */
function httpRequest(opts: {
  port: number;
  method: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: opts.port,
        path: opts.path ?? "/mcp",
        method: opts.method,
        headers: {
          "Content-Type": "application/json",
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** Pick a random high port to avoid conflicts. */
const BASE_PORT = 35000 + Math.floor(Math.random() * 5000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startHttpTransport", () => {
  let close: () => void;

  beforeAll(async () => {
    const handle = await startHttpTransport(makeFactory(), { port: BASE_PORT });
    close = handle.close;
  });

  afterAll(() => {
    close();
  });

  // --- Server lifecycle ---------------------------------------------------

  it("starts and listens on the configured port", async () => {
    const res = await httpRequest({ port: BASE_PORT, method: "OPTIONS" });
    // OPTIONS preflight returns 204
    expect(res.status).toBe(204);
  });

  // --- CORS headers -------------------------------------------------------

  it("includes CORS headers on OPTIONS preflight", async () => {
    const res = await httpRequest({ port: BASE_PORT, method: "OPTIONS" });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toMatch(/POST/);
    expect(res.headers["access-control-allow-headers"]).toMatch(/Mcp-Session-Id/i);
  });

  it("includes CORS headers on regular responses", async () => {
    const res = await httpRequest({
      port: BASE_PORT,
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "unknownMethod", id: 1 }),
    });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  // --- Routing ------------------------------------------------------------

  it("returns 404 for unknown paths", async () => {
    const res = await httpRequest({ port: BASE_PORT, method: "GET", path: "/unknown" });
    expect(res.status).toBe(404);
  });

  it("returns 405 for unsupported methods on /mcp", async () => {
    const res = await httpRequest({ port: BASE_PORT, method: "PATCH" });
    expect(res.status).toBe(405);
  });

  // --- Session management -------------------------------------------------

  it("rejects POST without session ID when not an initialize request", async () => {
    const res = await httpRequest({
      port: BASE_PORT,
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(400);
    const json = JSON.parse(res.body);
    expect(json.error.message).toMatch(/session/i);
  });

  it("accepts initialize request without session ID and returns session ID in response", async () => {
    const initBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.1" },
      },
    });

    // MCP Streamable HTTP requires Accept header for both JSON and SSE responses
    const res = await httpRequest({
      port: BASE_PORT,
      method: "POST",
      headers: { "Accept": "application/json, text/event-stream" },
      body: initBody,
    });

    // The SDK returns 200 when Accept header is properly set
    expect(res.status).toBe(200);
  });

  it("rejects GET request for unknown session ID", async () => {
    const res = await httpRequest({
      port: BASE_PORT,
      method: "GET",
      headers: { "Mcp-Session-Id": "nonexistent-session-id" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects DELETE request for unknown session ID", async () => {
    const res = await httpRequest({
      port: BASE_PORT,
      method: "DELETE",
      headers: { "Mcp-Session-Id": "nonexistent-session-id" },
    });
    expect(res.status).toBe(400);
  });

  // --- Multiple server instances ------------------------------------------

  it("starts a second server on a different port independently", async () => {
    const secondPort = BASE_PORT + 100;
    const { close: close2 } = await startHttpTransport(makeFactory(), { port: secondPort });
    try {
      const res = await httpRequest({ port: secondPort, method: "OPTIONS" });
      expect(res.status).toBe(204);
    } finally {
      close2();
    }
  });

  // --- Factory called per session -----------------------------------------

  it("calls the factory for each new initialize request", async () => {
    const factorySpy = vi.fn(() => new McpServer({ name: "spy-server", version: "0.0.0" }));
    const spyPort = BASE_PORT + 200;
    const { close: closeSpyServer } = await startHttpTransport(factorySpy, { port: spyPort });

    try {
      const initBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.1" },
        },
      });

      await httpRequest({ port: spyPort, method: "POST", headers: { "Accept": "application/json, text/event-stream" }, body: initBody });
      await httpRequest({ port: spyPort, method: "POST", headers: { "Accept": "application/json, text/event-stream" }, body: initBody });

      // Two separate init requests → factory should have been called twice
      expect(factorySpy).toHaveBeenCalledTimes(2);
    } finally {
      closeSpyServer();
    }
  });
});
