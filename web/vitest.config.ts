import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    // Screen tests on jsdom are slow under load (Pi, parallel builds): extra time,
    // the checks are not weakened.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
