import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __VERSION__: JSON.stringify('test'),
  },
  test: {
    include: ['src/tests/**/*.test.ts'],
    exclude: ['src/tests/sandbox.test.ts'], // requires compiled build (npm run test:sandbox)
    environment: 'node',
    env: {
      // Match the original 16 KB capResponse limit that existing server.test.ts expects.
      // (The previous-session server.ts made capResponse budget-dependent; this pins
      // the default at generous/16 KB to keep existing tests passing.)
      OPENGROK_MAX_RESPONSE_BYTES: '16384',
    },
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary', 'json', 'cobertura'],
      include: ['src/server/**/*.ts'],
      exclude: [
        'src/tests/**',
        // Sandbox files require a compiled worker — coverage is measured by npm run test:sandbox
        'src/server/sandbox.ts',
        'src/server/sandbox-worker.ts',
        // Pure TypeScript interface re-exports — no runtime statements to measure
        'src/server/api-types.ts',
        // CLI entry points require terminal/system interaction — tested via integration
        'src/server/cli/**',
      ],
      thresholds: {
        lines: 89,
        branches: 89,
        functions: 89,
        statements: 89,
      },
    },
  },
});
