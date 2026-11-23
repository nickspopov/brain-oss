// Screenshot tour: not a test suite, a repeatable walk through every screen of the
// UI on a demo instance (scripts/screenshots-server.ts). Run it with `npm run screenshots` from the
// repository root; PNGs and INDEX.md land in artifacts/screenshots/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.SHOTS_PORT ?? String(21000 + (process.pid % 20000)));
process.env.SHOTS_PORT = String(PORT);
const STATE = process.env.SHOTS_STATE ?? path.join(os.tmpdir(), `brain-shots-${PORT}-${process.pid}.json`);
process.env.SHOTS_STATE = STATE;
process.env.SHOTS_OUT ??= path.resolve(import.meta.dirname, '..', 'artifacts', 'screenshots');

/**
 * Browser: PLAYWRIGHT_CHROMIUM_EXECUTABLE or BRAIN_CHROMIUM, else an installed system Chromium
 * (the Debian wrapper, or the binary itself in /usr/lib/chromium on Raspberry Pi OS), else
 * Playwright's own if installed (`npx playwright install chromium`).
 */
function chromium(): string | undefined {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? process.env.BRAIN_CHROMIUM;
  if (fromEnv) return fromEnv;
  const candidates = [
    '/usr/bin/chromium',
    '/usr/lib/chromium/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((p) => fs.existsSync(p));
}
const executablePath = chromium();

export default defineConfig({
  testDir: 'screenshots',
  globalSetup: './screenshots/setup.ts',
  timeout: 900_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/screenshots',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'npx tsx scripts/screenshots-server.ts',
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/api/shots-ready`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { SHOTS_PORT: String(PORT), SHOTS_STATE: STATE },
  },
});
