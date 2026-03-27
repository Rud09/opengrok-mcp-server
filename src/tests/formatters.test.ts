import { describe, it, expect } from 'vitest';
import {
  formatSearchResults,
  formatFileContent,
  formatFileHistory,
  formatDirectoryListing,
  formatProjectsList,
  formatAnnotate,
  formatBatchSearchResults,
  formatSearchAndRead,
  formatSymbolContext,
  formatFileSymbols,
} from '../server/formatters.js';
import type { SearchAndReadEntry, SymbolContextResult } from '../server/formatters.js';
import type {
  SearchResults,
  FileContent,
  FileHistory,
  DirectoryEntry,
  Project,
  AnnotatedFile,
  FileSymbols,
} from '../server/models.js';

// ---------------------------------------------------------------------------
// formatSearchResults
// ---------------------------------------------------------------------------

describe('formatSearchResults', () => {
  const mockResults: SearchResults = {
    query: 'WeatherStation',
    searchType: 'full',
    totalCount: 2,
    timeMs: 42,
    results: [
      {
        project: 'release-2.x',
        path: '/path/to/file.cpp',
        matches: [
          { lineNumber: 10, lineContent: 'void WeatherStation() {' },
          { lineNumber: 15, lineContent: '  // end' },
        ],
      },
    ],
    startIndex: 0,
    endIndex: 1,
  };

  it('includes the query in the header', () => {
    const output = formatSearchResults(mockResults);
    expect(output).toContain('WeatherStation');
  });

  it('includes project and path', () => {
    const output = formatSearchResults(mockResults);
    expect(output).toContain('release-2.x');
    expect(output).toContain('/path/to/file.cpp');
  });

  it('emits compact one-line-per-match format', () => {
    const output = formatSearchResults(mockResults);
    // Compact format: path (project) Lline: content — no OpenGrok links
    expect(output).toContain('/path/to/file.cpp (release-2.x) L10:');
    expect(output).not.toContain('View in OpenGrok');
  });

  it('strips HTML tags from line content', () => {
    const results: SearchResults = {
      ...mockResults,
      results: [{
        ...mockResults.results[0],
        matches: [{ lineNumber: 1, lineContent: '<b>bold</b> text' }],
      }],
    };
    const output = formatSearchResults(results);
    expect(output).not.toContain('<b>');
    expect(output).toContain('bold text');
  });

  it('decodes HTML entities (&lt; &gt; &amp; &quot; &#39;) in line content', () => {
    const results: SearchResults = {
      ...mockResults,
      results: [{
        ...mockResults.results[0],
        matches: [{ lineNumber: 1, lineContent: 'if (a &lt; b &amp;&amp; c &gt; d) return &quot;ok&#39;s&quot;;' }],
      }],
    };
    const output = formatSearchResults(results);
    expect(output).toContain('if (a < b && c > d)');
    expect(output).toContain('"ok\'s"');
  });

  it('returns no results message when results is empty', () => {
    const empty: SearchResults = { ...mockResults, results: [], totalCount: 0 };
    const output = formatSearchResults(empty);
    expect(output).toContain('No results found');
  });

  it('shows pagination note when has_more', () => {
    const paged: SearchResults = { ...mockResults, totalCount: 100, endIndex: 1 };
    const output = formatSearchResults(paged);
    expect(output).toContain('of 100 results');
  });

  it('shows search header with timing', () => {
    const output = formatSearchResults(mockResults);
    expect(output).toContain('42ms');
    expect(output).toMatch(/2.* matches/);
  });
});

// ---------------------------------------------------------------------------
// formatFileContent
// ---------------------------------------------------------------------------

describe('formatFileContent', () => {
  const mockContent: FileContent = {
    project: 'release-2.x',
    path: 'path/to/file.cpp',
    content: 'line1\nline2\nline3',
    lineCount: 3,
    sizeBytes: 17,
  };

  it('includes filename in header', () => {
    const output = formatFileContent(mockContent);
    expect(output).toContain('file.cpp');
  });

  it('includes project and size info', () => {
    const output = formatFileContent(mockContent);
    expect(output).toContain('release-2.x');
    expect(output).toContain('17');
  });

  it('uses cpp syntax highlighting for .cpp files', () => {
    const output = formatFileContent(mockContent);
    expect(output).toContain('```cpp');
  });

  it('includes line numbers when showLineNumbers=true', () => {
    const output = formatFileContent(mockContent, true);
    expect(output).toContain('file.cpp:1: line1');
    expect(output).toContain('file.cpp:2: line2');
  });
});

