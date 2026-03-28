/**
 * Tests for RBAC (Role-Based Access Control) for multi-user HTTP deployments (Task 5.10)
 */
import { describe, it, expect } from "vitest";
import { parseRbacConfig, hasPermission, type Role } from "../server/rbac.js";

// ---------------------------------------------------------------------------
// Unit tests for RBAC functions
// ---------------------------------------------------------------------------

describe("RBAC — parseRbacConfig", () => {
  it("parses single entry", () => {
    const config = parseRbacConfig("token1:admin");
    expect(config.tokens.size).toBe(1);
    expect(config.tokens.get("token1")).toBe("admin");
  });

  it("parses multiple entries", () => {
    const config = parseRbacConfig("token1:admin,token2:developer,token3:readonly");
    expect(config.tokens.size).toBe(3);
    expect(config.tokens.get("token1")).toBe("admin");
    expect(config.tokens.get("token2")).toBe("developer");
    expect(config.tokens.get("token3")).toBe("readonly");
  });

  it("ignores invalid role entries", () => {
    const config = parseRbacConfig("token1:admin,token2:invalid,token3:readonly");
    expect(config.tokens.size).toBe(2);
    expect(config.tokens.get("token1")).toBe("admin");
    expect(config.tokens.get("token2")).toBeUndefined();
    expect(config.tokens.get("token3")).toBe("readonly");
  });

  it("ignores malformed entries", () => {
    const config = parseRbacConfig("token1:admin,malformed,token3:readonly");
    expect(config.tokens.size).toBe(2);
    expect(config.tokens.get("token1")).toBe("admin");
    expect(config.tokens.get("token3")).toBe("readonly");
  });

  it("handles empty string", () => {
    const config = parseRbacConfig("");
    expect(config.tokens.size).toBe(0);
  });

  it("handles undefined", () => {
    const config = parseRbacConfig(undefined);
    expect(config.tokens.size).toBe(0);
  });

  it("trims whitespace around tokens and roles", () => {
    const config = parseRbacConfig("  token1  :  admin  ,  token2  :  developer  ");
    expect(config.tokens.size).toBe(2);
    expect(config.tokens.get("token1")).toBe("admin");
    expect(config.tokens.get("token2")).toBe("developer");
  });

  it("silently skips empty entries", () => {
    const config = parseRbacConfig("token1:admin,,token2:developer,");
    expect(config.tokens.size).toBe(2);
    expect(config.tokens.get("token1")).toBe("admin");
    expect(config.tokens.get("token2")).toBe("developer");
  });
});

describe("RBAC — hasPermission", () => {
  it("admin has permission for all tools", () => {
    expect(hasPermission("admin", "opengrok_search")).toBe(true);
    expect(hasPermission("admin", "opengrok_update_memory")).toBe(true);
    expect(hasPermission("admin", "opengrok_execute")).toBe(true);
    expect(hasPermission("admin", "unknown_tool")).toBe(true);
  });

  it("developer has explicit allow-list (no wildcard)", () => {
    expect(hasPermission("developer", "opengrok_search")).toBe(true);
    expect(hasPermission("developer", "opengrok_execute")).toBe(true);
    expect(hasPermission("developer", "opengrok_search_code")).toBe(true);
    expect(hasPermission("developer", "unknown_tool")).toBe(false);
  });

  it("readonly has permission only for read-only tools", () => {
    expect(hasPermission("readonly", "opengrok_search")).toBe(true);
    expect(hasPermission("readonly", "opengrok_search_code")).toBe(true);
    expect(hasPermission("readonly", "opengrok_get_file_content")).toBe(true);
    expect(hasPermission("readonly", "opengrok_get_file_history")).toBe(true);
    expect(hasPermission("readonly", "opengrok_get_symbol_info")).toBe(true);
    expect(hasPermission("readonly", "opengrok_blame")).toBe(true);
    expect(hasPermission("readonly", "opengrok_what_changed")).toBe(true);
    expect(hasPermission("readonly", "opengrok_index_health")).toBe(true);
  });

  it("readonly blocked from write/execute tools", () => {
    expect(hasPermission("readonly", "opengrok_update_memory")).toBe(false);
    expect(hasPermission("readonly", "opengrok_execute")).toBe(false);
    expect(hasPermission("readonly", "opengrok_batch_search")).toBe(false);
    expect(hasPermission("readonly", "opengrok_dependency_map")).toBe(false);
    expect(hasPermission("readonly", "opengrok_call_graph")).toBe(false);
    expect(hasPermission("readonly", "opengrok_read_memory")).toBe(false);
  });

  it("developer allowed on all developer tools", () => {
    const devTools = [
      "opengrok_search",
      "opengrok_search_code",
      "opengrok_get_file_content",
      "opengrok_get_file_history",
      "opengrok_get_symbol_info",
      "opengrok_batch_search",
      "opengrok_what_changed",
      "opengrok_blame",
      "opengrok_dependency_map",
      "opengrok_search_pattern",
      "opengrok_index_health",
      "opengrok_memory_status",
      "opengrok_read_memory",
      "opengrok_update_memory",
      "opengrok_execute",
      "opengrok_call_graph",
    ];
    for (const tool of devTools) {
      expect(hasPermission("developer", tool)).toBe(true);
    }
  });

  it("returns false for unknown tool names on readonly", () => {
    expect(hasPermission("readonly", "opengrok_nonexistent")).toBe(false);
    expect(hasPermission("readonly", "arbitrary_string")).toBe(false);
  });

  it("returns true for unknown tool names on admin", () => {
    expect(hasPermission("admin", "opengrok_nonexistent")).toBe(true);
    expect(hasPermission("admin", "arbitrary_string")).toBe(true);
  });
});
