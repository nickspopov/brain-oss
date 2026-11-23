// CLI: brain admin create, principal create, token issue, doctor, reindex.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { setGrant } from '../../src/core/grants.js';
import { createPrincipal, findPrincipal } from '../../src/core/principals.js';
import { createSpace } from '../../src/core/spaces.js';
import { RestClient } from '../helpers/clients/rest.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TSX = path.join(ROOT, 'node_modules/.bin/tsx');
let dataDir: string;

function brain(args: string[], input?: string) {
  const r = spawnSync(TSX, [path.join(ROOT, 'src/cli.ts'), ...args], {
    env: { ...process.env, BRAIN_DATA_DIR: dataDir, BRAIN_DEV: '1', BRAIN_LOG_LEVEL: 'silent' },
    input,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-cli-'));
});
afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('brain CLI', () => {
  it('doctor on a fresh data directory creates the schema and is clean', () => {
    const r = brain(['doctor']);
    expect(r.stdout).toBe('doctor: ok\n');
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(dataDir, 'brain.db'))).toBe(true);
    expect(fs.statSync(path.join(dataDir, 'secret.key')).mode & 0o777).toBe(0o600);
  });

  it('admin create, principal create, token issue → whoami over REST', async () => {
    const admin = brain(['admin', 'create', '--name', 'alice', '--password-stdin'], 'correct-horse-battery-staple\n');
    expect(admin.code, admin.stderr).toBe(0);
    expect(admin.stdout).toMatch(/superadmin alice created/);
    expect(brain(['admin', 'create', '--name', 'shorty', '--password-stdin'], 'short\n').code).toBe(2);

    const agent = brain(['principal', 'create', '--name', 'alice-helper', '--kind', 'agent', '--trust', 'trusted', '--owner', 'alice']);
    expect(agent.code, agent.stderr).toBe(0);

    const issued = brain(['token', 'issue', '--principal', 'alice-helper', '--label', 'laptop']);
    expect(issued.code, issued.stderr).toBe(0);
    const token = issued.stdout.trim();
    expect(token).toMatch(/^brn_[A-Za-z0-9_-]{43}$/);
    expect(issued.stderr).not.toContain(token);
    expect(brain(['token', 'issue', '--principal', 'system']).code).toBe(2);

    const app = createApp(loadConfig({ BRAIN_DEV: '1', BRAIN_DATA_DIR: dataDir, BRAIN_LOG_LEVEL: 'silent' }));
    await app.server.listen({ host: '127.0.0.1', port: 0 });
    try {
      const addr = app.server.server.address();
      if (!addr || typeof addr === 'string') throw new Error('no address');
      const me = await new RestClient(`http://127.0.0.1:${addr.port}`, token).call<{ principal: { name: string; trust: string } }>('whoami');
      expect(me.principal).toMatchObject({ name: 'alice-helper', trust: 'trusted' });
    } finally {
      await app.close();
    }
    expect(brain(['doctor']).code).toBe(0);
    // Seven tsx runs in a row: on a Raspberry Pi under parallel ci load this exceeds the default 20 s.
  }, 120_000);

  it('reindex rebuilds the search index', () => {
    const r = brain(['reindex']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^reindex: \d+ document\(s\)\n$/);
    expect(brain(['doctor']).code).toBe(0);
  });

  it('migrate-spaces: explicit pairs only; --preview writes nothing, --apply re-homes and leaves an alias', async () => {
    const app = createApp(loadConfig({ BRAIN_DEV: '1', BRAIN_DATA_DIR: dataDir, BRAIN_LOG_LEVEL: 'silent' }));
    const core = app.core;
    const alice = findPrincipal(core, 'alice')!;
    const proj = createSpace(core, { slug: 'proj-cli' }, alice.id);
    const box = createSpace(core, { slug: 'proj-cli-inbox', inbox: true }, alice.id);
    const bot = createPrincipal(core, { name: 'cli-bot', kind: 'agent', trust: 'trusted', ownerId: alice.id }, alice.id);
    setGrant(core, { spaceId: box.id, scope: 'space', pathPrefix: null, docId: null, role: 'write', subjectType: 'principal', subjectId: bot.id }, alice.id);
    await app.close();
    expect(brain(['migrate-spaces', '--preview']).code).toBe(2);
    expect(brain(['migrate-spaces', '--preview', '--pair', 'proj-cli']).code).toBe(2);
    expect(brain(['migrate-spaces', '--pair', 'proj-cli=proj-cli-inbox']).code).toBe(2);
    const p = brain(['migrate-spaces', '--preview', '--pair', 'proj-cli=proj-cli-inbox']);
    expect(p.code, p.stderr).toBe(0);
    expect(p.stdout).toContain('Space migration preview (dry run: nothing was changed).');
    expect(p.stdout).toContain('proj-cli-inbox → proj-cli: ready');
    expect(p.stdout).toMatch(/cli-bot \(agent\): inbox editor; project none → guest; adds guest membership/);
    const j = JSON.parse(brain(['migrate-spaces', '--preview', '--json', '--pair', 'proj-cli=proj-cli-inbox']).stdout) as { dry_run: boolean; ok: boolean };
    expect(j).toMatchObject({ dry_run: true, ok: true });
    const a = brain(['migrate-spaces', '--apply', '--pair', 'proj-cli=proj-cli-inbox']);
    expect(a.code, a.stderr).toBe(0);
    expect(a.stdout).toContain('Space migration applied.');
    // Applied once: the inbox is an alias now; a second apply refuses.
    const again = brain(['migrate-spaces', '--apply', '--pair', 'proj-cli=proj-cli-inbox']);
    expect(again.code).toBe(2);
    expect(again.stderr).toContain('already an alias');
    expect(proj.id).not.toBe(box.id);
  }, 120_000);

  it('unknown command → usage, exit code 2', () => {
    const r = brain(['frobnicate']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('usage: brain');
  });
});