// ---------------------------------------------------------------------------
// formatFileHistory
// ---------------------------------------------------------------------------

describe('formatFileHistory', () => {
  const mockHistory: FileHistory = {
    project: 'release-2.x',
    path: 'path/to/file.cpp',
    entries: [
      {
        revision: 'abc12345678',
        date: '2024-01-15',
        author: 'john.doe <john@example.com>',
        message: 'Fix memory leak',
        updateForm: '58321',
      },
    ],
  };

  it('shows revision (truncated to 8 chars)', () => {
    const output = formatFileHistory(mockHistory);
    expect(output).toContain('abc12345');
    expect(output).not.toContain('abc123456789'); // not full
  });

  it('strips email from author', () => {
    const output = formatFileHistory(mockHistory);
    expect(output).toContain('john.doe');
    expect(output).not.toContain('john@example.com');
  });

  it('returns no history message for empty entries', () => {
    const empty: FileHistory = { ...mockHistory, entries: [] };
    const output = formatFileHistory(empty);
    expect(output).toContain('No history entries');
  });
});

// ---------------------------------------------------------------------------
// formatDirectoryListing
// ---------------------------------------------------------------------------

describe('formatDirectoryListing', () => {
  const entries: DirectoryEntry[] = [
    { name: 'pandora', isDirectory: true, path: 'pandora' },
    { name: 'README.md', isDirectory: false, path: 'README.md', size: 1024 },
  ];

  it('shows directories first', () => {
    const output = formatDirectoryListing(entries, 'release-2.x', '');
    const dirIdx = output.indexOf('pandora');
    const fileIdx = output.indexOf('README.md');
    expect(dirIdx).toBeLessThan(fileIdx);
  });

  it('shows DIR and FILE prefixes (no emoji)', () => {
    const output = formatDirectoryListing(entries, 'release-2.x', '');
    expect(output).toContain('DIR  pandora/');
    expect(output).toContain('FILE README.md');
    expect(output).not.toContain('📁');
    expect(output).not.toContain('📄');
  });

  it('shows file size in bytes', () => {
    const output = formatDirectoryListing(entries, 'release-2.x', '');
    // toLocaleString formats 1024 as '1,024' on most locales
    expect(output).toMatch(/1[,.]?024/);
    expect(output).toContain('bytes');
  });
});

// ---------------------------------------------------------------------------
// formatProjectsList
// ---------------------------------------------------------------------------

describe('formatProjectsList', () => {
  const projects: Project[] = [
    { name: 'release-2.x', category: 'Main' },
    { name: 'release-2.x-win', category: 'Main' },
    { name: 'v1.8-stable', category: 'Legacy' },
  ];

  it('groups by category', () => {
    const output = formatProjectsList(projects);
    expect(output).toContain('### Main');
    expect(output).toContain('### Legacy');
  });

  it('shows total count', () => {
    const output = formatProjectsList(projects);
    expect(output).toContain('3 projects');
  });
});

// ---------------------------------------------------------------------------
// formatAnnotate
// ---------------------------------------------------------------------------

describe('formatAnnotate', () => {
  const annotated: AnnotatedFile = {
    project: 'release-2.x',
    path: 'path/to/file.cpp',
    lines: [
      { lineNumber: 1, revision: 'abc1234', author: 'john', date: '2024-01-01', content: 'int x = 0;' },
      { lineNumber: 2, revision: 'def5678', author: 'jane', date: '2024-01-02', content: 'return x;' },
    ],
  };

  it('shows revision and author', () => {
    const output = formatAnnotate(annotated);
    expect(output).toContain('abc1234');
    expect(output).toContain('john');
  });

  it('truncates at 50 lines by default and shows remaining count', () => {
    const manyLines: AnnotatedFile = {
      ...annotated,
      lines: Array.from({ length: 150 }, (_, i) => ({
        lineNumber: i + 1,
        revision: 'aaa',
        author: 'x',
        date: '',
        content: `line ${i + 1}`,
      })),
    };
    const output = formatAnnotate(manyLines);
    expect(output).toContain('Showing first 50 of 150 lines');
  });

  it('respects startLine/endLine range', () => {
    const manyLines: AnnotatedFile = {
      ...annotated,
      lines: Array.from({ length: 100 }, (_, i) => ({
        lineNumber: i + 1,
        revision: 'rev' + i,
        author: 'author' + i,
        date: '',
        content: `line ${i + 1}`,
      })),
    };
    const output = formatAnnotate(manyLines, 10, 20);
    // Should contain L10 but not L1 or L21
    expect(output).toContain('L10:');
    expect(output).not.toContain('L1:');
    expect(output).not.toContain('L21:');
  });
});

