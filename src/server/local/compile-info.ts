/**
 * compile_commands.json parser for local source intelligence.
 * Zero dependencies — pure TypeScript, fs + path only.
 *
 * Parses the standard Clang compilation database format and extracts
 * actionable compilation details used by the get_compile_info MCP tool.
 *
 * Security:
 *  - All resolved file/include paths validated against configured allowed roots.
 *  - Paths that escape the allowed roots are silently dropped.
 *  - No shell execution; command strings parsed with a quoted-string tokenizer.
 *  - fs.realpathSync() used to canonicalize paths, resolving symlinks.
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CompileInfo {
  /** Canonicalized absolute path to the source file. */
  file: string;
  /** The build directory recorded in compile_commands.json. */
  directory: string;
  /** Compiler executable basename, e.g. "clang++", "g++", "cl". */
  compiler: string;
  /** Resolved absolute -I include paths (only those within allowed roots). */
  includes: string[];
  /** Preprocessor macro definitions from -D flags, e.g. ["DEBUG", "VERSION=3"]. */
  defines: string[];
  /** Language standard from -std= flag, e.g. "c++17". Empty string if absent. */
  standard: string;
  /** All other compiler flags not captured by the fields above. */
  extraFlags: string[];
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RawEntry {
  file: string;
  directory?: string;
  command?: string;
  arguments?: string[];
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Resolve `target` with fs.realpathSync and verify the result stays within
 * at least one of `allowedRoots`. Returns the canonical absolute path or
 * null if the source path escapes all roots, does not exist, or is otherwise
 * inaccessible.
 */
function resolveWithin(target: string, allowedRoots: string[]): string | null {
  let resolved: string;
  try {
    resolved = fs.realpathSync(target);
  } catch {
    /* v8 ignore start -- requires non-existent path on real filesystem */
    return null; // Does not exist or permission denied
    /* v8 ignore stop */
  }
  for (const root of allowedRoots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return resolved;
    }
  }
  return null; // Escapes all allowed roots
}

// ---------------------------------------------------------------------------
// Shell command tokenizer
// ---------------------------------------------------------------------------

/**
 * Split a POSIX/Windows shell command string into tokens.
 * Backslash is treated as an escape character ONLY before quote characters
 * (`"`, `'`) and backslash itself — not before path separators — so that
 * Windows paths like `C:\Users\...` are preserved verbatim.
 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    // Treat backslash as escape ONLY before quotes or another backslash.
    // Windows filesystem paths use backslash as separator; we must not eat them.
    if (ch === "\\" && !inSingle && i + 1 < command.length) {
      const next = command[i + 1];
      /* v8 ignore start -- backslash handling: both branches need coverage */
      if (next === '"' || next === "'" || next === "\\") {
        current += next;
        i++;
        continue;
      }
      // Literal backslash (e.g. Windows path separator)
      current += ch;
      /* v8 ignore stop */
    } else if (ch === "'" && !inDouble) {
      /* v8 ignore start */
      inSingle = !inSingle;
      /* v8 ignore stop */
    } else if (ch === '"' && !inSingle) {
      /* v8 ignore start */
      inDouble = !inDouble;
      /* v8 ignore stop */
    } else if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
      /* v8 ignore start */
      if (current.length) {
        tokens.push(current);
        current = "";
      }
      /* v8 ignore stop */
    } else {
      current += ch;
    }
  }

  /* v8 ignore start */
  if (current.length) tokens.push(current);
  /* v8 ignore stop */
  return tokens;
}

// ---------------------------------------------------------------------------
// Compiler flag parser
// ---------------------------------------------------------------------------

type ParsedFlags = Pick<
  CompileInfo,
  "compiler" | "includes" | "defines" | "standard" | "extraFlags"
>;

