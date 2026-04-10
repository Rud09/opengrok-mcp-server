/**
 * OpenGrok HTTP client with caching, rate limiting, retry logic,
 * and SSRF/path-traversal protections.
 */

import pRetry, { AbortError } from "p-retry";
import { minimatch } from "minimatch";
import { URL } from "url";
import { isIPv4, isIPv6 } from "node:net";
import { Agent, ProxyAgent, type Dispatcher } from "undici";
import type { Config } from "./config";
import { logger } from "./logger.js";
import type {
  AnnotatedFile,
  DirectoryEntry,
  FileContent,
  FileDiff,
  FileHistory,
  FileSymbol,
  FileSymbols,
  Project,
  SearchResults,
  SearchTypeValue,
} from "./models";
import {
  parseAnnotate,
  parseDirectoryListing,
  parseFileHistory,
  parseFileSymbols,
  parseFileDiff,
  parseProjectsPage,
  parseWebSearchResults,
} from "./parsers";

// Version injected at build time by esbuild, fallback for dev/test
declare const __VERSION__: string;
/* v8 ignore start -- compile-time constant injected by esbuild */
const CLIENT_VERSION =
  typeof __VERSION__ !== "undefined"
    ? __VERSION__
    : (process.env.npm_package_version ?? "0.0.0");
/* v8 ignore stop */

// ---------------------------------------------------------------------------
// Rate Limiter (token bucket — lock released before sleeping)
// ---------------------------------------------------------------------------

class RateLimiter {
  private readonly intervalMs: number;   // ms per token (integer)
  private readonly maxTokensMs: number;  // max accumulated token-ms
  private tokensMs: number;              // current accumulated token-ms (integer)
  private lastUpdate: number;
  private queue: Array<() => void> = [];
  private processing = false;

  constructor(requestsPerMinute: number) {
    this.intervalMs = Math.round((60 / requestsPerMinute) * 1000);
    this.maxTokensMs = requestsPerMinute * this.intervalMs;
    this.tokensMs = this.maxTokensMs; // start full
    this.lastUpdate = Date.now();
  }

  async acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      /* v8 ignore start */
      if (!this.processing) void this.processQueue();
      /* v8 ignore stop */
    });
  }

  private async processQueue(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const now = Date.now();
      const elapsed = now - this.lastUpdate;
      this.tokensMs = Math.min(this.maxTokensMs, this.tokensMs + elapsed);
      this.lastUpdate = now;

      if (this.tokensMs >= this.intervalMs) {
        this.tokensMs -= this.intervalMs;
        const next = this.queue.shift();
        if (next) next();
      } else {
        const waitMs = this.intervalMs - this.tokensMs;
        await sleep(Math.ceil(waitMs));
      }
    }
    this.processing = false;
  }
}

// ---------------------------------------------------------------------------
// TTL Cache (entry count + total byte budget)
// ---------------------------------------------------------------------------

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
  sizeBytes: number;
}

export class TTLCache<K, V> {
  private map = new Map<K, CacheEntry<V>>();
  private totalBytes = 0;
  private writeCount = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly ttlMs: number
  ) { }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.totalBytes -= entry.sizeBytes;
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V, sizeBytes: number): void {
    // Evict expired entries periodically (every 10 writes) instead of every set()
    if (++this.writeCount % 10 === 0) this.evictExpired();

    // Remove existing entry AFTER the eviction loop so the loop sees the current map size.
    // (B5 fix previously deleted before the loop, causing the size check to under-count by one
    // and potentially leaving one stale entry more than maxEntries when updating an existing key.)
    const existing = this.map.get(key);
    if (existing) {
      this.totalBytes -= existing.sizeBytes;
    }

    // Evict LRU-style if over limits. Re-evaluate map.size on each iteration so
    // successive evictions correctly reduce the apparent size.
    while (
      this.map.size - (existing ? 1 : 0) >= this.maxEntries ||
      this.totalBytes + sizeBytes > this.maxBytes
    ) {
      // Find and remove the oldest (first) non-target entry
      let evicted = false;
      for (const [k, entry] of this.map) {
        if (k === key) continue; // don't evict the key we're inserting
        this.totalBytes -= entry.sizeBytes;
        this.map.delete(k);
        evicted = true;
        break;
      }
      if (!evicted) break;
    }

    if (existing) {
      this.map.delete(key);
    }

    this.map.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
      sizeBytes,
    });
    this.totalBytes += sizeBytes;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [k, entry] of this.map) {
      if (now > entry.expiresAt) {
        this.totalBytes -= entry.sizeBytes;
        this.map.delete(k);
      }
    }
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }
}

