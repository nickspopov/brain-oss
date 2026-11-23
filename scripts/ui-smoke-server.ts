// Server for the Playwright UI smoke: the real app on a temporary
// data directory, the built web/dist, the acceptance-test world (fixtures.ts) and a little content
// for the screens. The port is fixed because the server checks Origin against BRAIN_ORIGIN (CSRF).
// State (the world's test tokens) is written to the SMOKE_STATE file: the smoke writes "as the agent" via REST
// to set up a conflict and proposals. These are throwaway test tokens, not secrets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { buildWorld } from '../test/helpers/fixtures.js';
import type { Harness } from '../test/helpers/harness.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SMOKE_PORT ?? '7471');
const statePath = process.env.SMOKE_STATE ?? path.join(os.tmpdir(), `brain-smoke-${port}.json`);
/** The smoke projects (desktop and phone) work with different documents on the same server. */
const projects = (process.env.SMOKE_PROJECTS ?? 'desktop,phone').split(',');
const webDir = path.join(root, 'web', 'dist');
if (!fs.existsSync(path.join(webDir, 'index.html'))) {
  console.error(`ui-smoke-server: ${webDir}/index.html is missing: run \`npm run build:web\` first`);
  process.exit(1);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-smoke-'));
const origin = `http://127.0.0.1:${port}`;
const config = loadConfig({
  BRAIN_DEV: '1',
  BRAIN_HOST: '127.0.0.1',
  BRAIN_PORT: String(port),
  BRAIN_ORIGIN: origin,
  BRAIN_DATA_DIR: dataDir,
  BRAIN_WEB_DIR: webDir,
  BRAIN_LOG_LEVEL: 'warn',
  BRAIN_BACKGROUND: '0',
  BRAIN_RATE_WRITE: '100000',
  BRAIN_RATE_READ: '100000',
  BRAIN_RATE_SEARCH: '100000',
  BRAIN_RATE_AUTH_FAIL: '100000',
});
const app = createApp(config);
// The world is built with core functions right away; agents write the content via REST after listen.
const w = buildWorld({ core: app.core, url: origin, config } as unknown as Harness);
// Readiness for Playwright (webServer.url): 503 until seeding is done. The address is under /api/ so
// that UI serving doesn't answer it with index.html.
let ready = false;
app.server.get('/api/smoke-ready', async (_req, reply) => reply.code(ready ? 200 : 503).send({ ready }));

async function seed(): Promise<void> {
  w.grant('recipes', { principal: 'alice-helper' }, 'write');
  const hermes = w.client('alice-helper');
  await hermes.call('write', { space: 'shared', path: 'welcome.md', content: '# Welcome\n\nShared team knowledge.\n', message: 'first note' });
  // A non-admin edit in an executable space: "needs attention".
  await hermes.call('write', { space: 'recipes', path: 'soup.md', content: '# Soup\n\nSimmer for 20 minutes.\n', message: 'soup recipe' });
  for (const p of projects) {
    await hermes.call('write', { space: 'shared', path: `smoke-${p}.md`, content: `# Document ${p}\n\nFirst version.\n`, message: 'create' });
    const plan = await hermes.call<{ doc: { rev: number } }>('write', { space: 'shared', path: `plan-${p}.md`, content: `# Plan ${p}\n\nstep 1\n`, message: 'plan' });
    await hermes.call('propose', { space: 'shared', path: `plan-${p}.md`, content: `# Plan ${p}\n\nstep 1\nstep 2\n`, base_rev: plan.doc.rev, message: `add a step (${p})` });
  }
  fs.writeFileSync(statePath, JSON.stringify({ origin, tokens: { 'alice-assistant': w.tokens['alice-assistant'] } }), { mode: 0o600 });
}

async function shutdown(): Promise<void> {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(statePath, { force: true });
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.server.listen({ host: '127.0.0.1', port });
await seed();
ready = true;
console.log(`ui-smoke-server: ${origin}`);
