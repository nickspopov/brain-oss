import { defineConfig } from 'vitest/config';

// Perf tests (test/perf): long-running and sensitive to machine load, hence outside `npm run ci`.
// Run: `npm run test:perf`. Thresholds: RSS < 300 MB and others.
export default defineConfig({
  test: {
    include: ['test/perf/**/*.test.ts'],
    environment: 'node',
    testTimeout: 1_800_000,
    hookTimeout: 600_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
