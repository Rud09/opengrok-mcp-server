import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MemoryBank, ALLOWED_FILES } from '../server/memory-bank.js';

let tmpDir: string;
let bank: MemoryBank;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'opengrok-mb-test-'));
  bank = new MemoryBank(tmpDir);
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ensureDir
// ---------------------------------------------------------------------------

describe('MemoryBank.ensureDir', () => {
  it('creates directory and stub files', async () => {
    const newDir = path.join(tmpDir, 'sub', 'bank');
    const newBank = new MemoryBank(newDir);
    await newBank.ensureDir();
    expect(fs.existsSync(newDir)).toBe(true);
    for (const file of ALLOWED_FILES) {
      expect(fs.existsSync(path.join(newDir, file))).toBe(true);
    }
  });

  it('does not overwrite existing files', async () => {
    await bank.ensureDir();
    await bank.write('active-context.md', 'real content');
    await bank.ensureDir(); // call again
    const content = await fsp.readFile(path.join(tmpDir, 'active-context.md'), 'utf8');
    expect(content).toBe('real content');
  });
});

// ---------------------------------------------------------------------------
// read — stub detection
// ---------------------------------------------------------------------------

describe('MemoryBank.read', () => {
  it('returns undefined for stub files (contains sentinel)', async () => {
    await bank.ensureDir();
    // All stubs should return undefined
    for (const file of ALLOWED_FILES) {
      const result = await bank.read(file);
      expect(result).toBeUndefined();
    }
  });

  it('returns content for real (non-stub) files', async () => {
    await fsp.writeFile(path.join(tmpDir, 'active-context.md'), 'Real content here');
    const result = await bank.read('active-context.md');
    expect(result).toBe('Real content here');
  });

  it('returns undefined when file does not exist', async () => {
    const result = await bank.read('active-context.md');
    expect(result).toBeUndefined();
  });

  it('throws for files not in allow-list', async () => {
    await expect(bank.read('../../etc/passwd')).rejects.toThrow('allow-list');
    await expect(bank.read('unknown.md')).rejects.toThrow('allow-list');
  });
});

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

describe('MemoryBank.write', () => {
  it('overwrites file in overwrite mode', async () => {
    await bank.write('active-context.md', 'initial');
    await bank.write('active-context.md', 'updated');
    const content = await fsp.readFile(path.join(tmpDir, 'active-context.md'), 'utf8');
    expect(content).toBe('updated');
  });

  it('appends to file in append mode', async () => {
    await bank.write('active-context.md', 'line1');
    await bank.write('active-context.md', 'line2', 'append');
    const content = await fsp.readFile(path.join(tmpDir, 'active-context.md'), 'utf8');
    expect(content).toContain('line1');
    expect(content).toContain('line2');
  });

  it('strips stub sentinel when appending', async () => {
    await bank.ensureDir();
    await bank.write('active-context.md', 'new content', 'append');
    const result = await bank.read('active-context.md');
    expect(result).not.toBeUndefined();
    expect(result).not.toContain('<!-- OPENGROK_STUB');
    expect(result).toContain('new content');
  });

  it('throws for files not in allow-list', async () => {
    await expect(bank.write('evil.md', 'bad')).rejects.toThrow('allow-list');
  });

  it('creates directory if it does not exist', async () => {
    const deepDir = path.join(tmpDir, 'deep', 'bank');
    const deepBank = new MemoryBank(deepDir);
    await deepBank.write('active-context.md', 'hello');
    expect(fs.existsSync(path.join(deepDir, 'active-context.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// write — size limit for non-log files
// ---------------------------------------------------------------------------

describe('MemoryBank.write — size truncation', () => {
  it('hard-truncates non-log files at limit', async () => {
    // active-context.md limit is 4096 bytes — write > 4096
    const bigContent = 'x'.repeat(6000);
    await bank.write('active-context.md', bigContent);
    const content = await fsp.readFile(path.join(tmpDir, 'active-context.md'), 'utf8');
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(4096 + 200);
    expect(content).toContain('Truncated');
  });
});

// ---------------------------------------------------------------------------
// investigation-log.md trimming
// ---------------------------------------------------------------------------

describe('MemoryBank — investigation-log.md trimming', () => {
  it('trims oldest heading entries when over MAX_FILE_BYTES', async () => {
    // investigation-log.md limit is 32768 bytes
    // Write many entries to exceed the limit
    const entries: string[] = [];
    for (let i = 0; i < 50; i++) {
      entries.push(`## 2025-01-${String(i + 1).padStart(2, '0')}: Entry ${i + 1}\n${'x'.repeat(700)}`);
    }
    const bigContent = entries.join('\n');
    await bank.write('investigation-log.md', bigContent);
    const content = await fsp.readFile(path.join(tmpDir, 'investigation-log.md'), 'utf8');
    // Should be trimmed to fit within 32768 bytes
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(32768 + 200);
    // Should contain trim note
    expect(content).toContain('Older entries trimmed');
    // Should NOT contain the very first entry (it was trimmed)
    expect(content).not.toContain('2025-01-01: Entry 1');
  });

  it('does not trim content that fits within limit', async () => {
    const content = '## 2025-01-01: Brief entry\nShort content.';
    await bank.write('investigation-log.md', content);
    const result = await fsp.readFile(path.join(tmpDir, 'investigation-log.md'), 'utf8');
    expect(result).toBe(content);
  });

  it('handles single-section content that is too large (truncates by bytes)', async () => {
    // No H2 headings → single section → byte-truncate path
    const bigNoHeadings = 'x'.repeat(40000); // > 32768 bytes
    await bank.write('investigation-log.md', bigNoHeadings);
    const content = await fsp.readFile(path.join(tmpDir, 'investigation-log.md'), 'utf8');
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(32768 + 200);
    expect(content).toContain('Older entries trimmed');
  });
});
