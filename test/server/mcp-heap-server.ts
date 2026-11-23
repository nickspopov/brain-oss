// Server for the big-batch heap test in test/server/read-limits-audit-growth-ttl.test.ts: the real app in a separate
// process with the same heap as `npm start` (--max-old-space-size from package.json), so that running
// out of memory crashes that process, not vitest. Prints one JSON line: the address and the tokens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { setGrant } from '../../src/core/grants.js';
import { createPrincipal, createSuperadmin } from '../../src/core/principals.js';
import { createSpace } from '../../src/core/spaces.js';
import { issueToken } from '../../src/core/tokens.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-heap-'));
const config = loadConfig({
  BRAIN_DEV: '1',
  BRAIN_DATA_DIR: dataDir,
  BRAIN_PORT: '0',
  BRAIN_LOG_LEVEL: 'silent',
  BRAIN_BACKGROUND: '0',
  BRAIN_WEB_DIR: '',
  // Call limits do not get in the way (30 reads fit the defaults too); the byte budget is the default.
});
const app = createApp(config);
const core = app.core;
const alice = createSuperadmin(core, 'alice', 'correct-horse-battery-staple', 'Alice');
const agent = createPrincipal(core, { name: 'writer', kind: 'agent', trust: 'limited', ownerId: alice.id }, alice.id);
const space = createSpace(core, { slug: 'shared', name: 'Shared' }, alice.id);
setGrant(core, { spaceId: space.id, scope: 'space', pathPrefix: null, docId: null, role: 'write', subjectType: 'principal', subjectId: agent.id }, alice.id);
const token = issueToken(core, agent.id, { label: 'heap test', createdBy: alice.id }).token;

await app.server.listen({ host: '127.0.0.1', port: 0 });
const addr = app.server.server.address();
if (!addr || typeof addr === 'string') throw new Error('no address');
process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${addr.port}`, token, pid: process.pid }) + '\n');

const stop = async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
