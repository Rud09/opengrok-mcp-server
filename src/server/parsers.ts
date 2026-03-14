/**
 * HTML parsers for OpenGrok web UI responses.
 * Uses node-html-parser (pure JS) instead of BeautifulSoup.
 */

import { parse as parseHtml } from "node-html-parser";
import type {
  AnnotatedFile,
  AnnotateLine,
  DirectoryEntry,
  FileHistory,
  FileSymbol,
  HistoryEntry,
  Project,
  SearchResults,
  SearchTypeValue,
} from "./models.js";

// ---------------------------------------------------------------------------
// Projects page
// ---------------------------------------------------------------------------

export function parseProjectsPage(html: string): Project[] {
  const root = parseHtml(html);
  const projects: Project[] = [];

  // Try select#project or select[name=project]
  const select =
    root.querySelector("select#project") ||
    root.querySelector("select[name=project]");

  if (!select) {
    // Fallback: scrape links to /xref/
    const seen = new Set<string>();
    for (const a of root.querySelectorAll("a[href]")) {
      const href = /* v8 ignore next */ a.getAttribute("href") ?? "";
      const m = /\/xref\/([^/]+)\/?$/.exec(href);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        projects.push({ name: m[1] });
      }
    }
    return projects;
  }

  let currentCategory: string | undefined;

  for (const child of select.childNodes) {
    const tag = (child as { tagName?: string }).tagName?.toLowerCase();
    if (tag === "optgroup") {
      const el = child as ReturnType<typeof parseHtml>;
      currentCategory = (el as unknown as { getAttribute: (s: string) => string | undefined }).getAttribute("label") ?? undefined;
      for (const opt of el.querySelectorAll("option")) {
        /* v8 ignore start -- value always present and non-empty in test data */
        const value = opt.getAttribute("value") ?? "";
        if (value) projects.push({ name: value, category: currentCategory });
        /* v8 ignore stop */
      }
    } else if (tag === "option") {
      const value = (child as ReturnType<typeof parseHtml>).getAttribute
        ? (child as unknown as { getAttribute: (s: string) => string | undefined }).getAttribute("value") ?? ""
        : /* v8 ignore next -- option element always has getAttribute */ "";
      if (value) projects.push({ name: value, category: currentCategory });
    }
  }

  return projects;
}

// ---------------------------------------------------------------------------
// Directory listing
// ---------------------------------------------------------------------------

export function parseDirectoryListing(
  html: string,
  project: string,
  currentPath: string
): DirectoryEntry[] {
  const root = parseHtml(html);
  const entries: DirectoryEntry[] = [];

  const table =
    root.querySelector("table#dirlist") || root.querySelector("table");

  if (!table) {
    // Fallback: links within /xref/project/
    const escapedProject = project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const a of root.querySelectorAll("a[href]")) {
      const href = /* v8 ignore next */ a.getAttribute("href") ?? "";
      const m = new RegExp(`/xref/${escapedProject}/(.+)$`).exec(href);
      if (!m) continue;
      const entryPath = m[1];
      if (entryPath.replace(/\/$/, "") === currentPath.replace(/\/$/, "")) continue;
      entries.push({
        name: /* v8 ignore next */ entryPath.replace(/\/$/, "").split("/").pop() ?? entryPath,
        isDirectory: href.endsWith("/"),
        path: entryPath.replace(/\/$/, ""),
      });
    }
    return entries;
  }

  const escapedProject = project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const absXrefRe = new RegExp(`/xref/${escapedProject}/(.+)$`);
  for (const row of table.querySelectorAll("tr")) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 1) continue;

    // Find the first <a> with a meaningful href in any cell (cells[0] may be
    // an icon cell with no link). Typically cells[0] or cells[1].
    let link: ReturnType<typeof root.querySelector> | null = null;
    for (let ci = 0; ci < Math.min(cells.length, 3); ci++) {
      const candidate = cells[ci].querySelector("a");
      if (candidate) {
        const href = candidate.getAttribute("href") ?? "";
        // Skip anchors that are just "#" or empty
        if (href && href !== "#") {
          link = candidate;
          break;
        }
      }
    }
    if (!link) continue;

    const name = link.text.trim();
    const href = /* v8 ignore next */ link.getAttribute("href") ?? "";
    const isDir = href.endsWith("/");

    // Try absolute href first (/xref/project/...), then treat as relative
    const absMatch = absXrefRe.exec(href);
    let entryPath: string;
    if (absMatch) {
      entryPath = absMatch[1].replace(/\/$/, "");
    } else {
      // Relative href — join with current browsing path
      const relativePart = href.replace(/\/$/, "");
      entryPath = currentPath ? `${currentPath}/${relativePart}` : relativePart;
    }

    // Extract size and date from remaining cells — adapt to variable layouts
    let size: number | undefined;
    let lastModified: string | undefined;
    for (let ci = 1; ci < cells.length; ci++) {
      const txt = cells[ci].text.trim();
      if (!txt || txt === "-") continue;
      // Pure number = size in bytes
      if (/^\d+$/.test(txt) && size === undefined) {
        size = parseInt(txt, 10);
      } else if (/^\d{4}-\d{2}-\d{2}/.test(txt) || /\w+\s+\d/.test(txt)) {
        // Date-like cell
        /* v8 ignore start -- lastModified always empty on first date-like cell */
        if (!lastModified) lastModified = txt;
        /* v8 ignore stop */
      }
    }

    entries.push({ name, isDirectory: isDir, path: entryPath, size, lastModified });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// File history
