---
name: opengrok-investigation
description: >
  Use this skill when conducting a structured investigation into a bug, unknown
  module, or impact analysis using OpenGrok. Provides step-by-step methodology
  for systematic codebase investigation with memory-backed state management.
  Trigger when: diagnosing a bug with unknown root cause, exploring an unfamiliar
  module, tracing a call chain, or assessing the impact of a change.
---

# OpenGrok Investigation Skill

Structured investigation methodology for large codebases. Use this alongside the
`opengrok` skill for tool reference.

## Investigation Loops

### Bug Investigation Loop

```
1. Reproduce → find the failing call site via opengrok_search_code (defs/refs)
2. Trace → opengrok_get_symbol_context on key symbols
3. Hypothesize → form a root cause hypothesis
4. Validate → search for evidence (refs, history, blame)
5. Record → append to investigation-log.md with: what you searched, what you found, why it matters
6. Repeat until root cause confirmed
```

### Module Exploration Loop

```
1. Entry points → opengrok_browse_directory + opengrok_get_file_symbols on main files
2. Key abstractions → opengrok_get_symbol_context on core types/interfaces
3. Data flow → trace via refs (where is this type used?)
4. Update active-task.md → record what you learned
```

### Impact Analysis Loop

```
1. Identify the changed symbol/file
2. opengrok_get_symbol_context with max_refs: 50 → find all callers
3. For each caller module: opengrok_get_file_symbols → understand the module
4. Group by layer/component → classify impact
5. Record findings in investigation-log.md
```

## Memory Usage During Investigation

```
Session start (v7.0+):
  Memory status is auto-injected into SERVER_INSTRUCTIONS.
  1. Check {{MEMORY_STATUS}} in SERVER_INSTRUCTIONS — no tool call needed
  2. opengrok_read_memory active-task.md  — restore task if content exists

During investigation (every 3-5 finds):
  3. opengrok_update_memory investigation-log.md (append):
     ## YYYY-MM-DD HH:MM: <brief topic>
     Searched: <what>
     Found: <key finding>
     Why it matters: <significance>

Before final answer (MANDATORY):
  4. opengrok_update_memory active-task.md (overwrite):
     task: <task description>
     last_symbol: <last symbol>
     last_file: <last file>
     next_step: <next step if needed>
     status: complete
```

## Code Mode for Deep Investigations

For 5+ step investigations, switch to Code Mode — it saves 75-95% of tokens:

```javascript
// Single execute call replaces 5+ individual calls
const [defs, refs, history] = env.opengrok.batchSearch([
  { query: "BuggyFunction", searchType: "defs" },
  { query: "BuggyFunction", searchType: "refs", maxResults: 20 },
  { query: "BuggyFunction", searchType: "hist" }
]);

const defPath = defs.results[0]?.path;
const blame = defPath
  ? env.opengrok.getFileAnnotate('proj', defPath, { startLine: 1, endLine: 50 })
  : null;

return {
  definition: defPath,
  callers: refs.results.slice(0, 10).map(r => r.path),
  recentCommits: history.results.slice(0, 5).map(r => r.matches[0]?.lineContent),
  blameAuthors: [...new Set(blame?.annotations?.map(a => a.author))]
};
```
