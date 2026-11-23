// Extra headers for brain-mcp and inbox-poll.sh: BRAIN_HEADERS reaches the server on every request;
// authorization comes only from BRAIN_TOKEN; header values are never printed.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extraHeaders, requestHeaders } from '../../src/adapters/stdio/proxy.js';
import { HARNESSES } from '../../src/ops/admin/connect.js';
import { ok } from '../helpers/clients/sdk.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TSX = path.join(ROOT, 'node_modules/.bin/tsx');
const BIN = path.join(ROOT, 'src/adapters/stdio/bin.ts');
const BASE_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };

const GW_ID = 'gateway-id-1f2e3d4c';
const GW_SECRET = 'not-a-real-secret-value';

/** A forwarding proxy in front of the test server that records every request's headers. */
async function recorder(target: string): Promise<{ url: string; seen: http.IncomingHttpHeaders[]; close(): Promise<void> }> {
  const seen: http.IncomingHttpHeaders[] = [];
  const t = new URL(target);
  const server = http.createServer((req, res) => {
    seen.push({ ...req.headers });
    const up = http.request(
      { host: t.hostname, port: t.port, method: req.method, path: req.url, headers: { ...req.headers, host: t.host } },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('extraHeaders / requestHeaders', () => {
  it('reads BRAIN_HEADERS only; authorization always comes from the token', () => {
    expect(extraHeaders({})).toEqual({});
    expect(extraHeaders({ BRAIN_HEADERS: '{"X-A":"1","X-Gateway-Id":"id"}' })).toEqual({ 'X-A': '1', 'X-Gateway-Id': 'id' });
    expect(requestHeaders('brn_t', { Authorization: 'Bearer evil', AUTHORIZATION: 'x', 'X-A': '1' })).toEqual({
      'X-A': '1',
      authorization: 'Bearer brn_t',
    });
  });

  it('rejects bad input without echoing any value', () => {
    const cases = [
      `{"X-Gateway-Secret":"${GW_SECRET}"`,
      `["${GW_SECRET}"]`,
      `{"X-Gateway-Secret":{"v":"${GW_SECRET}"}}`,
      `{"bad name ${GW_SECRET}":"x"}`,
      `{"X-A":"${GW_SECRET}\\r\\nX-B: y"}`,
    ];
    for (const BRAIN_HEADERS of cases) {
      let msg = '';
      try {
        extraHeaders({ BRAIN_HEADERS });
      } catch (err) {
        msg = (err as Error).message;
      }
      expect(msg, BRAIN_HEADERS).toMatch(/^BRAIN_HEADERS/);
      expect(msg).not.toContain(GW_SECRET);
    }
  });
});

describe('brain-mcp with extra headers', () => {
  let h: Harness;
  let w: World;
  let rec: Awaited<ReturnType<typeof recorder>>;

  beforeAll(async () => {
    h = await startHarness();
    w = buildWorld(h);
    rec = await recorder(h.url);
  });
  afterAll(async () => {
    await rec.close();
    await h.close();
  });

  it('every request carries BRAIN_HEADERS; an Authorization in BRAIN_HEADERS does not replace the token', async () => {
    const t = new StdioClientTransport({
      command: TSX,
      args: [BIN],
      cwd: ROOT,
      env: {
        ...BASE_ENV,
        BRAIN_URL: rec.url,
        BRAIN_TOKEN: w.tokens.alphabot,
        BRAIN_HEADERS: JSON.stringify({ Authorization: `Bearer ${w.tokens.alice}`, 'X-Extra': 'extra-1', 'X-Gateway-Id': GW_ID, 'X-Gateway-Secret': GW_SECRET }),
      },
      stderr: 'pipe',
    });
    let stderr = '';
    t.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    const client = new SdkClient({ name: 'hdr-test', version: '0.0.0' });
    await client.connect(t, { timeout: 60_000 });
    try {
      const me = await ok<{ principal: { name: string } }>(client, 'whoami');
      expect(me.out.principal.name).toBe('alphabot');
      await client.listTools();
    } finally {
      await client.close();
    }
    expect(rec.seen.length).toBeGreaterThanOrEqual(3);
    for (const hd of rec.seen) {
      expect(hd['x-gateway-id']).toBe(GW_ID);
      expect(hd['x-gateway-secret']).toBe(GW_SECRET);
      expect(hd['x-extra']).toBe('extra-1');
      expect(hd.authorization).toBe(`Bearer ${w.tokens.alphabot}`);
    }
    expect(stderr).not.toContain(GW_SECRET);
    expect(stderr).not.toContain(GW_ID);
    expect(stderr).not.toContain(w.tokens.alice);
  });

  it('invalid BRAIN_HEADERS: exit code 2, a clear message, no header value anywhere', () => {
    const r = spawnSync(TSX, [BIN], {
      cwd: ROOT,
      env: { ...BASE_ENV, BRAIN_URL: h.url, BRAIN_TOKEN: w.tokens.alphabot, BRAIN_HEADERS: `{"X-Gateway-Secret": "${GW_SECRET}"` },
      input: '',
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/BRAIN_HEADERS is not valid JSON/);
    expect(r.stderr).not.toContain(GW_SECRET);
    expect(r.stderr).not.toContain(w.tokens.alphabot);
    expect(r.stdout).toBe('');
  });
});

describe('inbox-poll.sh with extra headers', () => {
  let h: Harness;
  let w: World;
  let rec: Awaited<ReturnType<typeof recorder>>;
  const SCRIPT = path.join(ROOT, 'scripts/inbox-poll.sh');

  beforeAll(async () => {
    h = await startHarness();
    w = buildWorld(h);
    rec = await recorder(h.url);
  });
  afterAll(async () => {
    await rec.close();
    await h.close();
  });

  // Async: the test server runs in this process, so a synchronous spawn would block it.
  const run = (env: Record<string, string>) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const p = spawn('sh', [SCRIPT], { env: { ...BASE_ENV, BRAIN_URL: rec.url, BRAIN_TOKEN: w.tokens.alphabot, ...env } });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      p.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      p.on('close', (status) => resolve({ status, stdout, stderr }));
    });

  it('BRAIN_HEADERS is sent on the request; an Authorization in it does not replace the token', async () => {
    rec.seen.length = 0;
    const r = await run({ BRAIN_HEADERS: JSON.stringify({ 'X-Gateway-Id': GW_ID, 'X-Gateway-Secret': `${GW_SECRET} "q" \\`, authorization: `Bearer ${w.tokens.alice}` }) });
    expect(r.status, r.stderr).toBe(1); // no mail
    expect(rec.seen.length).toBe(1);
    const hd = rec.seen[0]!;
    expect(hd['x-gateway-id']).toBe(GW_ID);
    expect(hd['x-gateway-secret']).toBe(`${GW_SECRET} "q" \\`);
    expect(hd.authorization).toBe(`Bearer ${w.tokens.alphabot}`);
    expect(r.stderr).toMatch(/Authorization header is ignored/);
    expect(r.stderr + r.stdout).not.toContain(GW_SECRET);
    expect(r.stderr + r.stdout).not.toContain(w.tokens.alice);
  });

  it('bad BRAIN_HEADERS: exit 2 before any request, never printing a value', async () => {
    rec.seen.length = 0;
    for (const bad of [`{"X":"${GW_SECRET}"`, `["${GW_SECRET}"]`, `{"X":1}`, `{"bad name":"${GW_SECRET}"}`, `{"X":"${GW_SECRET}\\nY"}`]) {
      const r = await run({ BRAIN_HEADERS: bad });
      expect(r.status, bad).toBe(2);
      expect(r.stderr, bad).toMatch(/^inbox-poll: BRAIN_HEADERS/);
      expect(r.stderr).not.toContain(GW_SECRET);
    }
    expect(rec.seen.length).toBe(0);
  });
});

describe('admin_connect_guide authenticates with the token and offers BRAIN_HEADERS', () => {
  const TRANSPORTS = ['http', 'stdio'] as const;

  it('every harness and transport: the token is the credential; stdio and script guides mention BRAIN_HEADERS', async () => {
    const h = await startHarness();
    try {
      const alice = buildWorld(h).client('alice');
      let n = 0;
      for (const harness of HARNESSES) {
        for (const transport of TRANSPORTS) {
          const r = await alice.raw('admin_connect_guide', { harness, transport });
          if (r.status === 400) continue; // e.g. connectome is stdio only, script is http only
          n++;
          expect(r.text).toMatch(/Authorization: Bearer|BRAIN_TOKEN/);
          if (transport === 'stdio' || harness === 'script') expect(r.text, `${harness}/${transport}`).toContain('BRAIN_HEADERS');
        }
      }
      expect(n).toBe(12);
    } finally {
      await h.close();
    }
  });
});
