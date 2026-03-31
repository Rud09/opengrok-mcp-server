import { describe, it, expect } from 'vitest';

// We'll import the server module to get tool definitions
// Since tools are registered dynamically, we test via the exported TOOL_DEFS map

describe('tool description length constraints', () => {
  // Import all tool description strings from server.ts
  it('all tool descriptions must exist and be ≤120 characters', async () => {
    const { TOOL_DEFS } = await import('../server/server.js');
    for (const [name, def] of Object.entries(TOOL_DEFS)) {
      const desc = def.description ?? '';
      expect(
        desc.length,
        `${name}: description is ${desc.length} chars (max 120): "${desc}"`
      ).toBeLessThanOrEqual(120);
      expect(desc.length, `${name}: description is empty`).toBeGreaterThan(0);
    }
  });

  it('all parameter descriptions must be ≤80 characters', async () => {
    const { TOOL_DEFS } = await import('../server/server.js');
    for (const [toolName, def] of Object.entries(TOOL_DEFS)) {
      const params = def.parameters ?? {};
      for (const [paramName, paramDef] of Object.entries(params as Record<string, { description?: string }>)) {
        const desc = paramDef.description ?? '';
        expect(
          desc.length,
          `${toolName}.${paramName}: param description ${desc.length} chars (max 80): "${desc}"`
        ).toBeLessThanOrEqual(80);
      }
    }
  });

  it('no tool description contains verbose information phrases', async () => {
    const { TOOL_DEFS } = await import('../server/server.js');
    const forbidden = ['When to use', 'When not to use', 'Args:', 'Example:', 'Examples:', 'Returns:'];
    for (const [name, def] of Object.entries(TOOL_DEFS)) {
      const desc = def.description ?? '';
      for (const phrase of forbidden) {
        expect(desc, `${name} contains "${phrase}"`).not.toContain(phrase);
      }
    }
  });
});