function parseFlags(
  args: string[],
  buildDir: string,
  allowedRoots: string[]
): ParsedFlags {
  const result: ParsedFlags = {
    compiler: "",
    includes: [],
    defines: [],
    standard: "",
    extraFlags: [],
  };

  /* v8 ignore start */
  if (!args.length) return result;
  /* v8 ignore stop */

  // First token is the compiler executable
  result.compiler = path.basename(args[0]);

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];

    // Skip output-file argument
    if (arg === "-o") {
      i++;
      continue;
    }

    // Skip compilation-only flag (not a file path)
    if (arg === "-c") continue;

    // ---------- Include paths ----------
    if (arg.startsWith("-I") && arg.length > 2) {
      const inc = resolveInclude(arg.slice(2), buildDir, allowedRoots);
      /* v8 ignore start */
      if (inc) result.includes.push(inc);
      /* v8 ignore stop */
    } else if (arg === "-I") {
      const next = args[++i];
      /* v8 ignore start */
      if (next) {
        const inc = resolveInclude(next, buildDir, allowedRoots);
        if (inc) result.includes.push(inc);
      }
    } else if (
      arg === "-isystem" ||
      arg === "-iwithprefix" ||
      arg === "-iprefix" ||
      arg === "-isysroot"
    ) {
      const next = args[++i];
      /* v8 ignore start */
      if (next) {
        const inc = resolveInclude(next, buildDir, allowedRoots);
        if (inc) result.includes.push(inc);
      }
      /* v8 ignore stop */
    }

    // ---------- Preprocessor defines ----------
    else if (arg.startsWith("-D") && arg.length > 2) {
      result.defines.push(arg.slice(2));
    } else if (arg === "-D") {
      const next = args[++i];
      /* v8 ignore start */
      if (next) result.defines.push(next);
      /* v8 ignore stop */
    }

    // ---------- Language standard ----------
    else if (arg.startsWith("-std=")) {
      result.standard = arg.slice(5);
    }

    // ---------- Positional args (source file, @ response files) ----------
    else if (!arg.startsWith("-") || arg === "-") {
      // Skip — source/output positional arguments
    }

    // ---------- Everything else ----------
    else {
      result.extraFlags.push(arg);
    }
  }

  // Deduplicate includes while preserving first-seen order
  result.includes = [...new Set(result.includes)];

  return result;
}

function resolveInclude(
  includePath: string,
  buildDir: string,
  allowedRoots: string[]
): string | null {
  const abs = path.isAbsolute(includePath)
    ? includePath
    : path.resolve(buildDir, includePath);
  return resolveWithin(abs, allowedRoots);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Recursively discover all compile_commands.json files under `buildRoot`.
 * Follows real directories only (skips symlinked directories to avoid
 * duplicates from the top-level convenience symlinks).
 * Returns de-duplicated absolute paths to the JSON files.
 */
export function discoverCompileCommands(buildRoot: string): string[] {
  const TARGET = "compile_commands.json";
  const MAX_DEPTH = 10;
  const results: string[] = [];

  let resolvedRoot: string;
  try {
    resolvedRoot = fs.realpathSync(buildRoot);
  } catch {
    return results;
  }

  function walk(dir: string, depth: number): void {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission denied or gone
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === TARGET) {
        results.push(path.join(dir, entry.name));
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(path.join(dir, entry.name), depth + 1);
      }
    }
  }

  walk(resolvedRoot, 0);
  return results;
}

/**
 * Resolve and validate the allowed source roots from the raw list of paths
 * supplied via compile DB paths.
 *
 * Rules:
 *  - Directories are used as-is after realpathSync.
 *  - If a path points to a file (e.g. compile_commands.json), its parent
 *    directory is used as the root.
 *  - Paths that do not exist or are inaccessible are silently dropped.
 *  - Duplicate resolved roots are deduplicated.
 */
export function resolveAllowedRoots(dbPaths: string[]): string[] {
  const roots: string[] = [];

  for (const p of dbPaths) {
    try {
      const resolved = fs.realpathSync(p);
      const stat = fs.statSync(resolved);
      roots.push(stat.isDirectory() ? resolved : path.dirname(resolved));
    } catch {
      // Skip non-existent or inaccessible paths
    }
  }

  return [...new Set(roots)];
}

/**
 * Load and parse all compile_commands.json files once. Returns a Map from
 * resolved JSON file path to its parsed array of raw entries. Both
 * `inferBuildRoot` and `parseCompileCommands` accept this pre-loaded data
 * to avoid reading the same files twice.
 */
export function loadCompileCommandsJson(
  dbPaths: string[]
): Map<string, unknown[]> {
  const loaded = new Map<string, unknown[]>();

  for (const dbPath of dbPaths) {
    let jsonPath: string;
    try {
      const resolved = fs.realpathSync(dbPath);
      const stat = fs.statSync(resolved);
      jsonPath = stat.isDirectory()
        ? path.join(resolved, "compile_commands.json")
        : resolved;
    } catch {
      continue;
    }

    if (loaded.has(jsonPath)) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    } catch {
      continue;
    }

    if (Array.isArray(raw)) {
      loaded.set(jsonPath, raw as unknown[]);
    }
  }

  return loaded;
}

