// brain-mcp, the stdio proxy: a real process, launched the way a harness launches it.
// The proxy has no logic: the server decides rights, token revocation and errors; a transport failure
// (401, server unreachable) reaches the agent as a tool result with a code, not a dropped connection.
// The token is never printed.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpEndpoint } from '../../src/adapters/stdio/proxy.js';
import { issueToken, revokeToken } from '../../src/core/tokens.js';
import { connectAgent, ok, textOf, tool } from '../helpers/clients/sdk.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TSX = path.join(ROOT, 'node_modules/.bin/tsx');
const BIN = path.join(ROOT, 'src/adapters/stdio/bin.ts');

describe('mcpEndpoint (BRAIN_URL)', () => {
  it('accepts an origin or the full /mcp/v1 address; rejects credentials, queries and other schemes', () => {
    expect(mcpEndpoint('https://brain.example').href).toBe('https://brain.example/mcp/v1');
    expect(mcpEndpoint('https://brain.example/').href).toBe('https://brain.example/mcp/v1');
    expect(mcpEndpoint('https://brain.example/mcp/v1').href).toBe('https://brain.example/mcp/v1');
    expect(mcpEndpoint('http://127.0.0.1:7460/brain').href).toBe('http://127.0.0.1:7460/brain/mcp/v1');
    expect(() => mcpEndpoint('https://brain.example/mcp/v1?token=brn_x')).toThrow(/query/);
    expect(() => mcpEndpoint('https://user:pw@brain.example')).toThrow(/credentials/);
    expect(() => mcpEndpoint('ftp://brain.example')).toThrow(/http/);
    expect(() => mcpEndpoint('not a url')).toThrow(/not a URL/);
  });
});

describe('brain-mcp process', () => {
  let h: Harness;
  let w: World;

  beforeAll(async () => {
    h = await startHarness();
    w = buildWorld(h, 'mcp');
  });
  afterAll(async () => {
    await h.close();
  });

  it('without BRAIN_TOKEN (or with a token in BRAIN_URL) exits with code 2 and a message on stderr, nothing on stdout', () => {
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
    const noToken = spawnSync(TSX, [BIN], { cwd: ROOT, env: { ...env, BRAIN_URL: h.url }, input: '', encoding: 'utf8', timeout: 60_000 });
    expect(noToken.status).toBe(2);
    expect(noToken.stderr).toMatch(/BRAIN_TOKEN is not set/);
    expect(noToken.stdout).toBe('');
    const inUrl = spawnSync(TSX, [BIN], {
      cwd: ROOT,
      env: { ...env, BRAIN_URL: `${h.url}/mcp/v1?token=${w.tokens.alphabot}`, BRAIN_TOKEN: w.tokens.alphabot },
      input: '',
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(inUrl.status).toBe(2);
    expect(inUrl.stderr).toMatch(/must not carry credentials or a query/);
    expect(inUrl.stderr).not.toContain(w.tokens.alphabot);
  });

  it('a wrong token: tools/list fails with unauthenticated, tools/call is an isError result; failures are audited via=mcp', async () => {
    const failures = () => (h.core.db.prepare("SELECT count(*) AS n FROM audit WHERE via = 'mcp' AND outcome != 'ok'").get() as { n: number }).n;
    const before = failures();
    const a = await connectAgent(h, 'brn_wrongwrongwrongwrongwrongwrongwrongwrongwro', 'stdio');
    try {
      await expect(a.client.listTools()).rejects.toThrow(/ERROR unauthenticated/);
      const r = await tool(a.client, 'whoami');
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/^ERROR unauthenticated: /);
      expect((r.structuredContent as { error: { code: string } }).error.code).toBe('unauthenticated');
      expect(a.stderr()).not.toContain('brn_wrong');
      expect(failures()).toBeGreaterThan(before);
    } finally {
      await a.client.close();
    }
  });

  it('revoking the token takes effect on the next call through an open proxy (a02 over stdio)', async () => {
    const t = issueToken(h.core, w.principals.alphabot.id, { label: 'stdio revoke', createdBy: w.principals.alice.id });
    const a = await connectAgent(h, t.token, 'stdio');
    try {
      const me = await ok<{ principal: { name: string } }>(a.client, 'whoami');
      expect(me.out.principal.name).toBe('alphabot');
      revokeToken(h.core, t.id, w.principals.alice.id);
      const r = await tool(a.client, 'whoami');
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/^ERROR unauthenticated: /);
    } finally {
      await a.client.close();
    }
  });

  it('the proxy adds no rights: hidden spaces stay not_found, admin tools stay invisible', async () => {
    const a = await connectAgent(h, w.tokens.alphabot, 'stdio');
    try {
      const names = (await a.client.listTools()).tools.map((x) => x.name);
      expect(names.some((n) => n.startsWith('admin_'))).toBe(false);
      const hidden = await tool(a.client, 'list', { space: 'proj-beta' });
      const missing = await tool(a.client, 'list', { space: 'no-such-space' });
      expect(hidden.isError).toBe(true);
      expect(hidden.structuredContent).toEqual(missing.structuredContent);
      expect(textOf(hidden)).toBe(textOf(missing));
      const admin = await tool(a.client, 'admin_principal_list');
      expect(textOf(admin)).toMatch(/^ERROR not_found: /);
    } finally {
      await a.client.close();
    }
  });

  it('server unreachable: the proxy still starts; calls return a retryable tool error naming the cause', async () => {
    // A free port: start and close a second server.
    const other = await startHarness();
    const url = other.url;
    await other.close();
    const a = await connectAgent({ url }, w.tokens.alphabot, 'stdio');
    try {
      expect(a.client.getInstructions() ?? '').toMatch(/start_here/);
      const r = await tool(a.client, 'whoami');
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/^ERROR internal: brain-mcp could not reach the Brain server/);
      expect((r.structuredContent as { error: { retryable: boolean } }).error.retryable).toBe(true);
      expect(a.stderr()).toMatch(/cannot connect/);
      expect(a.stderr()).not.toContain(w.tokens.alphabot);
    } finally {
      await a.client.close();
    }
  });
});