// ---------------------------------------------------------------------------
// formatBatchSearchResults
// ---------------------------------------------------------------------------

describe('formatBatchSearchResults', () => {
  const mockSearchResults = {
    query: 'WeatherStation',
    searchType: 'defs',
    results: {
      query: 'WeatherStation',
      searchType: 'defs',
      totalCount: 1,
      timeMs: 10,
      startIndex: 0,
      endIndex: 1,
      results: [
        {
          project: 'release-2.x',
          path: '/src/backup.cpp',
          matches: [{ lineNumber: 5, lineContent: 'void WeatherStation() {' }],
        },
      ],
    },
  };

  it('shows batch header with query count', () => {
    const output = formatBatchSearchResults([mockSearchResults]);
    expect(output.toLowerCase()).toContain('batch');
    expect(output).toContain('WeatherStation');
  });

  it('includes matched paths', () => {
    const output = formatBatchSearchResults([mockSearchResults]);
    expect(output).toContain('/src/backup.cpp');
  });

  it('handles empty batch', () => {
    const output = formatBatchSearchResults([]);
    expect(output).toContain('0');
  });
});

// ---------------------------------------------------------------------------
// formatSearchAndRead
// ---------------------------------------------------------------------------

describe('formatSearchAndRead', () => {
  const entry: SearchAndReadEntry = {
    project: 'release-2.x',
    path: '/src/backup.cpp',
    matchLine: 10,
    context: 'void WeatherStation() {\n  return;\n}',
    lang: 'cpp',
  };

  it('shows query and total count', () => {
    const output = formatSearchAndRead('WeatherStation', 5, [entry]);
    expect(output).toContain('WeatherStation');
    expect(output).toContain('5');
  });

  it('includes file path and match line', () => {
    const output = formatSearchAndRead('WeatherStation', 5, [entry]);
    expect(output).toContain('/src/backup.cpp');
    expect(output).toContain('L10');
  });

  it('includes code context with language fence', () => {
    const output = formatSearchAndRead('WeatherStation', 5, [entry]);
    expect(output).toContain('```cpp');
    expect(output).toContain('void WeatherStation()');
  });

  it('handles empty entries', () => {
    const output = formatSearchAndRead('missing', 0, []);
    expect(output).toContain('0');
  });
});

// ---------------------------------------------------------------------------
// formatSymbolContext
// ---------------------------------------------------------------------------

describe('formatSymbolContext', () => {
  const notFoundResult: SymbolContextResult = {
    found: false,
    symbol: 'MissingClass',
    kind: 'unknown',
    references: { totalFound: 0, samples: [] },
  };

  it('reports not-found gracefully', () => {
    const output = formatSymbolContext(notFoundResult);
    expect(output).toContain('MissingClass');
    expect(output).toContain('not found');
  });

  const foundResult: SymbolContextResult = {
    found: true,
    symbol: 'WeatherStation',
    kind: 'function/method',
    definition: {
      project: 'release-2.x',
      path: '/src/backup.cpp',
      line: 10,
      context: 'void WeatherStation() { return; }',
      lang: 'cpp',
    },
    references: {
      totalFound: 3,
      samples: [
        { path: '/src/main.cpp', project: 'release-2.x', lineNumber: 42, content: 'WeatherStation();' },
      ],
    },
  };

  it('shows symbol name and kind', () => {
    const output = formatSymbolContext(foundResult);
    expect(output).toContain('WeatherStation');
    expect(output).toContain('function/method');
  });

  it('shows definition file and line', () => {
    const output = formatSymbolContext(foundResult);
    expect(output).toContain('/src/backup.cpp');
    expect(output).toContain('L10');
  });

  it('shows reference count', () => {
    const output = formatSymbolContext(foundResult);
    expect(output).toContain('3');
  });

  it('shows reference sample path', () => {
    const output = formatSymbolContext(foundResult);
    expect(output).toContain('/src/main.cpp');
    expect(output).toContain('L42');
  });

  it('omits header section when not provided', () => {
    const output = formatSymbolContext(foundResult);
    // No header property in foundResult, so no "Header:" section
    expect(output).not.toContain('Header:');
  });

  it('shows header section when provided', () => {
    const withHeader: SymbolContextResult = {
      ...foundResult,
      header: {
        project: 'release-2.x',
        path: '/src/backup.h',
        context: 'void WeatherStation();',
        lang: 'cpp',
      },
    };
    const output = formatSymbolContext(withHeader);
    expect(output).toContain('/src/backup.h');
  });
});