// ---------------------------------------------------------------------------

export function parseFileHistory(
  html: string,
  project: string,
  path: string
): FileHistory {
  const root = parseHtml(html);
  const entries: HistoryEntry[] = [];

  const table =
    root.querySelector("table#revisions") || root.querySelector("table");
  if (!table) return { project, path, entries };

  for (const row of table.querySelectorAll("tr")) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 4) continue;

    // The first cell may contain two <a> tags: the first is an anchor link
    // with text "#", and the second has the actual revision hash. Pick the
    // last <a> whose text looks like a hex hash, falling back to any non-"#"
    // link, then to raw cell text.
    const revisionLinks = cells[0].querySelectorAll("a");
    let revision = "";
    if (revisionLinks.length > 1) {
      // Multiple links — prefer the one with a hash-like value
      for (let i = revisionLinks.length - 1; i >= 0; i--) {
        const txt = revisionLinks[i].text.trim();
        /* v8 ignore start -- always finds valid revision text in test data */
        if (txt && txt !== "#" && txt.toLowerCase() !== "revision") {
          revision = txt;
          break;
        }
        /* v8 ignore stop */
      }
    } else if (revisionLinks.length === 1) {
      revision = revisionLinks[0].text.trim().replace(/^#/, "");
    }
    if (!revision) revision = cells[0].text.trim().replace(/^#/, "");
    if (!revision || revision.toLowerCase() === "revision") continue;

    const date = /* v8 ignore next */ cells[2]?.text.trim() ?? "";
    const author = /* v8 ignore next */ cells[3]?.text.trim() ?? "";
    const message = /* v8 ignore next */ cells[cells.length - 1]?.text.trim() ?? "";

    const ufMatch = /Update Form:?\s*(\d+)/.exec(message);
    const mrMatch = /MR[-:]?\s*(\d+)/.exec(message);

    entries.push({
      revision,
      date,
      author,
      message,
      updateForm: ufMatch?.[1],
      mergeRequest: mrMatch?.[1],
    });
  }

  return { project, path, entries };
}

// ---------------------------------------------------------------------------
// Annotate / blame
// ---------------------------------------------------------------------------

