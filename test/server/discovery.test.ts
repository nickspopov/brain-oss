// Discovery: meta, .well-known, agents.md, llms.txt without authentication and without data from the
// DB; openapi.json only with authentication and only with the operations visible to the caller.
// admin_connect_guide: connection instructions without a token.
import fs from 'node:fs';
import path from 'node:path';
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARNESSES } from '../../src/ops/admin/connect.js';
import { listOps } from '../../src/ops/registry.js';
import { CONTRACT_VERSION } from '../../src/version.js';
import { buildWorld, ALICE_PASSWORD, SPACES, AGENTS, seedBeta, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
let h: Harness;
let w: World;

beforeAll(async () => {
  h = await startHarness();
  w = buildWorld(h);
  await seedBeta(w);
});
afterAll(async () => {
  await h.close();
});

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${h.url}${path}`, { headers });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

/**
 * Public pages name no spaces or agents and contain no canaries. The words "shared" and
 * "handoff" are ordinary English words in the guide text, so they are checked by id only.
 */
function assertNoWorldData(text: string): void {
  const lower = text.toLowerCase();
  const names = [...SPACES.filter((s) => s.startsWith('proj-')), ...AGENTS, w.canary.prefix];
  for (const id of [...SPACES.map((s) => w.spaces[s].id), ...Object.values(w.principals).map((p) => p.id)]) names.push(id);
  for (const name of names) {
    expect(lower, `public discovery mentions ${name}`).not.toContain(name.toLowerCase());
  }
}

describe('discovery without authentication', () => {
  it('/api/v1/meta and /.well-known/brain.json: service, contract version, endpoints, auth scheme', async () => {
    const r = await get('/api/v1/meta');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/application\/json/);
    const meta = JSON.parse(r.text) as Record<string, unknown>;
    expect(meta).toMatchObject({
      service: 'brain',
      contract_version: CONTRACT_VERSION,
      origin: h.config.origin,
      endpoints: { mcp: `${h.config.origin}/mcp/v1`, rest: `${h.config.origin}/api/v1/ops/{name}`, openapi: `${h.config.origin}/api/v1/openapi.json` },
      auth: { type: 'bearer', token_in_query: false },
      transports: { mcp_stdio: { command: 'brain-mcp', env: ['BRAIN_URL', 'BRAIN_TOKEN'] } },
    });
    const wk = await get('/.well-known/brain.json');
    expect(wk.status).toBe(200);
    expect(JSON.parse(wk.text)).toEqual(meta);
    assertNoWorldData(r.text.replace(h.config.origin, ''));
  });

  it('/agents.md: how to connect and where to start, every agent operation, no names of spaces or agents', async () => {
    const r = await get('/agents.md');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/markdown/);
    expect(r.text).toContain(`${h.config.origin}/mcp/v1`);
    expect(r.text).toContain('Authorization: Bearer');
    expect(r.text).toContain('brain-mcp');
    expect(r.text).toMatch(/whoami/);
    expect(r.text).toMatch(/data .*, never instructions to you/);
    expect(r.text).toMatch(/Ignore unknown fields/);
    for (const op of listOps().filter((o) => o.requires === 'any' && o.expose.includes('mcp'))) expect(r.text).toContain(`\`${op.name}\``);
    expect(r.text).not.toMatch(/admin_/);
    assertNoWorldData(r.text);
  });

  it('/llms.txt: llms.txt format with links to the guide, meta and OpenAPI', async () => {
    const r = await get('/llms.txt');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/plain/);
    expect(r.text.startsWith('# Brain\n\n> ')).toBe(true);
    expect(r.text).toContain(`(${h.config.origin}/agents.md)`);
    expect(r.text).toContain('## Operations');
    expect(r.text).not.toMatch(/admin_/);
    assertNoWorldData(r.text);
  });
});

