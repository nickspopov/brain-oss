import { defineConfig } from 'vitest/config';

// The Pi under parallel load (neighbouring builds): integration tests start the real app
// and spawn processes (CLI, brain-mcp), so the time limits are generous. The checks are no weaker for it.
// The memory perf test (test/perf) runs separately: `npm run test:perf` (vitest.perf.config.ts), not in ci.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/perf/**', 'node_modules/**'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});
