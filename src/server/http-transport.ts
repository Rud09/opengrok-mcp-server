/**
 * HTTP Streamable Transport for OpenGrok MCP Server
 *
 * Starts a Node.js HTTP server that serves the MCP protocol over Streamable HTTP transport.
 * Supports multiple simultaneous clients via per-session transport instances.
 * Each connecting client gets an isolated McpServer instance with full tool access.
 *
 * OAuth 2.1 Bearer token auth, token endpoint, and discovery endpoint are also served here.
 *
 * stdio transport is unaffected — this is purely additive.
 */

import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "./logger.js";
import { parseRbacConfig, hasPermission, type Role } from "./rbac.js";

export interface HttpTransportOptions {
  port: number;
  host?: string;
  /** If set, all /mcp requests must carry `Authorization: Bearer <authToken>`. */
  authToken?: string;
  /** OAuth 2.1 client_credentials client ID (enables /token endpoint). */
  clientId?: string;
  /** OAuth 2.1 client_credentials client secret. */
  clientSecret?: string;
  /** Maximum concurrent sessions before new connections are rejected with 503. Default: 100 */
  maxSessions?: number;
  /** RBAC config: 'token1:admin,token2:readonly' format (Task 5.10) */
  rbacTokens?: string;
}

/** Per-session metadata for monitoring and cleanup. */
export interface SessionMetadata {
  createdAt: Date;
  lastActivity: Date;
  requestCount: number;
  role: Role; // RBAC role (admin, developer, readonly)
}

type TransportHandle = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  meta: SessionMetadata;
};

/** Factory function that produces a fresh McpServer for each new session. */
export type McpServerFactory = () => McpServer;

/** Sessions idle longer than this are automatically closed. */
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** How often to scan for idle sessions. */
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/** Returns true when the request carries a valid Bearer token (timing-safe). */
export function validateBearerToken(req: IncomingMessage, secret: string): boolean {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  const provided = auth.slice(7);
  try {
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(secret, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Send a 401 Unauthorized response with a WWW-Authenticate challenge. */
function rejectUnauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": 'Bearer realm="opengrok-mcp"',
  });
  res.end(JSON.stringify({ error: "unauthorized", error_description: "Bearer token required" }));
}



// ---------------------------------------------------------------------------
// OAuth 2.1 helpers
// ---------------------------------------------------------------------------

/** Build the OAuth 2.1 authorization server metadata document (RFC 8414). */
function buildOAuthMetadata(baseUrl: string): Record<string, unknown> {
  return {
    issuer: baseUrl,
    token_endpoint: `${baseUrl}/token`,
    token_endpoint_auth_methods_supported: ["client_secret_basic"],
    grant_types_supported: ["client_credentials"],
    response_types_supported: ["token"],
  };
}

/**
 * Handle a POST /token request for client_credentials grant.
 * Validates Basic auth credentials against clientId/clientSecret.
 * Returns a Bearer access_token equal to the configured authToken (if set),
 * or a newly minted random UUID otherwise.
 */
async function handleTokenRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { clientId: string; clientSecret: string; authToken: string },
  readBody: (req: IncomingMessage) => Promise<unknown>
): Promise<void> {
  // Support both HTTP Basic auth and form-body client_id/client_secret
  let clientId: string | null = null;
  let clientSecret: string | null = null;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep !== -1) {
      clientId = decoded.slice(0, sep);
      clientSecret = decoded.slice(sep + 1);
    }
  }

  // Fall back to request body
  if (!clientId || !clientSecret) {
    const body = await readBody(req);
    if (body && typeof body === "object") {
      const b = body as Record<string, string>;
      clientId = b["client_id"] ?? null;
      clientSecret = b["client_secret"] ?? null;
    }
  }

  if (!clientId || !clientSecret || clientId !== opts.clientId || clientSecret !== opts.clientSecret) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_client" }));
    return;
  }

  const accessToken = opts.authToken || randomUUID();
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ access_token: accessToken, token_type: "Bearer", expires_in: 3600 }));
}

/**
 * Start an HTTP server that serves the MCP protocol over Streamable HTTP transport.
 *
 * @param serverFactory - called once per new client session to create a McpServer
 * @param opts - port, optional host, and optional auth options
 * @returns promise that resolves once the server is listening, with a `close()` helper
 */