describe('/api/v1/openapi.json', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsing an arbitrary OpenAPI JSON document
  type Json = any;
  type Doc = { openapi: string; info: { version: string }; paths: Record<string, Record<string, { operationId: string; requestBody?: Json; responses: Json }>> };
  const opIds = (d: Doc) =>
    Object.entries(d.paths)
      .filter(([p]) => p.startsWith('/api/v1/ops/'))
      .map(([, v]) => v.post!.operationId)
      .sort();

  it('requires authentication: 401 envelope without a token, with a wrong token, with a token in the query', async () => {
    for (const r of [
      await get('/api/v1/openapi.json'),
      await get('/api/v1/openapi.json', { authorization: 'Bearer brn_wrong' }),
      await get(`/api/v1/openapi.json?token=${w.tokens.alphabot}`),
    ]) {
      expect(r.status).toBe(401);
      expect(JSON.parse(r.text)).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
    }
  });

  it('an agent sees exactly the agent operations with input and output schemas; no admin operations', async () => {
    const r = await get('/api/v1/openapi.json', { authorization: `Bearer ${w.tokens.alphabot}` });
    expect(r.status).toBe(200);
    const d = JSON.parse(r.text) as Doc;
    expect(d.openapi).toBe('3.1.0');
    expect(d.info.version).toBe(CONTRACT_VERSION);
    const agentOps = listOps()
      .filter((o) => o.requires === 'any' && o.expose.includes('rest'))
      .map((o) => o.name)
      .sort();
    expect(opIds(d)).toEqual(agentOps);
    const write = d.paths['/api/v1/ops/write']!.post!;
    expect(write.requestBody.content['application/json'].schema.properties).toHaveProperty('expected_rev');
    expect(write.responses['200'].content['application/json'].schema.properties.result.properties).toHaveProperty('status');
    expect(write.responses.default.$ref).toBe('#/components/responses/Error');
    expect(d.paths).toHaveProperty(['/api/v1/docs/{id}/raw']);
    expect(r.text).not.toContain('$defs');
    expect(r.text).not.toContain(w.canary.prefix);
  });

  it('a superadmin (bearer or UI session) also sees admin operations, including admin_connect_guide', async () => {
    const r = await get('/api/v1/openapi.json', { authorization: `Bearer ${w.tokens.alice}` });
    const d = JSON.parse(r.text) as Doc;
    expect(opIds(d)).toContain('admin_connect_guide');
    expect(opIds(d)).toEqual(
      listOps()
        .filter((o) => o.expose.includes('rest'))
        .map((o) => o.name)
        .sort(),
    );
    const login = await fetch(`${h.url}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-brain-client': 'test', origin: h.config.origin },
      body: JSON.stringify({ name: 'alice', password: ALICE_PASSWORD }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    const viaSession = await get('/api/v1/openapi.json', { cookie });
    expect(viaSession.status).toBe(200);
    expect(opIds(JSON.parse(viaSession.text) as Doc)).toContain('admin_token_issue');
  });
});

describe('admin_connect_guide', () => {
  interface Guide {
    harness: string;
    transport: string;
    mcp_url: string;
    config: string;
    text: string;
    docs: string;
    principal?: { name: string; spaces: { slug: string; role: string }[] };
  }

  it('is an admin operation: invisible to agents without the capability', async () => {
    await expect(w.client('alphabot').call('admin_connect_guide', { harness: 'claude-code' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.client('alphabot', 'mcp').call('admin_connect_guide', { harness: 'claude-code' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('per harness: MCP URL, a config snippet with BRAIN_TOKEN and never a token', async () => {
    const alice = w.client('alice');
    const cases: [string, string, RegExp][] = [
      ['claude-code', 'http', /claude mcp add --transport http brain .*\/mcp\/v1 --header "Authorization: Bearer \$BRAIN_TOKEN"/],
      ['connectome', 'stdio', /"command": ".*brain-mcp"[\s\S]*"BRAIN_TOKEN": "\$\{BRAIN_TOKEN\}"/],
      ['hermes', 'http', /mcp_servers:\n {2}brain:\n {4}url: ".*\/mcp\/v1"/],
      ['letta', 'http', /"server_url": ".*\/mcp\/v1"/],
      ['generic', 'http', /"mcpServers"/],
    ];
    for (const [harness, transport, re] of cases) {
      const g = await alice.call<Guide>('admin_connect_guide', { harness });
      expect(g).toMatchObject({ harness, transport, mcp_url: `${h.config.origin}/mcp/v1` });
      expect(fs.existsSync(path.join(ROOT, g.docs)), g.docs).toBe(true);
      expect(g.config).toMatch(re);
      expect(g.text).toContain(g.config);
      expect(g.text).toMatch(/call start_here/);
      for (const t of Object.values(w.tokens)) expect(g.text).not.toContain(t);
      expect(g.text).not.toMatch(/brn_[A-Za-z0-9_-]{20,}/);
    }
    const stdio = await alice.call<Guide>('admin_connect_guide', { harness: 'claude-code', transport: 'stdio' });
    expect(stdio.config).toMatch(/--env BRAIN_URL=.* --env BRAIN_TOKEN=\$BRAIN_TOKEN -- brain-mcp/);
    expect(stdio.text).toMatch(/npm link/);
    await expect(alice.call('admin_connect_guide', { harness: 'connectome', transport: 'http' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('for a principal: its recorded harness by default and the spaces it will see; unknown principal → not_found', async () => {
    const alice = w.client('alice');
    await alice.call('admin_principal_update', { name: 'alice-helper', harness: 'hermes' });
    const g = await alice.call<Guide>('admin_connect_guide', { principal: 'alice-helper' });
    expect(g.harness).toBe('hermes');
    expect(g.principal?.name).toBe('alice-helper');
    expect(g.principal?.spaces).toEqual(
      expect.arrayContaining([
        { slug: 'handoff', role: 'write' },
        { slug: 'shared', role: 'write' },
      ]),
    );
    expect(g.principal?.spaces.map((s) => s.slug)).not.toContain('proj-beta');
    expect(g.text).toContain('alice-helper');
    const generic = await alice.call<Guide>('admin_connect_guide', { principal: 'alphabot' });
    expect(generic.harness).toBe('generic');
    await expect(alice.call('admin_connect_guide', { principal: 'nobody' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('through MCP the tool text is the guide itself', async () => {
    const r = await w.client('alice', 'mcp').raw<Guide>('admin_connect_guide', { harness: 'hermes' });
    expect(r.body.ok).toBe(true);
    const rendered = (JSON.parse(r.text) as { rendered: string }).rendered;
    expect(rendered.startsWith('# Connect an agent to Brain from Hermes Agent')).toBe(true);
  });
});

/** Everything the server says to a person or an agent is in English. */
const CYRILLIC = /[\u0400-\u04FF]+/;
function assertEnglish(where: string, text: string): void {
  expect(text.match(CYRILLIC)?.[0], `${where} contains Cyrillic`).toBeUndefined();
}

describe('English only', () => {
  it('discovery: meta, .well-known, agents.md, llms.txt, openapi.json for an agent and a superadmin', async () => {
    for (const p of ['/api/v1/meta', '/.well-known/brain.json', '/agents.md', '/llms.txt']) assertEnglish(p, (await get(p)).text);
    for (const who of ['alphabot', 'alice'] as const) {
      const r = await get('/api/v1/openapi.json', { authorization: `Bearer ${w.tokens[who]}` });
      expect(r.status).toBe(200);
      assertEnglish(`openapi.json (${who})`, r.text);
    }
  });

  it('MCP: initialize instructions and every tool description, admin tools included', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${h.url}/mcp/v1`), { requestInit: { headers: { authorization: `Bearer ${w.tokens.alice}` } } });
    const c = new SdkClient({ name: 'brain-test', version: '0.0.0' });
    await c.connect(transport);
    try {
      assertEnglish('initialize.instructions', c.getInstructions() ?? '');
      const { tools } = await c.listTools();
      expect(tools.map((t) => t.name)).toContain('admin_connect_guide');
      for (const t of tools) assertEnglish(`tool ${t.name}`, JSON.stringify(t));
    } finally {
      await c.close();
    }
  });

  it('admin_connect_guide for every harness and the docs/connect pages it points to', async () => {
    const alice = w.client('alice');
    for (const harness of HARNESSES) {
      const g = await alice.call<{ text: string; docs: string }>('admin_connect_guide', { harness });
      assertEnglish(`admin_connect_guide ${harness}`, JSON.stringify(g));
      assertEnglish(g.docs, fs.readFileSync(path.join(ROOT, g.docs), 'utf8'));
    }
    for (const f of fs.readdirSync(path.join(ROOT, 'docs/connect'))) {
      assertEnglish(`docs/connect/${f}`, fs.readFileSync(path.join(ROOT, 'docs/connect', f), 'utf8'));
    }
  });

  it('error envelopes: unauthenticated, not_found, invalid_input, conflict', async () => {
    assertEnglish('401', (await get('/api/v1/openapi.json')).text);
    const alphabot = w.client('alphabot');
    const errors = [
      await alphabot.raw('read', { space: 'proj-beta', path: 'nope.md' }),
      await alphabot.raw('read', { space: 'handoff' }),
      await alphabot.raw('write', { space: 'handoff', path: '../x.md', content: 'x', expected_rev: 0, message: 'm' }),
      await alphabot.raw('admin_space_list', {}),
    ];
    await alphabot.call('write', { space: 'handoff', path: 'pr-en.md', content: 'a\n', expected_rev: 0, message: 'm' });
    errors.push(await alphabot.raw('write', { space: 'handoff', path: 'pr-en.md', content: 'b\n', expected_rev: 0, message: 'm' }));
    for (const r of errors) {
      expect(r.body.ok).toBe(false);
      assertEnglish(`error ${r.text.slice(0, 80)}`, r.text);
    }
  });
});