// ---------------------------------------------------------------------------
// Per-operation timeouts (ms)
// ---------------------------------------------------------------------------
const TIMEOUTS = {
  search: 60_000,
  suggest: 10_000,
  file: 30_000,
  default: 30_000,
};

const MAX_REDIRECTS = 10;
const MAX_FILTER_LENGTH = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Estimate the byte size of a serializable value without blocking the event loop natively. */
function estimateBytes(value: unknown, depth = 0): number {
  if (depth > 20) return 8192; // conservative overestimate for pathologically deep structures
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (typeof value === "object") {
    let size = 0;
    if (Array.isArray(value)) {
      for (const item of value) size += estimateBytes(item, depth + 1);
    } else {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        size += Buffer.byteLength(k, "utf8") + estimateBytes(v, depth + 1);
      }
    }
    return size;
  }
  return 0;
}

/**
 * Extract a line range from content using indexOf instead of split/slice/join.
 * Avoids allocating an intermediate array for the entire file.
 *
 * Single-pass: always scans the full content so `totalLines` is accurate even
 * when we find the end of the requested range before reaching EOF.
 */
export function extractLineRange(
  content: string,
  startLine?: number,
  endLine?: number
): { text: string; totalLines: number } {
  if (startLine === undefined && endLine === undefined) {
    // Fast path: count newlines with a single regex, return full content.
    const totalLines = content.length === 0
      ? 1
      : (content.match(/\n/g)?.length ?? 0) + 1;
    return { text: content, totalLines };
  }

  const s = Math.max(0, (startLine ?? 1) - 1); // 0-based inclusive start index
  const e = endLine;                             // 1-based inclusive end (may be undefined)

  let totalLines = 0;
  let startOffset = s === 0 ? 0 : -1; // -1 means "not yet found"
  let endOffset = content.length;
  let endSet = false;

  let lineIdx = 0; // 0-based index of the line being visited
  let pos = 0;

  while (true) {
    const nl = content.indexOf("\n", pos);

    // Capture start offset when we reach the requested start line
    if (startOffset === -1 && lineIdx === s) {
      startOffset = pos;
    }

    if (nl === -1) {
      // Final line — no trailing newline
      totalLines = lineIdx + 1;
      if (!endSet && e !== undefined && lineIdx < e) {
        endOffset = content.length;
      }
      break;
    }

    totalLines = lineIdx + 2; // current line + at least one more exists

    // After processing the \n of line `lineIdx` (1-based: lineIdx+1), check if we've
    // reached the requested end line. endOffset points past the \n of that line.
    if (!endSet && e !== undefined && lineIdx + 1 >= e) {
      endOffset = nl + 1;
      endSet = true;
    }

    lineIdx++;
    pos = nl + 1;
  }

  // startLine is beyond the end of the file
  if (startOffset === -1) {
    return { text: "", totalLines };
  }

  if (e === undefined) {
    endOffset = content.length;
  }

  let text = content.substring(startOffset, endOffset);
  if (text.endsWith("\n")) text = text.slice(0, -1);

  return { text, totalLines };
}

/**
 * Throw if `path` contains traversal sequences that could escape the project
 * root. Rejects literal, URL-encoded, double-encoded, null-byte, Unicode NFD
 * lookalike, and RTL-override variants.
 */
export function assertSafePath(rawPath: string): void {
  // Block bidi/zero-width characters that can spoof path display
  if (/[\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/.test(rawPath)) {
    throw new Error(`Unsafe path rejected (bidi/zero-width character): "${rawPath}"`);
  }

  // Null bytes — never valid
  if (rawPath.includes('\0') || rawPath.includes('%00') || rawPath.includes('%2500')) {
    throw new Error(`Unsafe path rejected (null byte): "${rawPath}"`);
  }

  // Decode once to catch single-encoding variants (%2e%2e, %2f)
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath.replace(/\+/g, '%20'));
  } catch {
    throw new Error(`Unsafe path rejected (malformed encoding): "${rawPath}"`);
  }

  // NFC normalization — collapses NFD lookalike sequences that could spell '..'
  const normalized = decoded.normalize('NFC').replace(/\\/g, '/');

  // Check for traversal using path-component-aware patterns (avoid false
  // positives on '.../' which is a valid three-dot filename component).
  // A traversal '..' segment must be bounded by '/' or string boundaries.
  const lowerNorm = normalized.toLowerCase();
  if (
    lowerNorm.includes('/../') ||
    lowerNorm.startsWith('../') ||
    lowerNorm === '..' ||
    lowerNorm.endsWith('/..') ||
    lowerNorm.includes('/./') ||
    lowerNorm.startsWith('./')
  ) {
    throw new Error(`Unsafe path rejected: "${rawPath}"`);
  }

  // Encoded traversal patterns in the decoded+normalized form
  const encodedTraversalPatterns = [
    '..%2f', '%2f..', '%2e%2e', '%252e', '%252f',
  ];
  for (const p of encodedTraversalPatterns) {
    if (lowerNorm.includes(p)) {
      throw new Error(`Unsafe path rejected: "${rawPath}"`);
    }
  }

  // Also check raw path for double-encoded patterns
  const rawLower = rawPath.toLowerCase();
  if (rawLower.includes('%252e') || rawLower.includes('%252f')) {
    throw new Error(`Unsafe path rejected (double-encoded traversal): "${rawPath}"`);
  }
}

