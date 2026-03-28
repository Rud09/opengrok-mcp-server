/**
 * Tests for Tasks 4.13, 4.14, 4.16:
 * - 4.13: Request Origin Validation
 * - 4.14: Credential Rotation Warnings
 * - 4.16: Tasks API for opengrok_execute
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseAllowedClientIds, checkCredentialAge, updateCredentialRotationTimestamp, getConfigDirectory, resetConfig } from "../server/config.js";
import * as taskRegistry from "../server/task-registry.js";

// ---------------------------------------------------------------------------
// Task 4.13: Request Origin Validation
// ---------------------------------------------------------------------------

describe("Task 4.13 — parseAllowedClientIds", () => {
  it("returns empty array for empty string", () => {
    expect(parseAllowedClientIds("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseAllowedClientIds("   ")).toEqual([]);
  });

  it("parses comma-separated client IDs", () => {
    const ids = parseAllowedClientIds("client1,client2,client3");
    expect(ids).toEqual(["client1", "client2", "client3"]);
  });

  it("trims whitespace from each client ID", () => {
    const ids = parseAllowedClientIds("  client1 , client2  , client3 ");
    expect(ids).toEqual(["client1", "client2", "client3"]);
  });

  it("filters out empty strings after trimming", () => {
    const ids = parseAllowedClientIds("client1,,client2");
    expect(ids).toEqual(["client1", "client2"]);
  });

  it("handles single client ID", () => {
    expect(parseAllowedClientIds("onlyClient")).toEqual(["onlyClient"]);
  });
});

// ---------------------------------------------------------------------------
// Task 4.14: Credential Rotation Warnings
// ---------------------------------------------------------------------------

describe("Task 4.14 — Credential Age Checking", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opengrok-test-"));
  });

  afterEach(() => {
    // Clean up temp directory (recursively)
    const removeDir = (dir: string): void => {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            removeDir(filePath);
          } else {
            fs.unlinkSync(filePath);
          }
        }
        fs.rmdirSync(dir);
      }
    };
    removeDir(tmpDir);
  });

  it("returns null if state file doesn't exist", () => {
    const warning = checkCredentialAge(tmpDir);
    expect(warning).toBeNull();
  });

  it("returns null if credentials are recent (< 90 days)", () => {
    const stateFile = path.join(tmpDir, "last-credential-rotation.json");
    const recentDate = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    fs.writeFileSync(stateFile, JSON.stringify({ rotatedAt: recentDate }));

    const warning = checkCredentialAge(tmpDir);
    expect(warning).toBeNull();
  });

  it("returns warning if credentials are stale (> 90 days)", () => {
    const stateFile = path.join(tmpDir, "last-credential-rotation.json");
    const oldDate = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
    fs.writeFileSync(stateFile, JSON.stringify({ rotatedAt: oldDate }));

    const warning = checkCredentialAge(tmpDir);
    expect(warning).toBeTruthy();
    expect(warning).toMatch(/Credentials not rotated in \d+ days/);
  });

  it("updateCredentialRotationTimestamp creates config directory", () => {
    const testDir = path.join(tmpDir, "new-config-dir");
    expect(fs.existsSync(testDir)).toBe(false);

    updateCredentialRotationTimestamp(testDir);

    expect(fs.existsSync(testDir)).toBe(true);
    const stateFile = path.join(testDir, "last-credential-rotation.json");
    expect(fs.existsSync(stateFile)).toBe(true);
  });

  it("updateCredentialRotationTimestamp writes ISO timestamp", () => {
    const stateFile = path.join(tmpDir, "last-credential-rotation.json");
    updateCredentialRotationTimestamp(tmpDir);

    const content = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(content.rotatedAt).toBeTruthy();
    expect(new Date(content.rotatedAt).getTime()).toBeGreaterThan(0);
  });

  it("getConfigDirectory respects XDG_CONFIG_HOME", () => {
    const originalXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = "/custom/config";
      const dir = getConfigDirectory();
      expect(dir).toBe("/custom/config/opengrok-mcp");
    } finally {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
  });

  it("getConfigDirectory uses HOME/.config as fallback", () => {
    const originalXdg = process.env.XDG_CONFIG_HOME;
    const originalHome = process.env.HOME;
    try {
      delete process.env.XDG_CONFIG_HOME;
      process.env.HOME = "/home/testuser";
      const dir = getConfigDirectory();
      expect(dir).toBe("/home/testuser/.config/opengrok-mcp");
    } finally {
      process.env.XDG_CONFIG_HOME = originalXdg;
      process.env.HOME = originalHome;
    }
  });
});

// ---------------------------------------------------------------------------
// Task 4.16: Task Registry for opengrok_execute
// ---------------------------------------------------------------------------

describe("Task 4.16 — Task Registry", () => {
  beforeEach(() => {
    taskRegistry.clearAllTasks();
  });

  it("createTask returns a unique task ID", () => {
    const taskId1 = taskRegistry.createTask();
    const taskId2 = taskRegistry.createTask();
    expect(taskId1).toBeTruthy();
    expect(taskId2).toBeTruthy();
    expect(taskId1).not.toBe(taskId2);
  });

  it("createTask returns running status", () => {
    const taskId = taskRegistry.createTask();
    const task = taskRegistry.getTask(taskId);
    expect(task).toBeTruthy();
    expect(task?.status).toBe("running");
    expect(task?.createdAt).toBeGreaterThan(0);
  });

  it("getTask returns null for non-existent task", () => {
    const task = taskRegistry.getTask("non-existent-task-id");
    expect(task).toBeNull();
  });

  it("completeTask updates task status and result", () => {
    const taskId = taskRegistry.createTask();
    const result = JSON.stringify({ answer: 42 });
    taskRegistry.completeTask(taskId, result);

    const task = taskRegistry.getTask(taskId);
    expect(task?.status).toBe("completed");
    expect(task?.result).toBe(result);
    expect(task?.completedAt).toBeGreaterThan(0);
  });

  it("failTask updates task status and error", () => {
    const taskId = taskRegistry.createTask();
    const errorMsg = "Something went wrong";
    taskRegistry.failTask(taskId, errorMsg);

    const task = taskRegistry.getTask(taskId);
    expect(task?.status).toBe("error");
    expect(task?.error).toBe(errorMsg);
    expect(task?.completedAt).toBeGreaterThan(0);
  });

  it("listTasks returns all active tasks", () => {
    const task1 = taskRegistry.createTask();
    const task2 = taskRegistry.createTask();
    taskRegistry.completeTask(task2, "done");

    const tasks = taskRegistry.listTasks();
    expect(tasks.length).toBe(2);
    expect(tasks.some((t) => t.taskId === task1 && t.status === "running")).toBe(true);
    expect(tasks.some((t) => t.taskId === task2 && t.status === "completed")).toBe(true);
  });

  it("clearAllTasks removes all tasks", () => {
    taskRegistry.createTask();
    taskRegistry.createTask();
    expect(taskRegistry.listTasks().length).toBe(2);

    taskRegistry.clearAllTasks();
    expect(taskRegistry.listTasks().length).toBe(0);
  });

  it("getTask returns null and removes a running task stuck for >30 minutes", () => {
    const taskId = taskRegistry.createTask();
    // Simulate 31 minutes in the future (past MAX_RUNNING_AGE_MS = 30 min)
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60 * 1000);
    const result = taskRegistry.getTask(taskId);
    expect(result).toBeNull();
    vi.restoreAllMocks();
  });

  it("getTask returns null and removes a completed task past TTL", () => {
    const taskId = taskRegistry.createTask();
    taskRegistry.completeTask(taskId, "done");
    // Simulate 61 minutes in the future (past TASK_TTL_MS = 1 hour)
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60 * 1000);
    const result = taskRegistry.getTask(taskId);
    expect(result).toBeNull();
    vi.restoreAllMocks();
  });

  it("listTasks prunes completed tasks past TTL", () => {
    const taskId = taskRegistry.createTask();
    taskRegistry.completeTask(taskId, "done");
    // Simulate 61 minutes in the future (past TASK_TTL_MS = 1 hour)
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60 * 1000);
    const tasks = taskRegistry.listTasks();
    expect(tasks.find((t) => t.taskId === taskId)).toBeUndefined();
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Integration: Config loading with credential tracking
// ---------------------------------------------------------------------------

describe("Config loading with credential tracking", () => {
  beforeEach(() => {
    resetConfig();
    process.env.OPENGROK_BASE_URL = "https://opengrok.test/source/";
  });

  afterEach(() => {
    resetConfig();
    delete process.env.OPENGROK_BASE_URL;
    delete process.env.OPENGROK_ALLOWED_CLIENT_IDS;
  });

  it("config includes OPENGROK_ALLOWED_CLIENT_IDS field", async () => {
    const { loadConfig } = await import("../server/config.js");
    const config = loadConfig();
    expect(config.OPENGROK_ALLOWED_CLIENT_IDS).toBe(""); // default empty
  });

  it("config parses OPENGROK_ALLOWED_CLIENT_IDS from environment", async () => {
    process.env.OPENGROK_ALLOWED_CLIENT_IDS = "client1,client2";
    resetConfig();
    const { loadConfig } = await import("../server/config.js");
    const config = loadConfig();
    expect(config.OPENGROK_ALLOWED_CLIENT_IDS).toBe("client1,client2");
  });
});
