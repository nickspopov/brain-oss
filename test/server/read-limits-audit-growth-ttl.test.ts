// Regression tests for read ceilings, audit growth, TTLs and human-only admin: each test replays a scenario
// that used to fail.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DENIAL_ROWS_PER_MINUTE } from '../../src/core/audit.js';
import { runJanitor } from '../../src/core/janitor.js';
import { readOpNames } from '../../src/app.js';
import { auditBytes } from '../../src/store/usage.js';
import type { ReadResult, WriteResult } from '../helpers/api.js';
import { MCP_PROTOCOL_VERSION } from '../helpers/clients/mcp.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MB = 1024 * 1024;

const mcpHeaders = (token: string) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': MCP_PROTOCOL_VERSION,
  authorization: `Bearer ${token}`,
});

const readCall = (id: number, docId: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'read', arguments: { id: docId, max_bytes: 4 * MB } },
});

/** The heap flag of the production launch (`npm start`): the test checks the same process configuration. */
function startHeapFlag(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: { start: string } };
  const flag = pkg.scripts.start.split(/\s+/).find((a) => a.startsWith('--max-old-space-size='));
  if (!flag) throw new Error('npm start has no --max-old-space-size');
  return flag;
}

/** Peak RSS of the process (Linux), in bytes; `undefined` if /proc is unavailable. */
function peakRss(pid: number): number | undefined {
  try {
    const m = /VmHWM:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) * 1024 : undefined;
  } catch {
    return undefined;
  }
}

describe('one MCP request must not take the server down (batch of big reads)', () => {
  let child: ChildProcess;
  let server: { url: string; token: string; pid: number };
  let exited: { code: number | null; signal: string | null } | undefined;
  let stderr = '';

  beforeAll(async () => {
    child = spawn(process.execPath, [startHeapFlag(), '--import', 'tsx', path.join(ROOT, 'test/server/mcp-heap-server.ts')], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('exit', (code, signal) => (exited = { code, signal }));
    const line = await new Promise<string>((resolve, reject) => {
      createInterface({ input: child.stdout! }).once('line', resolve);
      child.once('exit', () => reject(new Error(`server exited: ${stderr}`)));
    });
    server = JSON.parse(line) as typeof server;
  }, 120_000);

  afterAll(async () => {
    if (!exited) {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
    }
  });

  it('4 MB file; a batch of 30 read calls is refused; 30 parallel 4 MB reads keep the process alive and bounded', async () => {
    // An agent with write stores a 4 MB file (the review scenario).
    const body = randomBytes(4 * MB);
    const put = await fetch(`${server.url}/api/v1/files/shared/big.bin`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/octet-stream' },
      body,
    });
    expect(put.status, await put.clone().text()).toBe(200);
    const docId = ((await put.json()) as { result: WriteResult }).result.doc!.id;

    // A JSON-RPC batch of 30 reads: rejected whole at the protocol level, no call is made.
    const batch = await fetch(`${server.url}/mcp/v1`, {
      method: 'POST',
      headers: mcpHeaders(server.token),
      body: JSON.stringify(Array.from({ length: 30 }, (_, i) => readCall(i + 1, docId))),
    });
    expect(batch.status).toBe(400);
    expect(await batch.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32600 }, id: null });

    // The same volume as separate concurrent requests: each response has at most 1 MB of body, the
    // per-principal byte budget stops the rest; the process stays alive.
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        fetch(`${server.url}/mcp/v1`, { method: 'POST', headers: mcpHeaders(server.token), body: JSON.stringify(readCall(i + 1, docId)) }).then(async (r) => ({
          status: r.status,
          text: await r.text(),
        })),
      ),
    );
    let served = 0;
    let limited = 0;
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.text.length).toBeLessThan(2 * MB);
      const msg = JSON.parse(r.text) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } };
      if (msg.result.isError) {
        expect((msg.result.structuredContent.error as { code: string }).code).toBe('rate_limited');
        limited++;
      } else {
        const out = msg.result.structuredContent as unknown as ReadResult;
        expect(out.truncated).toBe(true);
        expect(Buffer.from(out.content!, 'base64').length).toBe(MB);
        served++;
      }
    }
    expect(served).toBeGreaterThan(0);
    expect(limited).toBeGreaterThan(0);

    const who = await fetch(`${server.url}/api/v1/ops/whoami`, { method: 'POST', headers: { authorization: `Bearer ${server.token}` }, body: '{}' });
    expect(who.status).toBe(200);
    expect(exited, stderr).toBeUndefined();
    const rss = peakRss(server.pid);
    if (rss !== undefined) expect(rss).toBeLessThan(400 * MB);
  }, 120_000);
});

