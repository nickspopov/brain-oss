// Serving the UI (adapters/http/ui.ts) and the UI path over REST with a session:
// login → spaces → tree → read → search → attachment download; CSP and headers; escaping the
// directory is impossible; API addresses are not replaced by index.html; the invisible stays invisible via the UI too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UI_CSP } from '../../src/adapters/http/ui.js';
import { setGrant } from '../../src/core/grants.js';
import { createPrincipal } from '../../src/core/principals.js';
import { assertNoMarkers, buildWorld, hiddenMarkers, ALICE_PASSWORD, seedBeta, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

const INDEX = '<!doctype html><html><head><script type="module" src="/assets/app-1.js"></script></head><body><div id="root"></div></body></html>';
const SECRET = 'outside-web-dir-must-not-be-served';

let base: string;
let webDir: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-ui-'));
  webDir = path.join(base, 'dist');
  fs.mkdirSync(path.join(webDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(webDir, 'index.html'), INDEX);
  fs.writeFileSync(path.join(webDir, 'assets', 'app-1.js'), 'console.log("ui")');
  fs.writeFileSync(path.join(webDir, 'assets', 'app-1.css'), 'body{}');
  fs.writeFileSync(path.join(webDir, '.env'), SECRET);
  fs.writeFileSync(path.join(base, 'secret.txt'), SECRET);
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

let h: Harness;
let w: World;

beforeEach(async () => {
  h = await startHarness({ env: { BRAIN_WEB_DIR: webDir } });
  w = buildWorld(h);
});
afterEach(async () => {
  await h.close();
});

async function get(p: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${h.url}${p}`, { headers });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe('static UI', () => {
  it('serves index.html at / and at every app address, with the CSP', async () => {
    for (const p of ['/', '/index.html', '/login', '/search?q=x', '/s/proj-alpha', '/s/proj-alpha/d/notes/plan.md', '/s/proj-beta/d/caf%C3%A9.md']) {
      const r = await get(p);
      expect(r.status, p).toBe(200);
      expect(r.text, p).toBe(INDEX);
      expect(r.headers.get('content-type')).toMatch(/^text\/html/);
      expect(r.headers.get('content-security-policy')).toBe(UI_CSP);
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('x-frame-options')).toBe('DENY');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
      expect(r.headers.get('cache-control')).toBe('no-cache');
    }
    expect(UI_CSP).toContain("default-src 'self'");
    expect(UI_CSP).toContain("img-src 'self' data:");
    expect(UI_CSP).toContain("frame-ancestors 'none'");
    expect(UI_CSP).toContain("base-uri 'none'");
  });

  it('serves built assets with their type and long cache; a missing asset is 404, not index.html', async () => {
    const js = await get('/assets/app-1.js');
    expect(js.status).toBe(200);
    expect(js.text).toBe('console.log("ui")');
    expect(js.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(js.headers.get('content-security-policy')).toBe(UI_CSP);
    expect((await get('/assets/app-1.css')).headers.get('content-type')).toMatch(/^text\/css/);
    const missing = await get('/assets/nope.js');
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.text)).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('never serves files outside the web dir or dotfiles', async () => {
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/assets/%2e%2e%2f%2e%2e%2fsecret.txt', '/.env', '/assets/..%5c..%5csecret.txt', '/%00']) {
      const r = await get(p);
      expect(r.text, p).not.toContain(SECRET);
    }
  });

  it('API addresses are never answered with index.html', async () => {
    // Every reserved address is answered by its owner (REST, discovery, MCP), not by the UI:
    // unknown API addresses give 404 not_found; GET /mcp/v1 gives 405 (MCP without sessions, POST only);
    // discovery serves its own text. None of them is index.html or text/html.
    const expected: Array<[string, number]> = [
      ['/api/v1/nope', 404],
      ['/api', 404],
      ['/api/', 404],
      ['/mcp', 404],
      ['/mcp/nope', 404],
      ['/mcpl', 404],
      ['/.well-known/nope', 404],
      ['/mcp/v1', 405],
      ['/agents.md', 200],
      ['/llms.txt', 200],
      ['/.well-known/brain.json', 200],
      ['/healthz', 200],
    ];
    for (const [p, status] of expected) {
      const r = await get(p, { accept: 'text/html' });
      expect(r.status, p).toBe(status);
      expect(r.text, p).not.toBe(INDEX);
      expect(r.text, p).not.toContain('<div id="root">');
      expect(r.headers.get('content-type') ?? '', p).not.toMatch(/^text\/html/);
      expect(r.headers.get('content-security-policy'), p).not.toBe(UI_CSP);
      if (status === 404) expect(JSON.parse(r.text), p).toMatchObject({ ok: false, error: { code: 'not_found' } });
    }
    // A REST operation answers with its own code (not 200 with index.html), whatever the method.
    const op = await get('/api/v1/ops/whoami', { accept: 'text/html' });
    expect(op.status).not.toBe(200);
    expect(op.text).not.toContain('<div id="root">');
    expect(op.headers.get('content-type') ?? '').not.toMatch(/^text\/html/);
    expect(JSON.parse((await get('/mcp/v1')).text)).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
    expect((await get('/agents.md')).text).toMatch(/whoami/);
    expect(JSON.parse((await get('/healthz')).text)).toEqual({ ok: true });
  });

  it('without a built UI the server answers only the API', async () => {
    await h.close();
    h = await startHarness({ env: { BRAIN_WEB_DIR: path.join(base, 'empty') } });
    buildWorld(h);
    const r = await get('/');
    expect(r.status).toBe(404);
    expect(JSON.parse(r.text)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    await h.close();
    h = await startHarness({ env: { BRAIN_WEB_DIR: '' } });
    buildWorld(h);
    expect((await get('/s/x')).status).toBe(404);
  });
});

describe('UI path over REST with a session cookie', () => {
  // The same headers web/src/api/client.ts sends; the browser adds Origin itself.
  const uiHeaders = () => ({ 'x-brain-client': 'brain-web', origin: h.config.origin, 'content-type': 'application/json', accept: 'application/json' });

  async function login(name: string, password: string): Promise<string> {
    const res = await fetch(`${h.url}/api/v1/auth/login`, { method: 'POST', headers: uiHeaders(), body: JSON.stringify({ name, password }) });
    expect(res.status).toBe(200);
    const m = /brain_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
    if (!m) throw new Error('no cookie');
    return `brain_session=${m[1]}`;
  }

  async function op<T = Record<string, unknown>>(cookie: string, name: string, input: unknown = {}) {
    const res = await fetch(`${h.url}/api/v1/ops/${name}`, { method: 'POST', headers: { ...uiHeaders(), cookie }, body: JSON.stringify(input) });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as { ok: boolean; result: T; error?: { code: string } } };
  }

  async function bearerWrite(token: string, input: Record<string, unknown>) {
    const res = await fetch(`${h.url}/api/v1/ops/write`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    expect(res.status).toBe(200);
  }

  it('session → spaces → tree → read (author, trust, trust_floor, TTL) → search with highlights → raw download → logout', async () => {
    await bearerWrite(w.tokens['alice-helper'], {
      space: 'handoff',
      path: 'notes/ready.md',
      content: '---\ntags: [handoff]\n---\n# Ready for handoff\n\nKey paragraph about handing the task over to Claude.\n',
      message: 'handoff note',
      ttl_days: 3,
    });
    const cookie = await login('alice', ALICE_PASSWORD);

    const session = await fetch(`${h.url}/api/v1/auth/session`, { headers: { 'x-brain-client': 'brain-web', cookie } });
    expect((await session.json()) as unknown).toMatchObject({ ok: true, result: { principal: { name: 'alice', admin: true } } });

    const spaces = await op<{ spaces: { slug: string; review_mode: string; protected_paths: string[]; ttl_days?: number }[] }>(cookie, 'spaces');
    const handoff = spaces.body.result.spaces.find((s) => s.slug === 'handoff');
    expect(handoff).toMatchObject({ review_mode: 'off', protected_paths: [], ttl_days: 14 });

    const root = await op<{ entries: { type: string; path: string; children?: number }[] }>(cookie, 'list', { space: 'handoff', limit: 200 });
    expect(root.body.result.entries).toContainEqual({ type: 'folder', path: 'notes', children: 1 });
    const folder = await op<{ entries: { type: string; path: string }[] }>(cookie, 'list', { space: 'handoff', path: 'notes', limit: 200 });
    expect(folder.body.result.entries.map((e) => e.path)).toEqual(['notes/ready.md']);

    const meta = await op<{ doc: Record<string, unknown>; content?: string }>(cookie, 'read', { space: 'handoff', path: 'notes/ready.md', format: 'meta' });
    expect(meta.body.result.content).toBeUndefined();
    expect(meta.body.result.doc).toMatchObject({
      kind: 'text',
      mime: 'text/markdown',
      title: 'Ready for handoff',
      author: { name: 'alice-helper', kind: 'agent', trust: 'trusted' },
      trust_floor: 'trusted',
      tags: ['handoff'],
    });
    expect(typeof meta.body.result.doc.expires_at).toBe('string');
    const full = await op<{ content: string; truncated: boolean }>(cookie, 'read', { space: 'handoff', path: 'notes/ready.md', format: 'full', max_bytes: 1024 * 1024 });
    expect(full.body.result.content).toContain('Key paragraph');
    expect(full.body.result.truncated).toBe(false);

    const found = await op<{ results: { doc: { path: string; id: string }; snippet: { text: string; highlights: [number, number][] } }[] }>(cookie, 'search', {
      query: 'handing',
      limit: 20,
    });
    const hit = found.body.result.results.find((r) => r.doc.path === 'notes/ready.md');
    expect(hit).toBeDefined();
    const marked = hit!.snippet.highlights.map(([a, b]) => hit!.snippet.text.slice(a, b).toLowerCase());
    expect(marked.some((m) => m.startsWith('hand'))).toBe(true);

    // Download: GET with the cookie, always attachment + nosniff.
    const raw = await fetch(`${h.url}/api/v1/docs/${hit!.doc.id}/raw`, { headers: { cookie } });
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await raw.text()).toContain('Key paragraph');

    const out = await fetch(`${h.url}/api/v1/auth/logout`, { method: 'POST', headers: { ...uiHeaders(), cookie }, body: '{}' });
    expect(out.status).toBe(200);
    expect((await op(cookie, 'spaces')).status).toBe(401);
  });

  it('operations without X-Brain-Client are refused for a cookie session (the client always sends it)', async () => {
    const cookie = await login('alice', ALICE_PASSWORD);
    const res = await fetch(`${h.url}/api/v1/ops/spaces`, { method: 'POST', headers: { origin: h.config.origin, 'content-type': 'application/json', cookie }, body: '{}' });
    expect(res.status).toBe(401);
  });

  it('a human with narrow rights sees through the UI exactly what the API allows: nothing from a hidden space', async () => {
    const docs = await seedBeta(w);
    // A human without superadmin, with the same rights as alphabot.
    const alice = w.principals.alice;
    const anna = createPrincipal(h.core, { name: 'anna', kind: 'human', trust: 'trusted', ownerId: alice.id, password: 'anna-password-123' }, alice.id);
    setGrant(h.core, { spaceId: w.spaces['proj-alpha'].id, scope: 'space', pathPrefix: null, docId: null, role: 'write', subjectType: 'principal', subjectId: anna.id }, alice.id);
    const cookie = await login('anna', 'anna-password-123');
    const markers = hiddenMarkers(w, docs);
    const spaces = await op(cookie, 'spaces');
    assertNoMarkers(spaces.text, markers, 'spaces');
    expect((await op(cookie, 'list', { space: 'proj-beta' })).body.error?.code).toBe('not_found');
    assertNoMarkers((await op(cookie, 'search', { query: w.canary.prefix })).text, markers, 'search');
    // index.html is the same for everyone and carries no data.
    expect((await get('/s/proj-beta', { cookie })).text).toBe(INDEX);
  });
});
