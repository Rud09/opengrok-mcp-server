---
name: opengrok-session
description: >
  Session lifecycle management for OpenGrok MCP investigations. Use this skill
  to understand how to start, maintain, and complete an OpenGrok session with
  proper memory bank state management. Trigger at session start when you know
  an investigation will span multiple turns, or when restoring a prior session.
---

# OpenGrok Session Skill

Session lifecycle and memory management for multi-turn OpenGrok investigations.

## Session Startup Protocol

As of v7.0, memory status is **auto-injected** into the server instructions at startup — you can see byte counts and file previews without calling `opengrok_memory_status` first.

```
Step 1: Read injected {{MEMORY_STATUS}} in SERVER_INSTRUCTIONS
  → Memory state (bytes, stub/populated/empty) is already visible

Step 2 (if active-task.md has content):
  opengrok_read_memory { filename: "active-task.md" }
  → Restore task state, last symbol/file, open questions

Step 3 (if investigation-log.md has content):
  opengrok_read_memory { filename: "investigation-log.md" }
  → Review recent findings (auto-compressed if large)

Step 4: Acknowledge state
  → Tell user: "Resuming investigation: [task]. Last worked on: [last_symbol]"
  → OR: "Starting fresh — no prior investigation state"
```

Call `opengrok_memory_status` explicitly only if you need up-to-date byte counts mid-session.

## Mandatory Write Before Answer

**Before EVERY final answer or summary:**

```json
{
  "tool": "opengrok_update_memory",
  "arguments": {
    "filename": "active-task.md",
    "content": "task: <what was investigated>\nstarted: <date>\nlast_symbol: <last symbol>\nlast_file: <last file>\nnext_step: <follow-up if any>\nopen_questions: []\nstatus: complete",
    "mode": "overwrite"
  }
}
```

This is non-negotiable. The LLM that picks up the next session needs this context.

## Multi-Session Pattern

```
Session 1: Investigate → Write findings → Update active-task.md (status: blocked)
Session 2: Read memory → Resume from last state → Continue investigation
Session 3: Read memory → Confirm root cause → Update active-task.md (status: complete)
```

## VS Code Memory Integration

| What to store | Where |
|--------------|-------|
| Architecture overview, key directories | VS Code `/memory` (auto-loads) |
| Coding conventions, naming patterns | VS Code `/memory` (auto-loads) |
| Current bug investigation state | `active-task.md` (OpenGrok memory) |
| What you searched and found | `investigation-log.md` (OpenGrok memory) |

Never duplicate general codebase knowledge in OpenGrok memory — it costs tokens on every session start.

## Non-VS Code Clients

- **Claude Code:** General codebase context goes in `.claude.md` in the project root (auto-loaded)
- **Cursor:** Use `.cursorrules` for project conventions
- **Claude.ai:** Use Projects for persistent context
