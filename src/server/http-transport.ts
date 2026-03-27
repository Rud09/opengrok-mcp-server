/**
 * HTTP Streamable Transport for OpenGrok MCP Server
 *
 * Starts a Node.js HTTP server that serves the MCP protocol over Streamable HTTP transport.
 * Supports multiple simultaneous clients via per-session transport instances.
 * Each connecting client gets an isolated McpServer instance with full tool access.
 *
 * stdio transport is unaffected — this is purely additive.
 */

import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "./logger.js";

export interface HttpTransportOptions {
  port: number;
  host?: string;
}

type TransportHandle = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

/** Factory function that produces a fresh McpServer for each new session. */
export type McpServerFactory = () => McpServer;

/**
 * Start an HTTP server that serves the MCP protocol over Streamable HTTP transport.
 *
 * @param serverFactory - called once per new client session to create a McpServer
 * @param opts - port and optional host
 * @returns promise that resolves once the server is listening, with a `close()` helper
 */
export async function startHttpTransport(
  serverFactory: McpServerFactory,
  opts: HttpTransportOptions
): Promise<{ close: () => void }> {
  const { port, host = "127.0.0.1" } = opts;

  // Active sessions: Mcp-Session-Id → { transport, server }
  const sessions = new Map<string, TransportHandle>();

  const setCorsHeaders = (res: ServerResponse): void => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
  };

  /** Read the full request body as a parsed JSON object. Returns null on failure. */
  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
      });
      req.on("error", () => resolve(null));
    });

  const handlePost = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const body = await readBody(req);

    try {
      let handle: TransportHandle | undefined;

      if (sessionId && sessions.has(sessionId)) {
        handle = sessions.get(sessionId)!;
      } else if (!sessionId && isInitializeRequest(body)) {
        // New client — create a fresh server + transport for this session.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server });
            logger.info(`HTTP session initialized: ${sid}`);
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            sessions.delete(sid);
            logger.info(`HTTP session closed: ${sid}`);
          }
        };

        const server = serverFactory();
        await server.connect(transport);

        handle = { transport, server };
        // Note: session map entry is set by onsessioninitialized above
        await transport.handleRequest(req, res, body);
        return;
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: No valid session ID provided" },
            id: null,
          })
        );
        return;
      }

      await handle.transport.handleRequest(req, res, body);
    } catch (err) {
      logger.error("HTTP POST handler error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          })
        );
      }
    }
  };

  const handleGet = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400).end("Invalid or missing session ID");
      return;
    }
    try {
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
    } catch (err) {
      logger.error("HTTP GET (SSE) handler error:", err);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
  };

  const handleDelete = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.writeHead(400).end("Invalid or missing session ID");
      return;
    }
    try {
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
    } catch (err) {
      logger.error("HTTP DELETE handler error:", err);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
  };

  const httpServer = createHttpServer((req, res) => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = req.url?.split("?")[0];
    if (url !== "/mcp") {
      res.writeHead(404).end("Not Found");
      return;
    }

    if (req.method === "POST") {
      void handlePost(req, res);
    } else if (req.method === "GET") {
      void handleGet(req, res);
    } else if (req.method === "DELETE") {
      void handleDelete(req, res);
    } else {
      res.writeHead(405).end("Method Not Allowed");
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.listen(port, host, () => {
      logger.info(`HTTP transport listening on http://${host}:${port}/mcp`);
      resolve({
        close: () => {
          // Close all active sessions before shutting down
          for (const [, handle] of sessions) {
            void handle.transport.close().catch(() => undefined);
          }
          sessions.clear();
          httpServer.close();
        },
      });
    });
    httpServer.once("error", reject);
  });
}
