/**
 * Tests for Task 4.10 (sandbox error sanitization) and Task 4.11 (audit logging).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sanitizeSandboxError } from '../server/sandbox.js';
import { auditLog } from '../server/audit.js';

// ---------------------------------------------------------------------------
// Task 4.10 — sanitizeSandboxError
// ---------------------------------------------------------------------------

describe('sanitizeSandboxError', () => {
  it('preserves short, meaningful error messages unchanged', () => {
    const msg = 'ReferenceError: foo is not defined';
    expect(sanitizeSandboxError(msg)).toBe(msg);
  });

  it('strips absolute Unix paths', () => {
    const result = sanitizeSandboxError('Cannot find module /home/user/project/node_modules/foo');
    expect(result).not.toContain('/home/user');
    expect(result).toContain('<path>');
    expect(result).toContain('Cannot find module');
  });

  it('strips stack trace lines (lines starting with "    at ")', () => {
    const error = new Error('Something went wrong');
    error.stack = `Error: Something went wrong\n    at Object.<anonymous> (/home/user/server/sandbox.ts:123:5)\n    at Module._resolveFilename (node:internal/modules/cjs/loader.js:902:15)`;
    const result = sanitizeSandboxError(error);
    expect(result).not.toMatch(/^\s+at /m);
    expect(result).toContain('Something went wrong');
  });

  it('strips node:internal module paths', () => {
    const msg = 'Error in node:internal/modules/cjs/loader.js at line 902';
    const result = sanitizeSandboxError(msg);
    expect(result).not.toContain('node:internal/modules');
    expect(result).toContain('<node-internal>');
  });

  it('handles plain Error objects', () => {
    const err = new Error('Execution failed: out of memory');
    const result = sanitizeSandboxError(err);
    expect(result).toContain('Execution failed');
    expect(result).toContain('out of memory');
  });

  it('handles unknown/null/undefined gracefully', () => {
    expect(sanitizeSandboxError(null)).toBe('Unknown sandbox error');
    expect(sanitizeSandboxError(undefined)).toBe('Unknown sandbox error');
  });

  it('handles object with message property (QuickJS-style error)', () => {
    const quickJsErr = { name: 'SyntaxError', message: 'Unexpected token }' };
    const result = sanitizeSandboxError(quickJsErr);
    expect(result).toContain('Unexpected token');
  });

  it('truncates result to 500 chars maximum', () => {
    const longMsg = 'x'.repeat(1000);
    expect(sanitizeSandboxError(longMsg).length).toBeLessThanOrEqual(500);
  });

  it('strips Windows absolute paths', () => {
    const msg = 'Cannot find C:\\Users\\user\\project\\main.js';
    const result = sanitizeSandboxError(msg);
    expect(result).not.toContain('C:\\Users\\user');
    expect(result).toContain('<path>');
  });

  it('keeps multi-line errors after stripping stack frames', () => {
    const msg = 'TypeError: Cannot read properties of undefined\n    at doThing (/home/user/src/foo.js:10:5)\n    at main (/home/user/src/bar.js:20:1)';
    const result = sanitizeSandboxError(msg);
    expect(result).toContain('TypeError');
    expect(result).not.toMatch(/at doThing/);
    expect(result).not.toMatch(/at main/);
  });
});

// ---------------------------------------------------------------------------
// Task 4.11 — auditLog
// ---------------------------------------------------------------------------

describe('auditLog', () => {
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  afterEach(() => {
    stderrSpy.mockClear();
  });

  it('writes a newline-delimited JSON entry to stderr', () => {
    auditLog({ type: 'tool_invoke', tool: 'opengrok_search_code' });
    expect(stderrSpy).toHaveBeenCalledOnce();
    const written = stderrSpy.mock.calls[0][0] as string;
    expect(written.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe('tool_invoke');
    expect(parsed.tool).toBe('opengrok_search_code');
  });

  it('includes ISO timestamp', () => {
    auditLog({ type: 'sandbox_exec' });
    const written = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.audit).toBe(true);
  });

  it('includes optional project and detail fields', () => {
    auditLog({ type: 'tool_invoke', tool: 'opengrok_search_code', project: 'myproject', detail: 'search query' });
    const written = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.project).toBe('myproject');
    expect(parsed.detail).toBe('search query');
  });

  it('caps detail at 200 chars to prevent log injection', () => {
    const longDetail = 'a'.repeat(300);
    auditLog({ type: 'rate_limited', detail: longDetail });
    const written = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed.detail.length).toBeLessThanOrEqual(200);
  });

  it('omits undefined optional fields from output', () => {
    auditLog({ type: 'config_load' });
    const written = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect('tool' in parsed).toBe(false);
    expect('project' in parsed).toBe(false);
    expect('detail' in parsed).toBe(false);
  });
});
