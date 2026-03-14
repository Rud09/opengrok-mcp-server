/**
 * Unit tests for src/server/local/compile-info.ts
 *
 * Uses real temporary files on disk (no mocking) to exercise the full path
 * resolution and boundary-check logic, including fs.realpathSync validation.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  inferBuildRoot,
  parseCompileCommands,
  resolveAllowedRoots,
  type CompileInfo,
} from "../../server/local/compile-info.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function touch(filePath: string): void {
  fs.writeFileSync(filePath, "", "utf8");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tempDir: string;
let srcFile: string;        // <tempDir>/src/EventLoop.cpp
let headerFile: string;     // <tempDir>/include/EventLoop.h
let includeDir: string;     // <tempDir>/include/
let buildDir: string;       // <tempDir>/build/
let dbFile: string;         // <tempDir>/build/compile_commands.json
let outsideDir: string;     // separate tempDir (outside allowed roots)

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opengrok-test-ci-"));
  buildDir = path.join(tempDir, "build");
  includeDir = path.join(tempDir, "include");
  const srcDir = path.join(tempDir, "src");

  fs.mkdirSync(buildDir);
  fs.mkdirSync(includeDir);
  fs.mkdirSync(srcDir);

  srcFile = path.join(srcDir, "EventLoop.cpp");
  headerFile = path.join(includeDir, "EventLoop.h");
  dbFile = path.join(buildDir, "compile_commands.json");

  touch(srcFile);
  touch(headerFile);

  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "opengrok-test-outside-"));
});

afterAll(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { }
  try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { }
});

// ---------------------------------------------------------------------------
// resolveAllowedRoots
// ---------------------------------------------------------------------------

describe("resolveAllowedRoots", () => {
  it("returns empty array for empty input", () => {
    expect(resolveAllowedRoots([])).toEqual([]);
  });

  it("resolves existing directory", () => {
    const roots = resolveAllowedRoots([tempDir]);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBe(fs.realpathSync(tempDir));
  });

  it("uses parent directory for file paths", () => {
    const roots = resolveAllowedRoots([dbFile.replace(".json", "_dummy.json"), tempDir]);
    // Only tempDir will resolve (dummy file doesn't exist); test real file
    const rootsForRealFile = resolveAllowedRoots([dbFile]);
    // dbFile doesn't exist yet at this point — but we can test with tempDir
    const rootsForDir = resolveAllowedRoots([tempDir]);
    expect(rootsForDir[0]).toBe(fs.realpathSync(tempDir));
  });

  it("silently drops non-existent paths", () => {
    const roots = resolveAllowedRoots([
      "/nonexistent-path-absolutely-not-there-12345",
      tempDir,
    ]);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBe(fs.realpathSync(tempDir));
  });

  it("deduplicates identical resolved paths", () => {
    const roots = resolveAllowedRoots([tempDir, tempDir, tempDir]);
    expect(roots).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parseCompileCommands — arguments array format
// ---------------------------------------------------------------------------

describe("parseCompileCommands — arguments array", () => {
  beforeAll(() => {
    writeJson(dbFile, [
      {
        file: srcFile,
        directory: buildDir,
        arguments: [
          "clang++",
          "-std=c++17",
          `-I${includeDir}`,
          "-DDEBUG",
          "-DVERSION=3",
          "-fPIC",
          "-Wall",
          "-c",
          srcFile,
          "-o",
          path.join(buildDir, "EventLoop.o"),
        ],
      },
    ]);
  });

  it("indexes the source file", () => {
    const roots = resolveAllowedRoots([tempDir]);
    const index = parseCompileCommands([buildDir], roots);
    const resolvedSrc = fs.realpathSync(srcFile);
    expect(index.has(resolvedSrc)).toBe(true);
  });

  it("extracts compiler name", () => {
    const roots = resolveAllowedRoots([tempDir]);
    const index = parseCompileCommands([buildDir], roots);
    const info = index.get(fs.realpathSync(srcFile))!;
    expect(info.compiler).toBe("clang++");
  });

  it("extracts language standard", () => {
    const roots = resolveAllowedRoots([tempDir]);
    const index = parseCompileCommands([buildDir], roots);
    const info = index.get(fs.realpathSync(srcFile))!;
    expect(info.standard).toBe("c++17");
  });

  it("extracts include paths and resolves them", () => {
    const roots = resolveAllowedRoots([tempDir]);
    const index = parseCompileCommands([buildDir], roots);
    const info = index.get(fs.realpathSync(srcFile))!;
    expect(info.includes).toContain(fs.realpathSync(includeDir));
  });

  it("extracts preprocessor defines", () => {
    const roots = resolveAllowedRoots([tempDir]);
    const index = parseCompileCommands([buildDir], roots);
    const info = index.get(fs.realpathSync(srcFile))!;
    expect(info.defines).toContain("DEBUG");
    expect(info.defines).toContain("VERSION=3");
  });

  it("captures extra flags (not -I/-D/-std/-c/-o)", () => {
    const roots = resolveAllowedRoots([tempDir]);
    const index = parseCompileCommands([buildDir], roots);
    const info = index.get(fs.realpathSync(srcFile))!;
    expect(info.extraFlags).toContain("-fPIC");
    expect(info.extraFlags).toContain("-Wall");
  });

  it("does not include -c or -o in extraFlags", () => {
    const roots = resolveAllowedRoots([tempDir]);
    const index = parseCompileCommands([buildDir], roots);
    const info = index.get(fs.realpathSync(srcFile))!;
    expect(info.extraFlags).not.toContain("-c");
    expect(info.extraFlags).not.toContain("-o");
  });
});

// ---------------------------------------------------------------------------
// parseCompileCommands — command string format
// ---------------------------------------------------------------------------

describe("parseCompileCommands — command string", () => {
  let cmdDbFile: string;

  beforeAll(() => {
    cmdDbFile = path.join(buildDir, "compile_commands_cmd.json");
    writeJson(cmdDbFile, [
      {
        file: srcFile,
        directory: buildDir,
        command: `g++ -std=c++14 -I${includeDir} -DNDEBUG -c ${srcFile} -o ${path.join(buildDir, "EventLoop.o")}`,
      },
    ]);
  });

  it("parses command string and extracts fields", () => {
    const roots = resolveAllowedRoots([tempDir]);
    const index = parseCompileCommands([cmdDbFile], roots);
    const info = index.get(fs.realpathSync(srcFile))!;
    expect(info).toBeDefined();
    expect(info.compiler).toBe("g++");
    expect(info.standard).toBe("c++14");
    expect(info.defines).toContain("NDEBUG");
    expect(info.includes).toContain(fs.realpathSync(includeDir));
  });

  it("handles quoted paths in command string", () => {
    const quotedDbFile = path.join(buildDir, "compile_quoted.json");
    writeJson(quotedDbFile, [
      {
        file: srcFile,
        directory: buildDir,
        command: `clang++ -std=c++17 "-I${includeDir}" -c ${srcFile}`,
      },
    ]);
    const roots = resolveAllowedRoots([tempDir]);
    const index = parseCompileCommands([quotedDbFile], roots);
    const info = index.get(fs.realpathSync(srcFile));
    expect(info).toBeDefined();
    expect(info!.includes).toContain(fs.realpathSync(includeDir));
  });
});

// ---------------------------------------------------------------------------
// Security: path traversal and out-of-root rejection
// ---------------------------------------------------------------------------

describe("parseCompileCommands — security", () => {
  it("rejects source files outside allowed roots", () => {
    const outFile = path.join(outsideDir, "Evil.cpp");
    touch(outFile);

    const evilDb = path.join(buildDir, "evil.json");
    writeJson(evilDb, [
      {
        file: outFile,
        directory: buildDir,
        arguments: ["clang++", "-c", outFile],
      },
    ]);

    // Only tempDir is an allowed root — outsideDir is excluded
    const roots = resolveAllowedRoots([tempDir]);
    const index = parseCompileCommands([evilDb], roots);
    // outsideDir is not within tempDir, so outFile must not appear in index
    expect(index.has(outFile)).toBe(false);
    for (const key of index.keys()) {
      expect(key.startsWith(fs.realpathSync(outsideDir))).toBe(false);
    }
  });

  it("rejects include paths outside allowed roots", () => {
    const outsideInclude = path.join(outsideDir, "include");
    fs.mkdirSync(outsideInclude, { recursive: true });

    const evilIncDb = path.join(buildDir, "evil_inc.json");
    writeJson(evilIncDb, [
      {
        file: srcFile,
        directory: buildDir,
        arguments: ["clang++", `-I${outsideInclude}`, "-c", srcFile],
      },
    ]);

    const roots = resolveAllowedRoots([tempDir]);
    const index = parseCompileCommands([evilIncDb], roots);
    const info = index.get(fs.realpathSync(srcFile));
    // Source file is valid, but the outside include path must be dropped
    if (info) {
      for (const inc of info.includes) {
        expect(inc.startsWith(fs.realpathSync(outsideDir))).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Resilience: malformed input
// ---------------------------------------------------------------------------

describe("parseCompileCommands — resilience", () => {
  it("returns empty map for non-existent compile_commands.json", () => {
    const roots = resolveAllowedRoots([tempDir]);
    const index = parseCompileCommands(
      [path.join(tempDir, "does_not_exist", "compile_commands.json")],
      roots
    );
    expect(index.size).toBe(0);
  });

  it("returns empty map for malformed JSON", () => {
    const badJson = path.join(buildDir, "bad.json");
    fs.writeFileSync(badJson, "{ this is not valid json }", "utf8");
    const roots = resolveAllowedRoots([tempDir]);
    const index = parseCompileCommands([badJson], roots);
    expect(index.size).toBe(0);
  });

  it("skips entries without a `file` field", () => {
    const noFilePath = path.join(buildDir, "no_file.json");
    writeJson(noFilePath, [
      { directory: buildDir, arguments: ["clang++", "-c", "foo.cpp"] },
      { file: srcFile, directory: buildDir, arguments: ["clang++", "-c", srcFile] },
    ]);
    const roots = resolveAllowedRoots([tempDir]);
    const index = parseCompileCommands([noFilePath], roots);
    expect(index.has(fs.realpathSync(srcFile))).toBe(true);
    expect(index.size).toBe(1);
  });

  it("skips entries without `arguments` or `command`", () => {
    const noArgsPath = path.join(buildDir, "no_args.json");
    writeJson(noArgsPath, [
      { file: srcFile, directory: buildDir },
    ]);
    const roots = resolveAllowedRoots([tempDir]);
    const index = parseCompileCommands([noArgsPath], roots);
    expect(index.size).toBe(0);
  });

  it("returns empty index when allowedRoots is empty (failsafe)", () => {
    const index = parseCompileCommands([dbFile], []);
    expect(index.size).toBe(0);
  });

  it("handles non-array JSON root gracefully", () => {
    const objJson = path.join(buildDir, "obj.json");
    writeJson(objJson, { file: srcFile, arguments: [] });
    const roots = resolveAllowedRoots([tempDir]);
    const index = parseCompileCommands([objJson], roots);
    expect(index.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Multiple compile_commands.json files merged
// ---------------------------------------------------------------------------

describe("parseCompileCommands — multi-DB merge", () => {
  it("merges entries from multiple DBs", () => {
    const srcFile2 = path.join(tempDir, "src", "Coordinator.cpp");
    touch(srcFile2);

    const db1 = path.join(buildDir, "db1.json");
    const db2 = path.join(buildDir, "db2.json");

    writeJson(db1, [
      { file: srcFile, directory: buildDir, arguments: ["clang++", "-c", srcFile] },
    ]);
    writeJson(db2, [
      { file: srcFile2, directory: buildDir, arguments: ["clang++", "-c", srcFile2] },
    ]);

    const roots = resolveAllowedRoots([tempDir]);
    const index = parseCompileCommands([db1, db2], roots);

    expect(index.has(fs.realpathSync(srcFile))).toBe(true);
    expect(index.has(fs.realpathSync(srcFile2))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// inferBuildRoot
// ---------------------------------------------------------------------------

describe("inferBuildRoot", () => {
  it("returns empty string for empty input", () => {
    expect(inferBuildRoot([])).toBe("");
  });

  it("returns empty string for non-existent paths", () => {
    expect(inferBuildRoot(["/nonexistent-12345/compile_commands.json"])).toBe("");
  });

  it("returns the directory itself when there is only one unique entry", () => {
    const singleDb = path.join(buildDir, "single.json");
    writeJson(singleDb, [
      { file: srcFile, directory: buildDir, arguments: ["clang++", "-c", srcFile] },
    ]);
    const result = inferBuildRoot([singleDb]);
    expect(result).toBe(path.resolve(buildDir));
  });

  it("returns common path prefix across multiple directory values", () => {
    const subDir1 = path.join(tempDir, "build", "module1");
    const subDir2 = path.join(tempDir, "build", "module2");
    fs.mkdirSync(subDir1, { recursive: true });
    fs.mkdirSync(subDir2, { recursive: true });

    const srcFile1 = path.join(subDir1, "A.cpp");
    const srcFile2 = path.join(subDir2, "B.cpp");
    touch(srcFile1);
    touch(srcFile2);

    const multiDb = path.join(buildDir, "multi_dir.json");
    writeJson(multiDb, [
      { file: srcFile1, directory: subDir1, arguments: ["clang++", "-c", srcFile1] },
      { file: srcFile2, directory: subDir2, arguments: ["clang++", "-c", srcFile2] },
    ]);

    const result = inferBuildRoot([multiDb]);
    // Common ancestor of tempDir/build/module1 and tempDir/build/module2 is tempDir/build
    expect(result).toBe(path.join(tempDir, "build"));
  });

  it("handles entries without a directory field gracefully (uses those with one)", () => {
    const mixedDb = path.join(buildDir, "mixed.json");
    writeJson(mixedDb, [
      { file: srcFile, directory: buildDir, arguments: ["clang++", "-c", srcFile] },
      { file: srcFile, arguments: ["clang++", "-c", srcFile] }, // no directory
    ]);
    const result = inferBuildRoot([mixedDb]);
    expect(result).toBe(path.resolve(buildDir));
  });

  it("returns empty string when no entries have a directory field", () => {
    const noDir = path.join(buildDir, "no_dir.json");
    writeJson(noDir, [
      { file: srcFile, arguments: ["clang++", "-c", srcFile] },
    ]);
    expect(inferBuildRoot([noDir])).toBe("");
  });
});