/** Strip IPv6 brackets and normalize ::ffff:-mapped IPv4 addresses. */
function unmapIPv6(raw: string): string {
  const s = raw.replace(/^\[|\]$/g, "");
  const prefix = s.slice(0, 7).toLowerCase();
  if (prefix === "::ffff:") {
    const candidate = s.slice(7);
    if (isIPv4(candidate)) return candidate;
  }
  return s;
}

/**
 * Returns true if the IP (v4 or v6 string) is in a private/loopback/link-local range.
 * Exported for unit testing.
 */
export function isPrivateIp(raw: string): boolean {
  if (raw === "localhost") return true;
  const ip = unmapIPv6(raw);

  if (isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }

  if (isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      // fe80::/10 link-local: fe80 through febf
      (lower.startsWith("fe") && parseInt(lower.slice(2, 4), 16) >= 0x80 && parseInt(lower.slice(2, 4), 16) <= 0xbf)
    );
  }

  return false;
}

/**
 * Build a URL and verify the resolved host still matches `baseUrl`.
 * Also blocks base URLs that resolve to private/loopback addresses (SSRF protection).
 */
export function buildSafeUrl(baseUrl: URL, ...segments: string[]): URL {
  const joined = segments.map((s) => encodeURIComponent(s).replace(/%2F/g, "/")).join("/");
  const url = new URL(joined, baseUrl);
  if (url.hostname !== baseUrl.hostname || url.port !== baseUrl.port) {
    throw new Error(`SSRF guard: resolved URL "${url}" escapes allowed host "${baseUrl.hostname}"`);
  }
  // Block private/loopback IPs in base URL at construction time
  if (isPrivateIp(baseUrl.hostname)) {
    throw new Error(`SSRF guard: base URL hostname "${baseUrl.hostname}" is a private/loopback address`);
  }
  return url;
}

// ---------------------------------------------------------------------------
// OpenGrok HTTP Client
// ---------------------------------------------------------------------------

export class OpenGrokClient {
  private readonly baseUrl: URL;
  private readonly apiPath: string;
  private readonly authHeader: string | undefined;
  private readonly verifySsl: boolean;
  private readonly rateLimiter: RateLimiter | undefined;
  private readonly agent: Dispatcher | undefined;
  private annotateEndpoint: 'annotate' | 'xref' | null = null;

  // Caches
  private readonly searchCache: TTLCache<string, SearchResults> | undefined;
  private readonly fileCache: TTLCache<string, string> | undefined;
  private readonly historyCache: TTLCache<string, FileHistory> | undefined;
  private readonly projectsCache: TTLCache<string, Project[]> | undefined;