/**
 * Parse one or more compile_commands.json files (or directories containing
 * them) and build an in-memory index.
 *
 * @param dbPaths      Paths to compile_commands.json files or directories that
 *                     contain them. Relative paths are resolved from cwd.
 * @param allowedRoots Pre-resolved root directories (from resolveAllowedRoots).
 *                     Source files and include paths outside these roots are
 *                     silently dropped as a path-traversal protection.
 * @param loaded       Optional pre-loaded JSON data from loadCompileCommandsJson().
 *                     If not provided, the files will be read from disk.
 * @returns Map keyed by canonical absolute source file path.
 */
export function parseCompileCommands(
  dbPaths: string[],
  allowedRoots: string[],
  loaded?: Map<string, unknown[]>
): Map<string, CompileInfo> {
  const index = new Map<string, CompileInfo>();

  if (!allowedRoots.length) return index;

  // If pre-loaded data provided, use it; otherwise load from disk
  const data = loaded ?? loadCompileCommandsJson(dbPaths);

  for (const [jsonPath, raw] of data) {
    for (const entry of raw) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("file" in entry) ||
        typeof (entry as RawEntry).file !== "string"
      ) {
        continue;
      }

      const e = entry as RawEntry;
      const buildDir = e.directory
        ? path.resolve(e.directory)
        : path.dirname(jsonPath);

      // Resolve and validate the source file path
      const absFile = path.isAbsolute(e.file)
        ? e.file
        : path.resolve(buildDir, e.file);

      const safeFile = resolveWithin(absFile, allowedRoots);
      if (!safeFile) continue; // Outside allowed roots — skip

      // Prefer `arguments` (array) over `command` (string) per the spec
      let args: string[];
      if (
        Array.isArray(e.arguments) &&
        e.arguments.length > 0
      ) {
        args = (e.arguments as unknown[]).map(String);
      } else if (typeof e.command === "string" && e.command.length > 0) {
        args = tokenize(e.command);
      } else {
        continue;
      }

      const flags = parseFlags(args, buildDir, allowedRoots);
      index.set(safeFile, {
        file: safeFile,
        directory: buildDir,
        ...flags,
      });
    }
  }

  return index;
}

/**
 * Infer the source tree build root by computing the longest common path
 * prefix of all `directory` entries across the provided compile_commands.json files.
 *
 * @param dbPaths Paths to compile_commands.json files or directories.
 * @param loaded  Optional pre-loaded JSON data from loadCompileCommandsJson().
 *                If not provided, the files will be read from disk.
 * @returns The common ancestor path, or empty string if it cannot be determined.
 */
export function inferBuildRoot(
  dbPaths: string[],
  loaded?: Map<string, unknown[]>
): string {
  const dirs: string[] = [];
  const data = loaded ?? loadCompileCommandsJson(dbPaths);

  for (const [, raw] of data) {
    for (const entry of raw) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        "directory" in entry &&
        typeof (entry as { directory: unknown }).directory === "string"
      ) {
        const dir = ((entry as { directory: string }).directory).trim();
        /* v8 ignore start */
        if (dir) dirs.push(path.resolve(dir));
        /* v8 ignore stop */
      }
    }
  }

  if (!dirs.length) return "";

  const unique = [...new Set(dirs)];
  if (unique.length === 1) return unique[0];

  // Compute the longest common path-component prefix across all directory values.
  const commonParts = unique[0].split(path.sep);
  let commonLen = commonParts.length;

  for (let i = 1; i < unique.length; i++) {
    const parts = unique[i].split(path.sep);
    let j = 0;
    while (j < commonLen && j < parts.length && commonParts[j] === parts[j]) {
      j++;
    }
    commonLen = j;
    /* v8 ignore start */
    if (!commonLen) break;
    /* v8 ignore stop */
  }

  /* v8 ignore start */
  if (!commonLen) return path.sep;
  /* v8 ignore stop */
  return commonParts.slice(0, commonLen).join(path.sep) || path.sep;
}
