// GET /inbox-poll.sh serves scripts/inbox-poll.sh byte for byte without a token; its sha256
// is in a header and in the discovery document; every text that names the script says where to get it.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findPollScript } from '../../src/adapters/http/pollscript.js';
import { HANDOFF_INBOX_DESCRIPTION } from '../../src/ops/agent/handoff.js';
import { HANDOFF_WAIT_DESCRIPTION } from '../../src/ops/agent/handoff_wait.js';
import { startHereMail } from '../../src/ops/agent/start_here.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/inbox-poll.sh');
const bytes = fs.readFileSync(SCRIPT);
const sha = createHash('sha256').update(bytes).digest('hex');

let h: Harness;
let w: World;
beforeAll(async () => {
  h = await startHarness();
  w = buildWorld(h);
});
afterAll(async () => {
  await h.close();
});

describe('GET /inbox-poll.sh', () => {
  it('serves the script byte-identical, no token, shell type, no-cache, x-content-sha256', async () => {
    const res = await fetch(`${h.url}/inbox-poll.sh`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/x-shellscript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-content-sha256')).toBe(sha);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('the same sha256 and URL in /.well-known/brain.json and /api/v1/meta', async () => {
    for (const p of ['/.well-known/brain.json', '/api/v1/meta']) {
      const meta = (await (await fetch(`${h.url}${p}`)).json()) as { inbox_poll_script: unknown; endpoints: Record<string, string> };
      expect(meta.inbox_poll_script).toEqual({ url: `${h.config.origin}/inbox-poll.sh`, sha256: sha });
      expect(meta.endpoints.inbox_poll_script).toBe(`${h.config.origin}/inbox-poll.sh`);
    }
  });

  it('is found from both src/ (tsx) and dist/src/ (built package) layouts', () => {
    expect(findPollScript(path.join(ROOT, 'src/adapters/http'))).toBe(SCRIPT);
    expect(findPollScript(path.join(ROOT, 'dist/src/adapters/http'))).toBe(SCRIPT);
    expect(findPollScript('/')).toBeNull();
  });
});

describe('texts say where to get it', () => {
  it('/agents.md and /llms.txt carry the curl line with the origin', async () => {
    const url = `${h.config.origin}/inbox-poll.sh`;
    const md = await (await fetch(`${h.url}/agents.md`)).text();
    expect(md).toContain(`curl -fsSL ${url} -o inbox-poll.sh && chmod +x inbox-poll.sh`);
    expect(md).toContain('BRAIN_HEADERS');
    const llms = await (await fetch(`${h.url}/llms.txt`)).text();
    expect(llms).toContain(`[inbox-poll.sh](${url})`);
  });

  it('start_here Mail line, handoff_wait and handoff_inbox descriptions', async () => {
    expect(startHereMail('https://b.example')[1]).toContain(
      'Shell: `inbox-poll.sh --wait 1800` (get it: curl -fsSL https://b.example/inbox-poll.sh -o inbox-poll.sh)',
    );
    expect(HANDOFF_WAIT_DESCRIPTION).toContain('<Brain URL>/inbox-poll.sh');
    expect(HANDOFF_INBOX_DESCRIPTION).toContain('<Brain URL>/inbox-poll.sh');
    const start = await w.client('alphabot').call<{ mail?: string[] }>('start_here');
    expect(start.mail?.join('\n')).toContain(`curl -fsSL ${h.config.origin}/inbox-poll.sh`);
  });

  it('admin_connect_guide gives the curl line', async () => {
    const g = await w.client('alice').call<{ text: string }>('admin_connect_guide', { harness: 'hermes' });
    expect(g.text).toContain(`curl -fsSL ${h.config.origin}/inbox-poll.sh -o inbox-poll.sh && chmod +x inbox-poll.sh`);
  });

  it('docs/connect/README.md names the URL', () => {
    expect(fs.readFileSync(path.join(ROOT, 'docs/connect/README.md'), 'utf8')).toContain('/inbox-poll.sh -o inbox-poll.sh');
  });

  it('the script help names BRAIN_URL, BRAIN_TOKEN and BRAIN_HEADERS, and no gateway', () => {
    const r = spawnSync('sh', [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    for (const v of ['BRAIN_URL', 'BRAIN_TOKEN', 'BRAIN_HEADERS', '/inbox-poll.sh']) {
      expect(r.stderr).toContain(v);
    }
  });
});