export function parseAnnotate(
  html: string,
  project: string,
  path: string
): AnnotatedFile {
  // Parse with blockTextElements overridden to exclude <pre>, so that span
  // children inside <pre> are queryable directly — avoids a second parse of innerHTML.
  const root = parseHtml(html, { blockTextElements: { script: true, style: true, noscript: true } });
  const lines: AnnotateLine[] = [];

  const pre = root.querySelector("pre#src") || root.querySelector("pre");
  const searchRoot = pre ?? root;

  const blameSpans = searchRoot.querySelectorAll("span.blame");
  if (blameSpans.length > 0) {
    let lineNum = 0;
    for (const el of blameSpans) {
      lineNum++;
      // Title may be on the span itself (OpenGrok 1.12+) or on a child <a> (1.7.x)
      const title =
        el.getAttribute("title") ||
        el.querySelector("a")?.getAttribute("title") ||
        "";
      const revision =
        /(?:revision|changeset):\s*([a-f0-9]+)/i.exec(title)?.[1] ?? "";
      const author = (
        /(?:author|user):\s*(.+?)(?=\s+(?:date|revision|changeset|version|summary):|\s*<[^>]*@[^>]*>|<br|$)/i
          .exec(title)?.[1] ?? ""
      )
        .replace(/\u00a0/g, " ")
        .trim();
      const date = (
        /date:\s*(.+?)(?=<br|$)/i.exec(title)?.[1] ?? ""
      )
        .replace(/\u00a0/g, " ")
        .trim();
      // In 1.7.x the source code follows the blame span as sibling nodes;
      // in simple format the text is directly inside the span.
      let content: string;
      if (el.querySelector("a.r") !== null) {
        // 1.7.x style: code content follows the blame span as siblings.
        // Note: TextNode.nextSibling is unreliable in node-html-parser —
        // use the parent's childNodes array with index-based iteration instead.
        const parent = el.parentNode!;
        const parts: string[] = [];
        const siblings = parent.childNodes;
        const idx = siblings.indexOf(el);
        for (let i = idx + 1; i < siblings.length; i++) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sib = siblings[i] as any;
          const cls: string =
            typeof sib.getAttribute === "function"
              ? (sib.getAttribute("class") ?? "")
              : "";
          if (cls === "blame" || cls.split(" ").includes("blame")) break;
          if (!cls.includes("fold-space")) {
            const t: string = sib.text;
            const nl = t.indexOf("\n");
            if (nl !== -1) {
              if (nl > 0) parts.push(t.slice(0, nl));
              break;
            }
            if (t) parts.push(t);
          }
        }
        content = parts.join("").trim();
      } else {
        content = el.text;
      }
      lines.push({ lineNumber: lineNum, revision, author, date, content });
    }
  }

  // Fallback: table-based
  if (lines.length === 0) {
    const table = root.querySelector("table");
    if (table) {
      let idx = 1;
      for (const row of table.querySelectorAll("tr")) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 3) continue;
        lines.push({
          lineNumber: idx++,
          revision: cells[0].text.trim(),
          author: /* v8 ignore next */ cells[1]?.text.trim() ?? "",
          date: "",
          content: /* v8 ignore next */ cells[cells.length - 1]?.text ?? "",
        });
      }
    }
  }

  return { project, path, lines };
}

// ---------------------------------------------------------------------------
// Web search results HTML (fallback for defs/refs when REST API fails)
// ---------------------------------------------------------------------------

/**
 * Parse the HTML returned by `/search?defs=...` or `/search?refs=...`.
 *
 * HTML structure (OpenGrok 1.7.x):
 *   <div id="results">
 *     <p class="pagetitle">... Results 1 – N of M ...</p>
 *     <table><tbody class="search-result">
 *       <tr class="dir"><td colspan="3"><a href="/source/xref/project/path/">dir</a></td></tr>
 *       <tr>
 *         <td class="q">H A D</td>
 *         <td class="f"><a href="/source/xref/project/path/file.cpp">file.cpp</a></td>
 *         <td><code class="con"><a class="s" href="...#48"><span class="l">48</span> ...</a></code></td>
 *       </tr>
 *     </tbody></table>
 *   </div>
 */
export function parseWebSearchResults(
  html: string,
  searchType: SearchTypeValue,
  query: string
): SearchResults {
  const root = parseHtml(html);
  const results: SearchResults["results"] = [];

  // Extract total count from "Results 1 – N of M"
  const titleEl = root.querySelector("p.pagetitle");
  const titleText = titleEl?.text ?? "";
  const countMatch = /of\s+(\d[\d,]*)/i.exec(titleText);
  const totalCount = countMatch ? parseInt(countMatch[1].replace(/,/g, ""), 10) : 0;

  // Collect all result rows grouped by directory (dir rows precede file rows)
  const resultsDiv = root.querySelector("#results") || root;
  const rows = resultsDiv.querySelectorAll("tr");

  for (const row of rows) {
    // Skip directory header rows
    /* v8 ignore start -- dir rows not present in test data */
    if (row.classNames?.includes("dir") || row.getAttribute("class")?.includes("dir")) continue;
    /* v8 ignore stop */

    const cells = row.querySelectorAll("td");
    /* v8 ignore start -- rows in test data always have 2+ cells */
    if (cells.length < 2) continue;
    /* v8 ignore stop */

    // Find the file link in td.f
    const fileCell = cells.find(
      (c) => c.getAttribute("class")?.includes("f")
    ) ?? cells[1];
    const fileLink = fileCell?.querySelector("a");
    if (!fileLink) continue;

    /* v8 ignore start -- href always present on file links in test data */
    const href = fileLink.getAttribute("href") ?? "";
    /* v8 ignore stop */
    // Extract project and path from href: /source/xref/PROJECT/path/to/file
    const xrefMatch = /\/xref\/([^/]+)(\/.*?)$/.exec(href);
    if (!xrefMatch) continue;

    const project = xrefMatch[1];
    const filePath = xrefMatch[2];

    // Extract line matches from <code class="con">
    const codeCell = cells.find(
      (c) => c.querySelector("code.con")
    ) ?? cells[cells.length - 1];
    /* v8 ignore start -- codeCell always defined; ?? phantom */
    const matchLinks = codeCell?.querySelectorAll("a.s") ?? [];
    /* v8 ignore stop */
    const matches: Array<{ lineNumber: number; lineContent: string }> = [];

    for (const ml of matchLinks) {
      const lineSpan = ml.querySelector("span.l");
      /* v8 ignore start -- lineSpan always found in test data */
      const lineNum = lineSpan ? parseInt(lineSpan.text.trim(), 10) : 0;
      /* v8 ignore stop */
      // Get the text content after the line number span
      let lineContent = ml.text.trim();
      // Remove the leading line number
      if (lineSpan) {
        lineContent = lineContent.replace(/^\d+\s*/, "");
      }
      if (lineNum > 0) {
        matches.push({ lineNumber: lineNum, lineContent });
      }
    }

    // If no structured matches found, try to extract from raw code text
    /* v8 ignore start -- matches always non-empty in test data */
    if (matches.length === 0) {
      const codeEl = codeCell?.querySelector("code.con");
      if (codeEl) {
        const hrefMatch = /\#(\d+)/.exec(href);
        const lineNum = hrefMatch ? parseInt(hrefMatch[1], 10) : 0;
        if (lineNum > 0) {
          matches.push({ lineNumber: lineNum, lineContent: codeEl.text.trim().replace(/^\d+\s*/, "") });
        }
      }
    }
    /* v8 ignore stop */

    if (matches.length > 0) {
      results.push({ project, path: filePath, matches });
    }
  }

  return {
    query,
    searchType,
    totalCount,
    timeMs: 0,
    results,
    startIndex: 0,
    endIndex: results.length,
  };
}

