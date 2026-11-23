// Webhooks: a signed event reaches the test receiver and is retried after a failure with a growing
// delay; after 24 hours delivery stops; attention_only and space filter events; the body carries no
// content; a write that was rolled back leaves no event.
import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deliverDue, FIRST_BACKOFF } from '../../src/core/webhooks.js';
import type { WriteResult } from '../helpers/api.js';
import type { Client } from '../helpers/clients/index.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
}

class Receiver {
  received: Received[] = [];
  /** How many of the next requests to answer with 500. */
  failNext = 0;
  private server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      this.received.push({ headers: req.headers, body });
      if (this.failNext > 0) {
        this.failNext--;
        res.writeHead(500).end('fail');
      } else {
        res.writeHead(204).end();
      }
    });
  });
  url = '';
  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/hook`;
  }
  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
  async waitFor(n: number, ms = 5000): Promise<void> {
    const until = Date.now() + ms;
    while (this.received.length < n) {
      if (Date.now() > until) throw new Error(`receiver got ${this.received.length} of ${n}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

async function expectCode(p: Promise<unknown>, code: string, details?: Record<string, unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code, ...(details ? { details } : {}) });
}

interface Created {
  webhook: { id: string; pending: number; failed: number; last_error: string | null };
  secret: string;
}

describe('webhooks', () => {
  let h: Harness;
  let w: World;
  let alice: Client;
  let hermes: Client;
  let rx: Receiver;

  async function start(env: Record<string, string> = {}): Promise<void> {
    h = await startHarness({ env: { BRAIN_WEBHOOK_ALLOW_HOSTS: '127.0.0.1', ...env } });
    w = buildWorld(h);
    alice = w.client('alice');
    hermes = w.client('alice-helper');
  }

  beforeEach(async () => {
    rx = new Receiver();
    await rx.start();
  });
  afterEach(async () => {
    await h.close();
    await rx.stop();
  });

  const outbox = () => h.core.db.prepare('SELECT * FROM webhook_outbox ORDER BY id').all() as { attempts: number; delivered_at: number | null; failed_at: number | null; next_attempt_at: number; last_error: string | null }[];

  it('a signed event reaches the receiver right after the write (background delivery)', async () => {
    await start({ BRAIN_BACKGROUND: '1' });
    const hook = await alice.call<Created>('admin_webhook_create', { url: rx.url });
    expect(hook.secret).toMatch(/^whsec_/);
    const r = await hermes.call<WriteResult>('write', { space: 'shared', path: 'hello.md', content: '# Hello\n\nzqwebhookbody\n', message: 'hi' });
    await rx.waitFor(1);
    const got = rx.received[0]!;
    expect(got.headers['x-brain-signature']).toBe(sign(hook.secret, got.body));
    expect(got.headers['x-brain-event']).toBe('revision.created');
    expect(got.body).not.toContain('zqwebhookbody');
    expect(JSON.parse(got.body)).toEqual({
      event: 'revision.created',
      doc: { id: r.doc!.id, space: 'shared', path: 'hello.md' },
      rev: 1,
      kind: 'create',
      author: { name: 'alice-helper', kind: 'agent', trust: 'trusted' },
      attention: false,
      created_at: r.doc!.updated_at,
    });
    await expect.poll(() => outbox()[0]?.delivered_at ?? null).not.toBeNull();
  });

  it('a failed delivery is retried with a growing pause and then delivered', async () => {
    await start();
    const hook = await alice.call<Created>('admin_webhook_create', { url: rx.url });
    rx.failNext = 2;
    await hermes.call('write', { space: 'shared', path: 'r.md', content: 'r\n', message: 'r' });
    expect(await deliverDue(h.core)).toBe(0);
    expect(outbox()[0]).toMatchObject({ attempts: 1, delivered_at: null, last_error: 'HTTP 500' });
    // The delay has not passed yet: no attempt.
    expect(await deliverDue(h.core)).toBe(0);
    expect(rx.received).toHaveLength(1);
    h.clock.advance(FIRST_BACKOFF + 1);
    expect(await deliverDue(h.core)).toBe(0);
    expect(outbox()[0]!.attempts).toBe(2);
    h.clock.advance(FIRST_BACKOFF + 1);
    expect(await deliverDue(h.core)).toBe(0);
    h.clock.advance(FIRST_BACKOFF + 1);
    expect(await deliverDue(h.core)).toBe(1);
    expect(rx.received).toHaveLength(3);
    // The retry carries the same body and the same signature.
    expect(rx.received[2]!.body).toBe(rx.received[0]!.body);
    expect(rx.received[2]!.headers['x-brain-signature']).toBe(sign(hook.secret, rx.received[0]!.body));
    expect(outbox()[0]).toMatchObject({ attempts: 3 });
    const list = await alice.call<{ webhooks: Created['webhook'][] }>('admin_webhook_list');
    expect(list.webhooks[0]).toMatchObject({ id: hook.webhook.id, pending: 0, failed: 0 });
  });

  it('gives up after 24 hours of failures', async () => {
    await start();
    await alice.call<Created>('admin_webhook_create', { url: rx.url });
    rx.failNext = 1000;
    await hermes.call('write', { space: 'shared', path: 'g.md', content: 'g\n', message: 'g' });
    await deliverDue(h.core);
    h.clock.advance(25 * 60 * 60 * 1000);
    await deliverDue(h.core);
    expect(outbox()[0]!.failed_at).not.toBeNull();
    h.clock.advance(2 * 60 * 60 * 1000);
    const before = rx.received.length;
    await deliverDue(h.core);
    expect(rx.received.length).toBe(before);
    const list = await alice.call<{ webhooks: Created['webhook'][] }>('admin_webhook_list');
    expect(list.webhooks[0]).toMatchObject({ pending: 0, failed: 1, last_error: 'HTTP 500' });
  });

  it('filters by space and attention_only; proposal.created on request; rolled-back writes leave nothing', async () => {
    await start();
    await alice.call('admin_webhook_create', { url: rx.url, space: 'recipes', attention_only: true, events: ['revision.created', 'proposal.created'] });
    w.grant('recipes', { principal: 'alice-helper' }, 'write');
    await hermes.call('write', { space: 'recipes', path: 'soup.md', content: 'soup\n', message: 'soup' });
    await w.client('alice-assistant').call('write', { space: 'recipes', path: 'curated.md', content: 'c\n', message: 'c' });
    await hermes.call('write', { space: 'shared', path: 'other.md', content: 'o\n', message: 'o' });
    // Conflict: the transaction rolled back, no event.
    await expectCode(hermes.call('write', { space: 'recipes', path: 'soup.md', content: 'x\n', expected_rev: 7, message: 'x' }), 'conflict');
    w.grant('recipes', { principal: 'alice-helper' }, 'propose');
    await hermes.call('propose', { space: 'recipes', path: 'pie.md', content: 'pie\n', message: 'pie' });
    expect(await deliverDue(h.core)).toBe(2);
    const events = rx.received.map((r) => JSON.parse(r.body) as { event: string; attention: boolean; doc?: { path: string }; proposal?: { path: string } });
    expect(events.map((e) => [e.event, e.doc?.path ?? e.proposal?.path, e.attention])).toEqual([
      ['revision.created', 'soup.md', true],
      ['proposal.created', 'pie.md', true],
    ]);
  });

  it('admin ops: URL policy, capability required, secret shown once, rotate, test, delete', async () => {
    await start();
    await expectCode(alice.call('admin_webhook_create', { url: 'http://example.com/hook' }), 'invalid_input');
    await expectCode(alice.call('admin_webhook_create', { url: 'https://user:pw@example.com/hook' }), 'invalid_input');
    await expectCode(alice.call('admin_webhook_create', { url: 'not a url' }), 'invalid_input');
    expect((await alice.call<Created>('admin_webhook_create', { url: 'https://example.com/hook', enabled: false })).webhook.id).toBeTruthy();
    // Without the admin capability the operation is indistinguishable from a nonexistent one.
    await expectCode(hermes.call('admin_webhook_create', { url: rx.url }), 'not_found');
    const input = { url: rx.url, request_id: 'webhook-create-1' };
    const hook = await alice.call<Created>('admin_webhook_create', input);
    await expectCode(alice.call('admin_webhook_create', input), 'conflict', { reason: 'webhook_already_created' });
    const list = await alice.call<{ webhooks: unknown[] }>('admin_webhook_list');
    expect(JSON.stringify(list)).not.toContain(hook.secret);
    const rotated = await alice.call<{ secret?: string }>('admin_webhook_update', { id: hook.webhook.id, rotate_secret: true });
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(hook.secret);
    const t = await alice.call<{ delivered: boolean; status: number }>('admin_webhook_test', { id: hook.webhook.id });
    expect(t).toMatchObject({ delivered: true, status: 204 });
    expect(rx.received.at(-1)!.headers['x-brain-signature']).toBe(sign(rotated.secret!, rx.received.at(-1)!.body));
    await alice.call('admin_webhook_delete', { id: hook.webhook.id });
    await expectCode(alice.call('admin_webhook_test', { id: hook.webhook.id }), 'not_found');
    // An agent with the admin capability can manage webhooks.
    h.core.db.prepare("UPDATE principals SET can_admin = 1 WHERE name = 'alice-assistant'").run();
    expect((await w.client('alice-assistant').call<Created>('admin_webhook_create', { url: rx.url })).secret).toMatch(/^whsec_/);
  });
});
