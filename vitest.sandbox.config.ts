/**
 * Vitest configuration for sandbox tests.
 * Used by `npm run test:sandbox` after `npm run compile`.
 * Sandbox tests are excluded from the main vitest.config.ts because
 * worker_threads cannot load .ts sources directly (issue #10).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __VERSION__: JSON.stringify('test'),
  },
  test: {
    include: ['src/tests/sandbox.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