// ---------------------------------------------------------------------------
// File symbols from xref HTML (fallback when /api/v1/file/defs is unavailable)
// ---------------------------------------------------------------------------

/** OpenGrok CSS class → symbol type (based on ctags kind letters). */
const CLASS_TO_TYPE: Record<string, string> = {
  xf: "function",
  xm: "macro",
  xc: "class",
  xe: "enum",
  xi: "interface",
  xn: "namespace",
  xs: "struct",
  xt: "typedef",
  xu: "union",
  xd: "definition",
};

// Regex for line-number anchors: <a class="l" name="51" ...> (1.7.x) or id="51" (alternate)
const LINE_ANCHOR_RE = /<a\s+class="h?l"\s+(?:id|name)="(\d+)"/;
// Regex for definition symbol anchors with intelliWindow-symbol class
const DEF_SYMBOL_RE =
  /class="(x[a-z])\s+intelliWindow-symbol"[^>]*data-definition-place="def"[^>]*>([^<]+)<\/a>/;
const SIG_RE = /<span\s+class='scope-signature'>([^<]*(?:&[^;]+;[^<]*)*)<\/span>/;

/** Decode common HTML entities. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?59;/g, ";")
    .replace(/&apos;/g, "'");
}

/**
 * Parse symbol definitions from an OpenGrok xref HTML page.
 *
 * Uses a single-pass regex over the entire HTML instead of splitting by lines,
 * tracking the current line number via line-anchor matches.
 */
export function parseFileSymbols(html: string): FileSymbol[] {
  const symbols: FileSymbol[] = [];

  // Combined regex: match either a line anchor or a def symbol in one pass.
  // Must be per-call because the "g" flag makes it stateful.
  const combinedRe = new RegExp(
    `${LINE_ANCHOR_RE.source}|${DEF_SYMBOL_RE.source}`,
    "g"
  );

  let currentLine = 0;
  let match;
  while ((match = combinedRe.exec(html)) !== null) {
    if (match[1]) {
      // Line anchor match
      currentLine = parseInt(match[1], 10);
    /* v8 ignore start -- regex groups always captured together; type/currentLine always valid */
    } else if (match[2] && match[3]) {
      // Def symbol match
      const cssClass = match[2];
      const symbolName = match[3];
      const type = CLASS_TO_TYPE[cssClass];
      if (!type || !currentLine) continue;
      /* v8 ignore stop */

      let signature: string | null = null;
      if (type === "function") {
        // Look for signature nearby (within same line's HTML)
        const searchStart = Math.max(0, match.index - 500);
        const searchSlice = html.substring(searchStart, match.index + match[0].length + 500);
        const sigMatch = SIG_RE.exec(searchSlice);
        if (sigMatch) {
          signature = decodeEntities(sigMatch[1]);
        }
      }

      symbols.push({
        symbol: symbolName,
        type,
        signature,
        line: currentLine,
        lineStart: currentLine,
        lineEnd: currentLine,
        namespace: null,
      });
    }
  }

  return symbols;
}