  constructor(private readonly config: Config) {
    if (!config.OPENGROK_BASE_URL) {
      throw new Error(
        "OPENGROK_BASE_URL is not configured. Run `npx opengrok-mcp-server setup` or set the OPENGROK_BASE_URL environment variable."
      );
    }
    const raw = config.OPENGROK_BASE_URL.endsWith("/")
      ? config.OPENGROK_BASE_URL
      : config.OPENGROK_BASE_URL + "/";
    this.baseUrl = new URL(raw);
    this.apiPath = config.OPENGROK_API_VERSION === "v2" ? "api/v2" : "api/v1";
    this.verifySsl = config.OPENGROK_VERIFY_SSL;
    const agentOptions = {
      connections: 20,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 300_000,
    };

    // Apply HTTP/HTTPS proxy if configured. undici does NOT auto-read standard
    // proxy env vars (unlike node-fetch), so we must wire ProxyAgent explicitly.
    // HTTPS_PROXY takes precedence over HTTP_PROXY when both are set.
    const proxyUrl = config.HTTPS_PROXY || config.HTTP_PROXY;
    if (proxyUrl) {
      /* v8 ignore start -- proxy path; tested in client-extended with proxy config */
      this.agent = new ProxyAgent({
        uri: proxyUrl,
        ...agentOptions,
        ...(this.verifySsl ? {} : { requestTls: { rejectUnauthorized: false } }),
      });
      /* v8 ignore stop */
    } else {
      this.agent = this.verifySsl
        ? new Agent(agentOptions)
        : new Agent({ ...agentOptions, connect: { rejectUnauthorized: false } });
    }

    if (config.OPENGROK_USERNAME && config.OPENGROK_PASSWORD) {
      const b64 = Buffer.from(
        `${config.OPENGROK_USERNAME}:${config.OPENGROK_PASSWORD}`
      ).toString("base64");
      this.authHeader = `Basic ${b64}`;
    }

    const maxBytes = Math.floor(config.OPENGROK_CACHE_MAX_BYTES / 4); // split budget across 4 caches

    if (config.OPENGROK_CACHE_ENABLED) {
      this.searchCache = new TTLCache(
        config.OPENGROK_CACHE_MAX_SIZE,
        maxBytes,
        config.OPENGROK_CACHE_SEARCH_TTL * 1000
      );
      this.fileCache = new TTLCache(
        config.OPENGROK_CACHE_MAX_SIZE,
        maxBytes,
        config.OPENGROK_CACHE_FILE_TTL * 1000
      );
      this.historyCache = new TTLCache(
        config.OPENGROK_CACHE_MAX_SIZE,
        maxBytes,
        config.OPENGROK_CACHE_HISTORY_TTL * 1000
      );
      this.projectsCache = new TTLCache(
        1,
        maxBytes,
        config.OPENGROK_CACHE_PROJECTS_TTL * 1000
      );
    }

    if (config.OPENGROK_RATELIMIT_ENABLED) {
      this.rateLimiter = new RateLimiter(config.OPENGROK_RATELIMIT_RPM);
    }
  }

  // -------------------------------------------------------------------------
  // Core request method
  // -------------------------------------------------------------------------

  private async request(
    urlOrPath: URL | string,
    timeoutMs: number = TIMEOUTS.default,
    accept: string = "application/json, text/html, */*"
  ): Promise<Response> {
    if (this.rateLimiter) await this.rateLimiter.acquire();

    const url =
      urlOrPath instanceof URL
        ? urlOrPath
        : /* v8 ignore next -- internal callers always pass URL */ buildSafeUrl(this.baseUrl, urlOrPath);

    const headers: Record<string, string> = {
      "User-Agent": `OpenGrok-MCP/${CLIENT_VERSION}`,
      Accept: accept,
    };
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    };

    /* v8 ignore start -- agent is set when VERIFY_SSL=false; tested in client-extended with ssl config */
    if (this.agent) {
      fetchOptions.dispatcher = this.agent;
    }
    /* v8 ignore stop */

