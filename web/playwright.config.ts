// Playwright UI smoke: the real server with the built web/dist, the system
// Chromium (Playwright browsers are not downloaded), desktop and a 390-wide phone.
// Run: `npm run build && npm run smoke` in web/ (in `npm run ci`, after the build).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

// A port of its own for each run (parallel builds on one machine don't get in each other's way); the main
// process picks it, workers inherit it via env.
const PORT = Number(process.env.SMOKE_PORT ?? String(20000 + (process.pid % 20000)));
process.env.SMOKE_PORT = String(PORT);
// The config is read by both the main process and the workers: the main one sets the path, workers inherit it via env.
const STATE = process.env.SMOKE_STATE ?? path.join(os.tmpdir(), `brain-smoke-${PORT}-${process.pid}.json`);
process.env.SMOKE_STATE = STATE;

/** Browser: BRAIN_CHROMIUM, otherwise the system Chromium; without a browser the smoke fails with a clear reason. */
function chromium(): string | undefined {
  const fromEnv = process.env.BRAIN_CHROMIUM;
  if (fromEnv) return fromEnv;
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    if (fs.existsSync(p)) return p;
  }
  return undefined; // the Playwright browser, if installed (`npx playwright install chromium`)
}

const executablePath = chromium();

export default defineConfig({
  testDir: 'smoke',
  // Extra time under load (Pi, parallel builds); the checks are no weaker for it.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'en-US',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
  webServer: {
    command: 'npx tsx scripts/ui-smoke-server.ts',
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/api/smoke-ready`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { SMOKE_PORT: String(PORT), SMOKE_STATE: STATE, SMOKE_PROJECTS: 'desktop,phone' },
  },
});