// ---------------------------------------------------------------------------
// formatFileSymbols
// ---------------------------------------------------------------------------

describe('formatFileSymbols', () => {
  const mockSymbols: FileSymbols = {
    project: 'release-2.x',
    path: 'TextureAtlasLoader/TextureAtlasLoader.cpp',
    symbols: [
      { symbol: 'DL_OK', type: 'macro', signature: null, line: 12, lineStart: 12, lineEnd: 12, namespace: null },
      { symbol: 'AppgPrint', type: 'function', signature: '(void)', line: 45, lineStart: 45, lineEnd: 52, namespace: null },
      { symbol: 'statbuf', type: 'struct', signature: null, line: 35, lineStart: 35, lineEnd: 40, namespace: null },
      { symbol: 'TextureAtlasLoader', type: 'function', signature: '(int argc, char** argv)', line: 210, lineStart: 210, lineEnd: 280, namespace: null },
    ],
  };

  it('includes filename and project in header', () => {
    const output = formatFileSymbols(mockSymbols);
    expect(output).toContain('TextureAtlasLoader.cpp');
    expect(output).toContain('release-2.x');
  });

  it('includes total symbol count in header', () => {
    const output = formatFileSymbols(mockSymbols);
    expect(output).toContain('4 symbols');
  });

  it('groups symbols by type', () => {
    const output = formatFileSymbols(mockSymbols);
    expect(output).toContain('function (2):');
    expect(output).toContain('macro (1):');
    expect(output).toContain('struct (1):');
  });

  it('shows line numbers for each symbol', () => {
    const output = formatFileSymbols(mockSymbols);
    expect(output).toContain('L45');
    expect(output).toContain('L210');
    expect(output).toContain('L35');
    expect(output).toContain('L12');
  });

  it('shows signature for symbols that have one', () => {
    const output = formatFileSymbols(mockSymbols);
    expect(output).toContain('(int argc, char** argv)');
    expect(output).toContain('(void)');
  });

  it('returns no-symbols message for empty list', () => {
    const empty: FileSymbols = { project: 'release-2.x', path: 'empty.cpp', symbols: [] };
    const output = formatFileSymbols(empty);
    expect(output).toContain('0 symbols');
    expect(output).toContain('No symbols found.');
  });

  it('sorts symbols by line number within each type group', () => {
    const output = formatFileSymbols(mockSymbols);
    // AppgPrint (L45) should come before TextureAtlasLoader (L210) in the function group
    // Search for the indented symbol entries (not the filename in the header)
    const appgPos = output.indexOf('  AppgPrint');
    const mysqlPos = output.indexOf('  TextureAtlasLoader');
    expect(appgPos).toBeLessThan(mysqlPos);
  });

  it('truncates long signatures at 80 characters', () => {
    const longSig = 'a'.repeat(90);
    const withLong: FileSymbols = {
      project: 'release-2.x',
      path: 'foo.cpp',
      symbols: [{ symbol: 'longFn', type: 'function', signature: longSig, line: 1, lineStart: 1, lineEnd: 10, namespace: null }],
    };
    const output = formatFileSymbols(withLong);
    expect(output).toContain('...');
    // Signature should be truncated to 77 + '...' = 80 total
    expect(output).not.toContain(longSig);
  });
});