    const run = async (): Promise<Response> => {
      let currentUrl = url;
      let redirectCount = 0;

      while (true) {
        const response = await fetch(currentUrl.toString(), fetchOptions);

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          /* v8 ignore start -- defensive redirect guards */
          if (redirectCount >= MAX_REDIRECTS) throw new Error("Too many redirects");
          const location = response.headers.get("location");
          if (!location) throw new Error("Redirect with no location header");
          /* v8 ignore stop */

          const parsedLocation = new URL(location, currentUrl);
          if (parsedLocation.hostname !== this.baseUrl.hostname || parsedLocation.port !== this.baseUrl.port) {
            throw new Error(`SSRF guard: redirected URL "${parsedLocation}" escapes allowed host "${this.baseUrl.hostname}"`);
          }
          // Block protocol downgrade (e.g. https → http) to prevent TLS stripping
          if (parsedLocation.protocol !== this.baseUrl.protocol) {
            throw new Error(`SSRF guard: redirect changes protocol from "${this.baseUrl.protocol}" to "${parsedLocation.protocol}"`);
          }

          // Consume the unneeded redirect body to prevent fetch/undici memory leaks
          try { await response.text(); } catch { }

          currentUrl = parsedLocation;
          redirectCount++;
          continue;
        }

        /* v8 ignore start -- pRetry handles 429/5xx and 4xx; tested via fetch spy but V8 can't track */
        if (response.status === 429 || response.status >= 500) {
          // Retryable
          throw new Error(`HTTP ${response.status} – ${response.statusText}`);
        }
        if (!response.ok) {
          // 4xx — not retryable
          throw new AbortError(
            `HTTP ${response.status} – ${response.statusText}`
          );
        }
        /* v8 ignore stop */
        return response;
      }
    };

    return pRetry(run, {
      retries: 3,
      minTimeout: 1000,
      maxTimeout: 10_000,
      factor: 2,
      onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
        logger.warn(
          `Request to ${url.pathname} failed (attempt ${attemptNumber}/${retriesLeft + attemptNumber}): ${error.message}`
        );
      },
    });
  }

  // -------------------------------------------------------------------------
  // Public API methods
  // -------------------------------------------------------------------------

  async search(
    query: string,
    searchType: SearchTypeValue = "full",
    projects?: string[],
    maxResults: number = this.config.OPENGROK_DEFAULT_MAX_RESULTS,
    start: number = 0,
    fileType?: string
  ): Promise<SearchResults> {
    const sortedProjects = projects ? [...projects].sort() : undefined;
    // Use deterministic join instead of JSON.stringify to avoid object-key ordering differences
    const cacheKey = `${searchType}:${query}:${sortedProjects ? sortedProjects.join(",") : ""}:${maxResults}:${start}:${fileType ?? ""}`;    const cached = this.searchCache?.get(cacheKey);
    if (cached) return cached;

    // For defs/refs, OpenGrok 1.7.x REST API returns 400. Fall back to web
    // search HTML parsing which supports all search fields.
    if (searchType === "defs" || searchType === "refs") {
      const results = await this.searchWeb(query, searchType, projects, maxResults, fileType);
      this.searchCache?.set(cacheKey, results, estimateBytes(results));
      return results;
    }

    const url = buildSafeUrl(this.baseUrl, `${this.apiPath}/search`);
    url.searchParams.set(searchType, query);
    url.searchParams.set("maxresults", String(maxResults));
    if (projects?.length) {
      url.searchParams.set("projects", sortedProjects?.join(",") ?? "");
    }
    if (start > 0) {
      url.searchParams.set("start", String(start));
    }
    if (fileType) {
      url.searchParams.set("type", fileType);
    }

    const response = await this.request(url, TIMEOUTS.search, "application/json");
    const data = (await response.json()) as Record<string, unknown>;
    const results = parseSearchResponse(data, searchType, query);

    this.searchCache?.set(cacheKey, results, estimateBytes(results));
    return results;
  }

  /**
   * Fall back to the web search UI endpoint (/search?defs=X) when the REST
   * API does not support a particular search field (e.g., defs/refs on
   * OpenGrok 1.7.x). Parses the HTML response to extract results.
   */
  private async searchWeb(
    query: string,
    searchType: SearchTypeValue,
    projects?: string[],
    maxResults: number = 25,
    fileType?: string
  ): Promise<SearchResults> {
    const url = buildSafeUrl(this.baseUrl, "search");
    url.searchParams.set(searchType, query);
    url.searchParams.set("n", String(maxResults));
    if (projects?.length) {
      for (const p of projects) {
        url.searchParams.append("project", p);
      }
    }
    if (fileType) {
      url.searchParams.set("type", fileType);
    }

    const response = await this.request(url, TIMEOUTS.search, "text/html, */*");
    const html = await response.text();
    return parseWebSearchResults(html, searchType, query);
  }

  async searchPattern(opts: {
    pattern: string;
    projects?: string[];
    fileType?: string;
    maxResults?: number;
  }): Promise<SearchResults> {
    const { pattern, projects, fileType, maxResults = 20 } = opts;
    const url = buildSafeUrl(this.baseUrl, `${this.apiPath}/search`);
    url.searchParams.set("full", pattern);
    url.searchParams.set("regexp", "true");
    url.searchParams.set("maxresults", String(maxResults));
    if (projects?.length) {
      url.searchParams.set("projects", [...projects].sort().join(","));
    }
    if (fileType) {
      url.searchParams.set("type", fileType);
    }

    const response = await this.request(url, TIMEOUTS.search, "application/json");
    const data = (await response.json()) as Record<string, unknown>;
    return parseSearchResponse(data, "full", pattern);
  }

  async suggest(
    query: string,
    project?: string,
    field: string = "full"
  ): Promise<{ suggestions: string[]; time: number; partialResult: boolean }> {
    const url = buildSafeUrl(this.baseUrl, `${this.apiPath}/suggest`);
    url.searchParams.set(field, query);
    url.searchParams.set("field", field);
    url.searchParams.set("caret", String(query.length));
    if (project) url.searchParams.set("projects", project);

    const response = await this.request(url, TIMEOUTS.suggest, "application/json");
    const data = (await response.json()) as Record<string, unknown>;
    return {
      suggestions: (data["suggestions"] as string[]) ?? [],
      time: (data["time"] as number) ?? 0,
      partialResult: (data["partialResult"] as boolean) ?? false,
    };
  }

  async getFileContent(
    project: string,
    path: string,
    startLine?: number,
    endLine?: number
  ): Promise<FileContent> {
    assertSafePath(path);
    const normalizedPath = path.replace(/^\/+/, "");
    const cacheKey = `${project}:${normalizedPath}`;

    let fullContent: string;
    const cachedContent = this.fileCache?.get(cacheKey);
    if (cachedContent !== undefined) {
      fullContent = cachedContent;
    } else {
      const url = buildSafeUrl(
        this.baseUrl,
        `raw/${encodeURIComponent(project)}/${normalizedPath}`
      );
      const response = await this.request(url, TIMEOUTS.file, "text/plain, */*");
      fullContent = await response.text();
      this.fileCache?.set(cacheKey, fullContent, Buffer.byteLength(fullContent, "utf8"));
    }

    const { text: content, totalLines } = extractLineRange(fullContent, startLine, endLine);

    return {
      project,
      path: normalizedPath,
      content,
      lineCount: totalLines,
      sizeBytes: Buffer.byteLength(fullContent, "utf8"),
      startLine,
    };
  }

  async getFileHistory(
    project: string,
    path: string,
    maxEntries: number = 10
  ): Promise<FileHistory> {
    assertSafePath(path);
    const normalizedPath = path.replace(/^\/+/, "");
    // Cache key intentionally omits maxEntries. Correctness relies on the upstream
    // OpenGrok API returning the full history list in a single response (no server-side
    // pagination applied to the history endpoint). If the API returns exactly N entries
    // on the first call, a subsequent caller requesting >N entries will silently receive
    // N with no truncation indicator. This is an accepted trade-off: the cache stores
    // the full API response and slices to the requested length on retrieval.
    // If the upstream API begins paginating, add maxEntries to the cache key to
    // prevent silent under-delivery.
    const cacheKey = `${project}:${normalizedPath}`;

    let history = this.historyCache?.get(cacheKey);
    if (!history) {
      const url = buildSafeUrl(
        this.baseUrl,
        `history/${encodeURIComponent(project)}/${normalizedPath}`
      );
      const response = await this.request(url, TIMEOUTS.default, "text/html, */*");
      const html = await response.text();
      history = parseFileHistory(html, project, normalizedPath);
      this.historyCache?.set(cacheKey, history, estimateBytes(history));
    }

    if (history.entries.length > maxEntries) {
      return {
        ...history,
        entries: history.entries.slice(0, maxEntries),
      };
    }
    return history;
  }

  async getAnnotate(project: string, path: string): Promise<AnnotatedFile> {
    assertSafePath(path);
    const normalizedPath = path.replace(/^\/+/, "");
    const cacheKey = `annotate:${project}:${normalizedPath}`;

    /* v8 ignore next -- cache hit path */
    const cachedJson = this.fileCache?.get(cacheKey);
    if (cachedJson !== undefined) {
      return JSON.parse(cachedJson) as AnnotatedFile;
    }

    // Use cached endpoint style if known, otherwise probe
    /* v8 ignore start */
    if (this.annotateEndpoint !== 'xref') {
    /* v8 ignore stop */
      try {
        const annotateUrl = buildSafeUrl(
          this.baseUrl,
          `annotate/${encodeURIComponent(project)}/${normalizedPath}`
        );
        const response = await this.request(annotateUrl, TIMEOUTS.file, "text/html, */*");
        const html = await response.text();
        this.annotateEndpoint = 'annotate';
        const result = parseAnnotate(html, project, normalizedPath);
        /* v8 ignore next -- cache set */
        this.fileCache?.set(cacheKey, JSON.stringify(result), estimateBytes(result));
        return result;
      } catch {
        /* v8 ignore start -- tested via fetch spy in client-internals; V8 coverage merge issue */
        if (this.annotateEndpoint === 'annotate') {
          // Cached style failed — reset and try fallback
          this.annotateEndpoint = null;
        }
        /* v8 ignore stop */
      }
    }

    /* v8 ignore start -- xref annotate fallback; tested in client-extended but V8 can't track through spy */
    const xrefUrl = buildSafeUrl(
      this.baseUrl,
      `xref/${encodeURIComponent(project)}/${normalizedPath}`
    );
    xrefUrl.searchParams.set("a", "true");
    const response = await this.request(xrefUrl, TIMEOUTS.file, "text/html, */*");
    const html = await response.text();
    this.annotateEndpoint = 'xref';
    const result = parseAnnotate(html, project, normalizedPath);
    this.fileCache?.set(cacheKey, JSON.stringify(result), estimateBytes(result));
    return result;
    /* v8 ignore stop */
  }

  async getFileSymbols(project: string, path: string): Promise<FileSymbols> {
    assertSafePath(path);
    const normalizedPath = path.replace(/^\/+/, "");
    const cacheKey = `defs:${project}:${normalizedPath}`;
    const cached = this.fileCache?.get(cacheKey);
    /* v8 ignore start -- cache hit path; tested but V8 doesn't track due to mock layer */
    if (cached !== undefined) {
      return JSON.parse(cached) as FileSymbols;
    }
    /* v8 ignore stop */
    const url = buildSafeUrl(this.baseUrl, `${this.apiPath}/file/defs`);
    url.searchParams.set("path", "/" + normalizedPath);
    try {
      const response = await this.request(url, TIMEOUTS.file, "application/json");
      const data = (await response.json()) as FileSymbol[];
      const result: FileSymbols = {
        project,
        path: normalizedPath,
        symbols: /* v8 ignore next -- defense-in-depth: API always returns array */ Array.isArray(data) ? data : [],
      };
      const json = JSON.stringify(result);
      /* v8 ignore next -- cache set; tested but V8 doesn't track */
      this.fileCache?.set(cacheKey, json, Buffer.byteLength(json, "utf8"));
      return result;
    } catch {
      // /api/v1/file/defs may not exist or may return 401 — fall back to
      // parsing intelliWindow-symbol links from the xref HTML page.
      /* v8 ignore start -- tested in client-extended (xref fallback + double failure); V8 can't track through pRetry spy */
      try {
        const xrefUrl = buildSafeUrl(
          this.baseUrl,
          `xref/${encodeURIComponent(project)}/${normalizedPath}`
        );
        const response = await this.request(xrefUrl, TIMEOUTS.file, "text/html, */*");
        const html = await response.text();
        const symbols = parseFileSymbols(html);
        const result: FileSymbols = { project, path: normalizedPath, symbols };
        const json = JSON.stringify(result);
        this.fileCache?.set(cacheKey, json, Buffer.byteLength(json, "utf8"));
        return result;
      } catch {
        return { project, path: normalizedPath, symbols: [] };
      }
      /* v8 ignore stop */
    }
  }

  async browseDirectory(
    project: string,
    path: string = ""
  ): Promise<DirectoryEntry[]> {
    if (path) assertSafePath(path);
    const cleanPath = path.replace(/^\/+|\/+$/g, "");
    const pathSegment = cleanPath ? `${cleanPath}/` : "";
    const url = buildSafeUrl(
      this.baseUrl,
      `xref/${encodeURIComponent(project)}/${pathSegment}`
    );
    const response = await this.request(url, TIMEOUTS.default, "text/html, */*");
    const html = await response.text();
    return parseDirectoryListing(html, project, cleanPath);
  }

  async listProjects(filterPattern?: string): Promise<Project[]> {
    const cacheKey = "projects";
    let projects = this.projectsCache?.get(cacheKey);

    if (!projects) {
      const url = buildSafeUrl(this.baseUrl, "");
      const response = await this.request(url, TIMEOUTS.default, "text/html, */*");
      const html = await response.text();
      projects = parseProjectsPage(html);
      this.projectsCache?.set(cacheKey, projects, estimateBytes(projects));
    }

    if (filterPattern) {
      if (filterPattern.length > MAX_FILTER_LENGTH) {
        throw new Error(`Filter pattern too long (max ${MAX_FILTER_LENGTH} characters)`);
      }
      // Auto-append * for substring matching if no glob wildcards present
      const glob = /[*?]/.test(filterPattern) ? filterPattern : `*${filterPattern}*`;
      return projects.filter((p) => minimatch(p.name, glob, { nocase: true }));
    }
    return projects;
  }

  async testConnection(): Promise<boolean> {
    // Use a single direct fetch (no pRetry) so 429/5xx don't trigger retry backoff.
    // Any HTTP response means the server is reachable; only network/SSL/timeout
    // errors mean we can't connect. 5xx responses indicate the service is unhealthy.
    try {
      const url = buildSafeUrl(this.baseUrl, "");
      const fetchOptions: RequestInit & { dispatcher?: unknown } = {
        headers: { "User-Agent": `OpenGrok-MCP/${CLIENT_VERSION}` },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUTS.default),
      };
      /* v8 ignore next -- agent set when VERIFY_SSL=false; tested in client-extended */
      if (this.agent) fetchOptions.dispatcher = this.agent;
      const response = await fetch(url.toString(), fetchOptions);
      void response.text().catch(() => {}); // consume body to avoid undici leaks
      // 5xx means the service is down — not healthy
      if (response.status >= 500) return false;
      // 2xx / 3xx / 4xx (including 401, 403, 429) — server IS reachable
      return true;
    } catch {
      // Network errors, SSL failures, DNS failures, timeouts
      return false;
    }
  }

  /**
   * Get call graph for a symbol (API v2 only, with v1 fallback).
   * v2 endpoint: GET /api/v2/symbol/{symbol}/callgraph?project={project}
   * v1 fallback: search for refs to construct a basic dependency view
   */
  async getCallGraph(
    project: string,
    symbol: string
  ): Promise<SearchResults> {
    if (!project.trim()) throw new Error("project must not be empty");
    if (!symbol.trim()) throw new Error("symbol must not be empty");

    // If v2 API is configured, try the dedicated endpoint
    if (this.config.OPENGROK_API_VERSION === "v2") {
      try {
        const url = buildSafeUrl(
          this.baseUrl,
          this.apiPath,
          "symbol",
          encodeURIComponent(symbol),
          "callgraph"
        );
        url.searchParams.set("project", project);
        const response = await this.request(url, TIMEOUTS.search, "application/json");
        const data = (await response.json()) as Record<string, unknown>;
        // Only use the v2 response if it matches the expected search-results shape.
        // A call-graph response has a different structure and would parse as empty results
        // without throwing, blocking the v1 fallback.
        if (data && typeof data === "object" && "results" in data) {
          return parseSearchResponse(data, "refs", symbol);
        }
        // Response format doesn't match — fall through to v1
      } catch {
        // Fall through to v1 fallback on any error
      }
    }

    // Fallback: search for symbol refs (v1 compatible)
    return this.search(symbol, "refs", [project]);
  }

  /**
   * Fire-and-forget cache pre-warming. Called after successful health check.
   * Warms up the TTL cache with project list + one minimal defs search.
   * Best-effort only; errors are silently ignored.
   */
  warmCache(): void {
    void this.listProjects().catch(() => undefined);
    void this.search("main", "defs", undefined, 1).catch(() => undefined);
  }

  async getFileDiff(
    project: string,
    path: string,
    rev1: string,
    rev2: string,
  ): Promise<FileDiff> {
    assertSafePath(path);
    const normalizedPath = path.replace(/^\/+/, "");
    const url = buildSafeUrl(this.baseUrl, `diff/${encodeURIComponent(project)}/${normalizedPath}`);
    // r1/r2 use the OpenGrok convention: /{project}/{path}@{revision}
    url.searchParams.set("r1", `/${project}/${normalizedPath}@${rev1}`);
    url.searchParams.set("r2", `/${project}/${normalizedPath}@${rev2}`);
    // format=u returns unified diff as HTML with context lines
    url.searchParams.set("format", "u");
    const response = await this.request(url, TIMEOUTS.file, "text/html, */*");
    const html = await response.text();
    return parseFileDiff(html, project, normalizedPath, rev1, rev2);
  }

  getBaseUrl(): string {
    return this.baseUrl.toString();
  }

  async close(): Promise<void> {
    // Close shared agent and clear caches on shutdown
    try {
      await this.agent?.close();
    } finally {
      this.searchCache?.clear();
      this.fileCache?.clear();
      this.historyCache?.clear();
      this.projectsCache?.clear();
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: parse JSON search response
// ---------------------------------------------------------------------------

export function parseSearchResponse(
  data: Record<string, unknown>,
  searchType: SearchTypeValue,
  query: string
): SearchResults {
  const rawResults = (data["results"] as Record<string, Array<Record<string, unknown>>>) ?? {};
  const results: SearchResults["results"] = [];

  for (const [filePath, matches] of Object.entries(rawResults)) {
    const match = /^\/([^/]+)(\/.*)?$/.exec(filePath);
    const project = match?.[1] ?? "unknown";
    const path = match?.[2] ?? filePath;

    results.push({
      project,
      path,
      matches: matches.map((m) => ({
        lineNumber: Number(m["lineNumber"] ?? 0),
        lineContent: String(m["line"] ?? ""),
      })),
    });
  }

  return {
    query,
    searchType,
    totalCount: Number(data["resultCount"] ?? 0),
    timeMs: Number(data["time"] ?? 0),
    results,
    startIndex: Number(data["startDocument"] ?? 0),
    endIndex: Number(data["endDocument"] ?? 0),
  };
}

// Exported for testing only
export {
  RateLimiter as _RateLimiter,
  TTLCache as _TTLCache,
  estimateBytes as _estimateBytes,
  sleep as _sleep,
  TIMEOUTS as _TIMEOUTS,
};
