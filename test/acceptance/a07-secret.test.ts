// A write containing a secret is rejected, and the secret value is left nowhere.
// Values are assembled at test time from random bytes: the sources contain no literal that
// looks like a real key (otherwise repository scanners would flag them).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryResult, WriteResult } from '../helpers/api.js';
import { ADAPTERS, type AdapterName, type Client, type RawResponse } from '../helpers/clients/index.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';
import { plainArchive } from '../helpers/archive.js';
import { requireFeature } from '../helpers/pending.js';
import { secretSamples } from '../helpers/secrets.js';

export { secretSamples };

/** Placeholders from documentation and examples: must not trigger. */
const PLACEHOLDERS = [
  'Slack token looks like xoxb-XXXX',
  'OpenAI key: sk-...',
  'Anthropic key: sk-ant-...',
  'export GITHUB_TOKEN=ghp_<your-token>',
  'password = "changeme"',
  'api_key: <YOUR_API_KEY>',
  'token: ${BRAIN_TOKEN}',
  'AWS key id format: AKIA followed by 16 characters',
];

describe.each(ADAPTERS)('a07 secrets via %s', (adapter: AdapterName) => {
  let h: Harness;
  let w: World;
  let hermes: Client;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h, adapter);
    hermes = w.client('alice-helper');
  });
  afterEach(async () => {
    // One audit line per operation call made by the scenario.
    expect(h.auditedCalls()).toBe(h.opCalls());
    await h.close();
  });

  function assertRejected(r: RawResponse, secret: string, label: string): void {
    expect(r.status, label).toBe(422);
    expect(r.body, label).toMatchObject({ ok: false, error: { code: 'secret_detected', retryable: false } });
    const findings = (r.body.ok ? [] : (r.body.error.details?.findings as { rule: string; line: number; column: number }[])) ?? [];
    expect(findings.length, label).toBeGreaterThan(0);
    for (const f of findings) {
      expect(typeof f.rule).toBe('string');
      expect(f.line).toBeGreaterThanOrEqual(1);
      expect(f.column).toBeGreaterThanOrEqual(1);
    }
    expect(r.text, label).not.toContain(secret);
    const core = secret.slice(Math.floor(secret.length / 3), Math.floor(secret.length / 3) + 16);
    expect(r.text, label).not.toContain(core);
  }

  function assertNowhere(secret: string): void {
    const core = secret.slice(Math.floor(secret.length / 3), Math.floor(secret.length / 3) + 16);
    const audit = JSON.stringify(h.core.db.prepare('SELECT * FROM audit').all());
    expect(audit).not.toContain(core);
    expect(h.logs.join('\n')).not.toContain(core);
    const blobs = JSON.stringify(h.core.db.prepare('SELECT text FROM blobs').all());
    expect(blobs).not.toContain(core);
    expect(JSON.stringify(h.core.db.prepare('SELECT * FROM revisions').all())).not.toContain(core);
  }

  it('the samples are generated at runtime and look like the real formats', () => {
    const s = secretSamples();
    expect(Object.keys(s)).toHaveLength(23);
    expect(s.github_pat_classic).toMatch(/^ghp_[A-Za-z0-9]{36}$/);
    expect(s.brain_token).toMatch(/^brn_[A-Za-z0-9_-]{43}$/);
  });

  it('a write with a secret of every rule → secret_detected, no revision, value nowhere', async () => {
    requireFeature('secret-scanner');
    const samples = secretSamples();
    for (const [rule, secret] of Object.entries(samples)) {
      const path = `secrets/${rule}.md`;
      const r = await hermes.raw('write', { space: 'shared', path, content: `# Config\n\nvalue: ${secret}\n`, message: `add ${rule}` });
      assertRejected(r, secret, rule);
      const list = await hermes.call<{ entries: { path: string }[] }>('list', { space: 'shared', depth: 5 });
      expect(list.entries.map((e) => e.path)).not.toContain(path);
      assertNowhere(secret);
    }
  });

  it('a secret added by an update is caught; the existing revision stays alone', async () => {
    requireFeature('secret-scanner');
    await hermes.call('write', { space: 'shared', path: 'cfg.md', content: '# Config\n', message: 'create' });
    const secret = secretSamples().slack_bot!;
    const r = await hermes.raw('write', { space: 'shared', path: 'cfg.md', content: `# Config\n\nSLACK=${secret}\n`, expected_rev: 1, message: 'add token' });
    assertRejected(r, secret, 'update');
    const history = await hermes.call<HistoryResult>('history', { space: 'shared', path: 'cfg.md' });
    expect(history.revisions).toHaveLength(1);
    assertNowhere(secret);
  });

  it('placeholders pass', async () => {
    for (const [i, text] of PLACEHOLDERS.entries()) {
      const r = await hermes.call<WriteResult>('write', { space: 'shared', path: `examples/p${i}.md`, content: `# Example\n\n${text}\n`, message: 'example' });
      expect(r.status, text).toBe('committed');
    }
  });

  it('a secret in path, message or an edit is caught too', async () => {
    requireFeature('secret-scanner');
    const s = secretSamples();
    const inPath = await hermes.raw('write', { space: 'shared', path: `keys/${s.github_pat_classic}.md`, content: 'x\n', message: 'p' });
    assertRejected(inPath, s.github_pat_classic!, 'path');
    const inMessage = await hermes.raw('write', { space: 'shared', path: 'm.md', content: 'x\n', message: `token ${s.openai}` });
    assertRejected(inMessage, s.openai!, 'message');
    await hermes.call('write', { space: 'shared', path: 'e.md', content: '# E\n\nplaceholder\n', message: 'create' });
    const inEdit = await hermes.raw('edit', { space: 'shared', path: 'e.md', edits: [{ old_text: 'placeholder', new_text: `key ${s.stripe_secret}` }], message: 'edit' });
    assertRejected(inEdit, s.stripe_secret!, 'edit');
    for (const v of [s.github_pat_classic!, s.openai!, s.stripe_secret!]) assertNowhere(v);
  });

  it('a secret in a proposal is caught', async () => {
    requireFeature('secret-scanner');
    w.grant('recipes', { principal: 'alice-helper' }, 'propose');
    const secret = secretSamples().anthropic!;
    const r = await hermes.raw('propose', { space: 'recipes', path: 'r.md', content: `# R\n\nkey ${secret}\n`, message: 'proposal' });
    assertRejected(r, secret, 'propose');
    assertNowhere(secret);
  });

  it('a secret inside an imported archive stops the import and is reported without its value', async () => {
    h.requireRoute('POST', '/api/v1/import');
    const secret = secretSamples().aws_access_key!;
    const res = await fetch(`${h.url}/api/v1/import?space=imported&mode=restore`, {
      method: 'POST',
      headers: { authorization: `Bearer ${w.tokens.alice}`, 'content-type': 'application/gzip' },
      body: await plainArchive({ 'notes.md': `# Notes\n\nkey ${secret}\n` }),
    });
    const text = await res.text();
    expect(res.status).toBe(422);
    expect(text).toContain('secret_detected');
    expect(text).not.toContain(secret);
    assertNowhere(secret);
  });
});
