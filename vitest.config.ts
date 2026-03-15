import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __VERSION__: JSON.stringify('test'),
  },
  test: {
    include: ['src/tests/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary', 'json', 'cobertura'],
      include: ['src/server/**/*.ts'],
      exclude: ['src/tests/**'],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
      },
    },
  },
});