export async function startHttpTransport(
  serverFactory: McpServerFactory,
  opts: HttpTransportOptions
): Promise<{ close: () => void }> {
  const { port, host = "127.0.0.1", authToken = "", clientId = "", clientSecret = "", maxSessions = 100, rbacTokens = "" } = opts;
  const rbacConfig = parseRbacConfig(rbacTokens);

  // Active sessions: Mcp-Session-Id → { transport, server, meta }
  const sessions = new Map<string, TransportHandle>();

  // Sweep idle sessions on a regular interval.
  const sweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [sid, handle] of sessions) {
      if (now - handle.meta.lastActivity.getTime() > SESSION_TTL_MS) {
        logger.info(`HTTP session expired (idle TTL): ${sid}`);
        void handle.transport.close().catch(() => undefined);
        sessions.delete(sid);
      }
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  sweepInterval.unref?.(); // don't keep Node alive for the timer alone

  const allowedOrigins = (process.env.OPENGROK_ALLOWED_ORIGINS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);

  const setCorsHeaders = (req: IncomingMessage, res: ServerResponse): void => {
    const origin = req.headers.origin ?? '';
    const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const isAllowed = isLoopback || allowedOrigins.includes(origin);

    if (isAllowed && origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, Authorization');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
  };

  /** Extract bearer token from Authorization header and return role (or null for unknown/denied). */
  const extractRole = (req: IncomingMessage): Role | null => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      // No token — fail-safe: if RBAC active, deny; if no RBAC, allow as admin (local dev)
      return rbacConfig.tokens.size > 0 ? null : 'admin';
    }
    const token = auth.slice(7);

    // Static auth token check (local dev only)
    if (authToken && token === authToken) return rbacConfig.tokens.get(token) ?? 'admin';

    const role = rbacConfig.tokens.get(token);
    if (!role && rbacConfig.tokens.size > 0) return null; // unknown token + RBAC active = deny
    return role ?? 'admin';
  };

  /** Check if a request body is an MCP tool call, and validate RBAC if so. Returns null if permission denied. */
  const checkRbacForToolCall = (role: Role, body: unknown): { allowed: boolean; toolName?: string } => {
    if (!body || typeof body !== "object") return { allowed: true }; // not a tool call

    const b = body as Record<string, unknown>;
    if (b.method !== "tools/call") return { allowed: true }; // not a tool call

    const params = b.params;
    if (!params || typeof params !== "object") return { allowed: true };

    const toolName = (params as Record<string, unknown>).name as string | undefined;
    if (!toolName) return { allowed: true };

    const isAllowed = hasPermission(role, toolName);
    return { allowed: isAllowed, toolName };
  };

  /** Read the full request body as a parsed JSON object (or URL-encoded form). Returns null on failure. */
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
        // Try JSON first, then URL-encoded form data
        try {
          resolve(JSON.parse(raw));
          return;
        } catch {
          // try form
        }
        const params: Record<string, string> = {};
        for (const pair of raw.split("&")) {
          const [k, v] = pair.split("=");
          if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
        }
        resolve(params);
      });
      req.on("error", () => resolve(null));
    });

  const handlePost = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const body = await readBody(req);

    try {
      let handle: TransportHandle | undefined;

      if (sessionId && sessions.has(sessionId)) {
        handle = sessions.get(sessionId);
        if (!handle) throw new Error("Session vanished");
        handle.meta.lastActivity = new Date();
        handle.meta.requestCount += 1;
      } else if (!sessionId && isInitializeRequest(body)) {
        // Enforce session cap before creating a new session.
        if (sessions.size >= maxSessions) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Service Unavailable: maximum sessions reached" },
              id: null,
            })
          );
          return;
        }

        // Extract role from bearer token (RBAC)
        const role = extractRole(req);
        if (role === null) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden', error_description: 'Unknown or missing token' }));
          return;
        }

        // New client — create a fresh server + transport for this session.
        const now = new Date();
        const meta: SessionMetadata = { createdAt: now, lastActivity: now, requestCount: 1, role };

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server, meta });
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

        handle = { transport, server, meta };
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

      // Check RBAC permissions for existing sessions
      const rbacCheck = checkRbacForToolCall(handle.meta.role, body);
      if (!rbacCheck.allowed) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: `Role '${handle.meta.role}' does not have permission for tool '${rbacCheck.toolName}'`,
            data: { tool: rbacCheck.toolName, role: handle.meta.role },
          },
          id: null,
        }));
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
    const handle = sessions.get(sessionId);
    if (!handle) return;
    handle.meta.lastActivity = new Date();
    handle.meta.requestCount += 1;
    try {
      await handle.transport.handleRequest(req, res);
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
      const handle = sessions.get(sessionId);
    if (handle) await handle.transport.handleRequest(req, res);
    else throw new Error("Session vanished");
    } catch (err) {
      logger.error("HTTP DELETE handler error:", err);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
  };

  const httpServer = createHttpServer((req, res) => {
    setCorsHeaders(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const url = req.url?.split("?")[0];

    // OAuth 2.1 discovery endpoint (RFC 8414)
    if (url === "/.well-known/oauth-authorization-server" && req.method === "GET") {
      const baseUrl = `http://${host}:${port}`;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(buildOAuthMetadata(baseUrl)));
      return;
    }

    // OAuth 2.1 token endpoint — only active when clientId/clientSecret are configured
    if (url === "/token" && req.method === "POST") {
      if (!clientId || !clientSecret) {
        res.writeHead(404).end("Not Found");
        return;
      }
      void handleTokenRequest(req, res, { clientId, clientSecret, authToken }, readBody);
      return;
    }

    // Debug/admin endpoint — active session stats.
    if (url === "/mcp/sessions" && req.method === "GET") {
      const sessionList = Array.from(sessions.entries()).map(([sid, h]) => ({
        sessionId: sid,
        createdAt: h.meta.createdAt.toISOString(),
        lastActivity: h.meta.lastActivity.toISOString(),
        requestCount: h.meta.requestCount,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ activeSessionCount: sessions.size, maxSessions, sessions: sessionList }));
      return;
    }

    if (url !== "/mcp") {
      res.writeHead(404).end("Not Found");
      return;
    }

    // Bearer token validation for /mcp
    // Only enforce auth for new sessions (initialize requests without session ID)
    // Existing sessions are identified by session ID header
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const isExistingSession = sessionId && sessions.has(sessionId);

    if (!isExistingSession) {
      // New request: validate bearer token
      const auth = req.headers.authorization;
      const hasBearer = auth?.startsWith("Bearer ");
      const bearerToken = hasBearer && auth ? auth.slice(7) : null;

      if (rbacConfig.tokens.size > 0) {
        // RBAC mode: require token to be in RBAC config
        if (!bearerToken || !rbacConfig.tokens.has(bearerToken)) {
          rejectUnauthorized(res);
          return;
        }
      } else if (authToken) {
        // Standard auth mode: require exact token match
        if (!validateBearerToken(req, authToken)) {
          rejectUnauthorized(res);
          return;
        }
      }
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
          clearInterval(sweepInterval);
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