describe('regressions: read ceilings, binary content and more', () => {
  let h: Harness;
  let w: World;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h, 'mcp');
  });
  afterEach(async () => {
    await h.close();
  });

  const auditCount = (where = '1 = 1', ...args: unknown[]) => (h.core.db.prepare(`SELECT count(*) AS n FROM audit WHERE ${where}`).get(...args) as { n: number }).n;

  describe('read: response ceiling and text of binary content', () => {
    it('read returns at most 1 MB per call, base64 body is not repeated in the text', async () => {
      const put = await fetch(`${h.url}/api/v1/files/shared/big.bin`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${w.tokens['alice-helper']}` },
        body: randomBytes(3 * MB),
      });
      expect(put.status).toBe(200);
      const docId = ((await put.json()) as { result: WriteResult }).result.doc!.id;
      const res = await fetch(`${h.url}/mcp/v1`, { method: 'POST', headers: mcpHeaders(w.tokens['alice-helper']), body: JSON.stringify(readCall(1, docId)) });
      const msg = (await res.json()) as { result: { content: { text: string }[]; structuredContent: ReadResult } };
      const out = msg.result.structuredContent;
      expect(Buffer.from(out.content!, 'base64').length).toBe(MB);
      expect(out).toMatchObject({ truncated: true, next_offset: MB, encoding: 'base64' });
      const text = msg.result.content[0]!.text;
      expect(text.length).toBeLessThan(2000);
      expect(text).not.toContain(out.content!.slice(0, 64));
      expect(text).toContain(`/api/v1/docs/${docId}/raw`);
    });

    it('read bytes budget per principal: over BRAIN_RATE_READ_MB → rate_limited', async () => {
      await h.close();
      h = await startHarness({ env: { BRAIN_RATE_READ_MB: '2' } });
      w = buildWorld(h, 'rest');
      const hermes = w.client('alice-helper');
      const big = 'x'.repeat(400 * 1024);
      const r = await hermes.call<WriteResult>('write', { space: 'shared', path: 'big.md', content: big, expected_rev: 0, message: 'big' });
      for (let i = 0; i < 6; i++) await hermes.call<ReadResult>('read', { id: r.doc!.id, max_bytes: 4 * MB });
      const refused = await hermes.raw('read', { id: r.doc!.id });
      expect(refused.status).toBe(429);
      expect(JSON.parse(refused.text)).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
      // Another principal does not share this budget.
      expect((await w.client('alice-assistant').call<ReadResult>('read', { id: r.doc!.id, max_bytes: MB })).content).toBe(big);
    });
  });

  describe('audit does not grow without bound and does not stop writes', () => {
    const whoami = (headers: Record<string, string>) => fetch(`${h.url}/api/v1/ops/whoami`, { method: 'POST', headers, body: '{}' });

    it('requests without credentials leave no audit rows; bad tokens and rate_limited are thinned per key', async () => {
      const before = auditCount();
      for (let i = 0; i < 50; i++) expect((await whoami({})).status).toBe(401);
      expect(auditCount()).toBe(before);

      for (let i = 0; i < 60; i++) expect((await whoami({ authorization: `Bearer brn_${'A'.repeat(43)}` })).status).toBe(401);
      expect(auditCount("outcome = 'unauthenticated'")).toBe(DENIAL_ROWS_PER_MINUTE);
      // The next minute: the first row carries the number of skipped ones.
      h.clock.advance(60_000);
      expect((await whoami({ authorization: `Bearer brn_${'A'.repeat(43)}` })).status).toBe(401);
      const last = h.core.db.prepare("SELECT detail FROM audit WHERE outcome = 'unauthenticated' ORDER BY id DESC LIMIT 1").get() as { detail: string };
      expect(JSON.parse(last.detail)).toEqual({ suppressed: 60 - DENIAL_ROWS_PER_MINUTE });
    });

    it('authenticated flood over the limit: rate_limited rows are thinned; unknown operations spend the read limit', async () => {
      await h.close();
      h = await startHarness({ env: { BRAIN_RATE_READ: '10' } });
      w = buildWorld(h, 'rest');
      const alphabot = w.client('alphabot');
      for (let i = 0; i < 100; i++) await alphabot.raw('whoami');
      expect(auditCount("op = 'whoami' AND outcome = 'ok'")).toBe(10);
      expect(auditCount("op = 'whoami' AND outcome = 'rate_limited'")).toBe(DENIAL_ROWS_PER_MINUTE);
      h.clock.advance(60_000);
      for (let i = 0; i < 100; i++) await alphabot.raw('no_such_op');
      expect(auditCount("op = 'no_such_op' AND outcome = 'not_found'")).toBe(10);
      expect(auditCount("op = 'no_such_op' AND outcome = 'rate_limited'")).toBe(DENIAL_ROWS_PER_MINUTE);
    });

    it('a full audit does not refuse writes: the data limit excludes it; janitor keeps the audit under its ceiling', async () => {
      await h.close();
      h = await startHarness({ env: { BRAIN_MAX_DATA_BYTES: String(3 * MB), BRAIN_AUDIT_MAX_MB: '1' } });
      w = buildWorld(h, 'rest');
      const hermes = w.client('alice-helper');
      // 4 MB of denials in the audit (as after tens of thousands of requests), straight into the table.
      const insert = h.core.db.prepare(
        "INSERT INTO audit (ts, principal_id, token_id, via, op, outcome, ip, detail) VALUES (?, NULL, NULL, 'rest', 'whoami', 'unauthenticated', '203.0.113.7', ?)",
      );
      const pad = JSON.stringify({ pad: 'p'.repeat(100) });
      h.core.db.transaction(() => {
        for (let i = 0; i < 25_000; i++) insert.run(h.clock.now(), pad);
      })();
      expect(auditBytes(h.core.db)).toBeGreaterThan(3 * MB);
      const r = await hermes.call<WriteResult>('write', { space: 'shared', path: 'after-flood.md', content: 'still writable', expected_rev: 0, message: 'm' });
      expect(r.doc!.rev).toBe(1);
      // The janitor evicts the oldest denials down to the audit ceiling; the write row stays.
      const report = runJanitor(h.core, { readOps: readOpNames() });
      expect(report.auditEvicted).toBeGreaterThan(0);
      expect(auditBytes(h.core.db)).toBeLessThanOrEqual(MB);
      expect(auditCount("op = 'write' AND outcome = 'ok'")).toBe(1);
    });

    it('stream denials expire after 180 days, forbidden and writes stay', async () => {
      await w.client('alphabot').raw('write', { space: 'shared', path: 'x.md', content: 'x', expected_rev: 0, message: 'm' });
      await whoami({ authorization: `Bearer brn_${'B'.repeat(43)}` });
      await w.client('alphabot').raw('no_such_op');
      expect(auditCount("outcome = 'forbidden'")).toBe(1);
      h.clock.advanceDays(181);
      const report = runJanitor(h.core, { readOps: readOpNames() });
      // whoami is a read (its row is removed by the reads rule); no_such_op only by the denials rule.
      expect(report.auditDenials).toBe(1);
      expect(auditCount("outcome IN ('unauthenticated', 'not_found')")).toBe(0);
      expect(auditCount("outcome = 'forbidden'")).toBe(1);
    });
  });

  describe('edit, revert, restore and accept keep the document TTL', () => {
    const DAY = 86_400_000;
    const daysLeft = (iso: string | undefined) => (iso === undefined ? null : Math.round((Date.parse(iso) - h.clock.now()) / DAY));

    it('ttl_days 3 in a space without TTL survives edit, revert, delete + restore and an accepted proposal', async () => {
      const hermes = w.client('alice-helper', 'rest');
      const r = await hermes.call<WriteResult>('write', { space: 'shared', path: 'ttl.md', content: 'a\n', ttl_days: 3, expected_rev: 0, message: 'm' });
      expect(daysLeft(r.doc!.expires_at)).toBe(3);
      const id = r.doc!.id;
      h.clock.advanceDays(1);
      const e = await hermes.call<WriteResult>('edit', { id, edits: [{ old_text: 'a', new_text: 'b' }], expected_rev: 1, message: 'e' });
      expect(daysLeft(e.doc!.expires_at)).toBe(3);
      const w3 = await hermes.call<WriteResult>('write', { space: 'shared', path: 'ttl.md', content: 'c\n', expected_rev: 2, message: 'w' });
      expect(daysLeft(w3.doc!.expires_at)).toBe(3);
      const rv = await hermes.call<WriteResult>('revert', { id, to_rev: 1, expected_rev: 3, message: 'r' });
      expect(daysLeft(rv.doc!.expires_at)).toBe(3);
      await hermes.call('delete', { id, expected_rev: 4, message: 'd' });
      const back = await hermes.call<WriteResult>('restore', { id, message: 'back' });
      expect(daysLeft(back.doc!.expires_at)).toBe(3);
      const p = await hermes.call<{ proposal: { id: string } }>('propose', { space: 'shared', path: 'ttl.md', content: 'p\n', message: 'p' });
      const acc = await w.client('alice', 'rest').call<{ doc: { expires_at?: string } }>('proposal_decide', { id: p.proposal.id, decision: 'accept' });
      expect(daysLeft(acc.doc.expires_at)).toBe(3);
    });

    it('ttl_days 1 in handoff (14 days) stays 1 day after edit', async () => {
      const hermes = w.client('alice-helper', 'rest');
      const r = await hermes.call<WriteResult>('write', { space: 'handoff', path: 'short.md', content: 'a\n', ttl_days: 1, expected_rev: 0, message: 'm' });
      const e = await hermes.call<WriteResult>('edit', { id: r.doc!.id, edits: [{ old_text: 'a', new_text: 'b' }], expected_rev: 1, message: 'e' });
      expect(daysLeft(e.doc!.expires_at)).toBe(1);
      // Without ttl_days the document lives for the space's term, as before.
      const d = await hermes.call<WriteResult>('write', { space: 'handoff', path: 'long.md', content: 'a\n', expected_rev: 0, message: 'm' });
      const e2 = await hermes.call<WriteResult>('edit', { id: d.doc!.id, edits: [{ old_text: 'a', new_text: 'b' }], expected_rev: 1, message: 'e' });
      expect(daysLeft(e2.doc!.expires_at)).toBe(14);
    });
  });

  it('an admin agent cannot mint a human: create, password and tokens of humans are superadmin-only', async () => {
    const alice = w.client('alice', 'rest');
    await alice.call('admin_principal_update', { name: 'alice-assistant', admin: true });
    const claude = w.client('alice-assistant', 'rest');
    const code = async (op: string, input: Record<string, unknown>) => (JSON.parse((await claude.raw(op, input)).text) as { error?: { code: string } }).error?.code;
    expect(await code('admin_principal_create', { name: 'fake-human', kind: 'human', trust: 'admin', password: 'long-enough-password-1' })).toBe('forbidden');
    await alice.call('admin_principal_create', { name: 'anna', kind: 'human', trust: 'trusted', password: 'first-password-123' });
    expect(await code('admin_token_issue', { principal: 'anna' })).toBe('forbidden');
    expect(await code('admin_principal_update', { name: 'anna', password: 'second-password-123' })).toBe('forbidden');
    // An admin agent still creates agents and issues tokens to them.
    await claude.call('admin_principal_create', { name: 'helper', kind: 'agent', trust: 'limited' });
    await claude.call('admin_token_issue', { principal: 'helper' });
    // A superadmin can do all of this.
    await alice.call('admin_token_issue', { principal: 'anna' });
    await alice.call('admin_principal_update', { name: 'anna', password: 'second-password-123' });
  });
});
