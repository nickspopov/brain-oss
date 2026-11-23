// "Connect an agent": one step creates the agent,
// its explicit memberships and a token atomically; the bundle (token + ready config) is shown once and never
// stored; "Connected" flips only on the first authenticated request with that token; the live check ends with a
// negative probe made as the agent (not_found for every other space, never naming it to the agent). Brain's
// product surfaces know nothing about what sits in front of it.
import { afterEach, describe, expect, it } from 'vitest';
import { patchPrincipal } from '../../src/core/principals.js';
import { HARNESSES } from '../../src/ops/admin/connect.js';
import { makeClient, type Client } from '../helpers/clients/index.js';
import { assertNoMarkers, buildWorld, hiddenMarkers, seedBeta, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
let w: World;

afterEach(async () => {
  await h?.close();
});

async function world(): Promise<void> {
  h = await startHarness();
  w = buildWorld(h);
}

interface Bundle {
  harness: string;
  transport: string;
  server_url: string;
  mcp_url: string;
  where: string;
  config: string;
  sentence: string;
  text: string;
  filename: string;
}
interface ConnectOut {
  principal: { name: string; display_name: string; harness: string | null; owner: string | null; external: { owner_label: string | null } | null; trust: string };
  token: string;
  info: { id: string; prefix: string; principal: string };
  spaces: { slug: string; role: string }[];
  bundle: Bundle;
}
interface Probe {
  space: string;
  name: string;
  canary: boolean;
  list: string;
  read: string;
  confirmed: boolean;
}
interface Status {
  principal: string;
  connected: boolean;
  last_contact_at: string | null;
  token: { id: string; revoked: boolean };
  sees: { space: string; name: string; role: string; messages_only: boolean; via: string[] }[];
  not_sees: { count: number; probes: Probe[]; all_confirmed: boolean } | null;
}

const ALPHA_SPACES = [
  { space: 'proj-alpha', role: 'write' },
  { space: 'handoff', role: 'guest' },
];

function connect(alice: Client, extra: Record<string, unknown> = {}): Promise<ConnectOut> {
  return alice.call<ConnectOut>('admin_agent_connect', { name: 'alpha-helper', display_name: 'Alpha helper', owner: 'alice', harness: 'claude-code', spaces: ALPHA_SPACES, ...extra });
}

function dbText(table: string): string {
  return JSON.stringify(h.core.db.prepare(`SELECT * FROM ${table}`).all());
}

describe('admin_agent_connect: one step, atomic', () => {
  it('creates the agent, exactly the listed memberships and a token; no General, no all-agents', async () => {
    await world();
    const alice = w.client('alice');
    const out = await connect(alice);
    expect(out.principal).toMatchObject({ name: 'alpha-helper', display_name: 'Alpha helper', harness: 'claude-code', owner: 'alice', external: null, trust: 'trusted' });
    expect(out.token).toMatch(/^brn_/);
    expect(out.info.principal).toBe('alpha-helper');
    const grants = await alice.call<{ grants: { space: string; scope: string; role: string; subject: { name: string } }[] }>('admin_grant_list', {
      subject: { type: 'principal', name: 'alpha-helper' },
    });
    expect(grants.grants.map((g) => `${g.space}:${g.scope}:${g.role}`).sort()).toEqual(['handoff:space:guest', 'proj-alpha:space:write']);
    const groups = await alice.call<{ groups: { name: string; members: string[] }[] }>('admin_group_list');
    // all-agents is computed (it does count every internal agent) but gives nothing in proj-* or spaces with messages.
    expect(groups.groups.filter((g) => g.name !== 'all-agents' && g.members.includes('alpha-helper'))).toEqual([]);
    const tokens = await alice.call<{ tokens: { id: string }[] }>('admin_token_list', { principal: 'alpha-helper' });
    expect(tokens.tokens.map((t) => t.id)).toEqual([out.info.id]);
    // The token works at once, for exactly these spaces.
    const agent = makeClient('mcp', h, out.token);
    const me = await agent.call<{ spaces: { slug: string }[] }>('spaces');
    expect(me.spaces.map((s) => s.slug).sort()).toEqual(['proj-alpha', 'recipes']); // recipes: ambient read (not isolated)
  });

  it('a refused step leaves nothing behind: no principal, no grant, no token', async () => {
    await world();
    const alice = w.client('alice');
    const ids = (t: string) => JSON.stringify(h.core.db.prepare(`SELECT * FROM ${t}`).all().map((r) => (r as { id: string }).id));
    const before = { p: dbText('principals'), g: dbText('grants'), t: ids('tokens') };
    const cases: [Record<string, unknown>, string][] = [
      [{ spaces: [{ space: 'proj-alpha', role: 'write' }, { space: 'recipes', role: 'guest' }] }, 'invalid_input'], // Guest needs messages
      [{ spaces: [{ space: 'proj-alpha', role: 'write' }, { space: 'no-such-space', role: 'read' }] }, 'not_found'],
      [{ spaces: [{ space: 'proj-alpha', role: 'write' }, { space: 'proj-alpha', role: 'read' }] }, 'invalid_input'],
      [{ owner: 'betabot' }, 'invalid_input'], // the manager is a person
      [{ owner: 'alice', outside: 'Ann' }, 'invalid_input'],
      [{ harness: 'connectome', transport: 'http' }, 'invalid_input'],
    ];
    for (const [patch, code] of cases) {
      const r = await alice.raw('admin_agent_connect', { name: 'alpha-helper', owner: 'alice', harness: 'claude-code', spaces: ALPHA_SPACES, ...patch });
      expect(r.body.ok, JSON.stringify(patch)).toBe(false);
      if (!r.body.ok) expect(r.body.error.code, JSON.stringify(patch)).toBe(code);
    }
    // A name that exists already: refused, the existing agent untouched.
    expect((await alice.raw('admin_agent_connect', { name: 'alphabot', harness: 'generic', spaces: [{ space: 'shared', role: 'admin' }] })).body.ok).toBe(false);
    expect({ p: dbText('principals'), g: dbText('grants'), t: ids('tokens') }).toEqual(before);
  });

  it('External: a manager outside Brain, chosen by a human only (an admin agent is refused, nothing created)', async () => {
    await world();
    const out = await connect(w.client('alice'), { outside: 'Ann Smith', owner: undefined, spaces: [{ space: 'handoff', role: 'guest' }] });
    expect(out.principal.external?.owner_label).toBe('Ann Smith');
    expect(out.principal.trust).toBe('limited');
    patchPrincipal(h.core, w.principals['alice-assistant'].id, { can_admin: 1 });
    const before = dbText('principals');
    const r = await w.client('alice-assistant').raw('admin_agent_connect', { name: 'ext-two', outside: 'Bob', harness: 'generic', spaces: [] });
    expect(r.status).toBe(403);
    expect(dbText('principals')).toBe(before);
  });
});

describe('the bundle: shown once, never stored', () => {
  it('carries the token and the real URL for every harness; a repeated request_id answers conflict without it', async () => {
    await world();
    const alice = w.client('alice');
    const origin = h.config.origin;
    let n = 0;
    for (const harness of HARNESSES) {
      const out = await alice.call<ConnectOut>('admin_agent_connect', { name: `agent-${harness}`, harness, spaces: [{ space: 'shared', role: 'read' }] });
      n++;
      const b = out.bundle;
      expect(b.harness).toBe(harness);
      expect(b.config, harness).toContain(out.token);
      expect(b.config, harness).toContain(origin);
      expect(b.config, harness).not.toContain('${BRAIN_TOKEN}');
      expect(b.text, harness).toContain(out.token);
      expect(b.sentence, harness).toMatch(/connect to Brain.*call start_here/i);
      expect(b.filename).toMatch(new RegExp(`^brain-agent-${harness}-${harness}\\.(sh|json|toml|txt)$`));
    }
    expect(n).toBe(7);
    expect((await alice.call<ConnectOut>('admin_agent_connect', { name: 'a-cc', harness: 'claude-code', spaces: [] })).bundle.config).toMatch(/^claude mcp add --transport http brain /);
    expect((await alice.call<ConnectOut>('admin_agent_connect', { name: 'a-hermes', harness: 'hermes', spaces: [] })).bundle.config).toMatch(/^hermes mcp add brain --url /);
    expect((await alice.call<ConnectOut>('admin_agent_connect', { name: 'a-codex', harness: 'codex', spaces: [] })).bundle.config).toMatch(/^\[mcp_servers\.brain\]/);
    expect((await alice.call<ConnectOut>('admin_agent_connect', { name: 'a-script', harness: 'script', spaces: [] })).bundle.config).toContain('inbox-poll.sh');

    // Once: the same request_id does not give the bundle again.
    const first = await alice.call<ConnectOut>('admin_agent_connect', { name: 'once', harness: 'generic', spaces: [], request_id: 'connect-once-1' });
    const again = await alice.raw('admin_agent_connect', { name: 'once', harness: 'generic', spaces: [], request_id: 'connect-once-1' });
    expect(again.status).toBe(409);
    expect(again.text).toContain('token_already_issued');
    expect(again.text).not.toContain(first.token);
    // Not in the idempotency table, the audit, the logs or any other table; REST answered no-store.
    for (const table of ['idempotency', 'audit', 'principals', 'tokens', 'grants']) expect(dbText(table), table).not.toContain(first.token);
    expect(h.logs.join('\n')).not.toContain(first.token);
    const raw = await alice.raw('admin_agent_connect', { name: 'once-2', harness: 'generic', spaces: [] });
    expect(raw.headers['cache-control']).toBe('no-store');
    // No read op gives it back: the guide has no token, the status has no token.
    const guide = await alice.raw('admin_connect_guide', { principal: 'once' });
    expect(guide.text).not.toContain(first.token);
    const st = await alice.raw('admin_agent_connection', { name: 'once', token_id: first.info.id });
    expect(st.text).not.toContain(first.token);
    // The audit row says who was connected where, nothing more.
    const row = h.core.db.prepare("SELECT detail FROM audit WHERE op = 'admin_agent_connect' AND outcome = 'ok' ORDER BY id LIMIT 1").get() as { detail: string };
    expect(JSON.parse(row.detail)).toMatchObject({ name: 'agent-claude-code', harness: 'claude-code', spaces: ['shared:read'] });
  });
});

describe('admin_agent_connection: live check and negative probe', () => {
  it('flips to Connected only on an authenticated request with that token', async () => {
    await world();
    const alice = w.client('alice');
    const out = await connect(alice);
    const status = () => alice.call<Status>('admin_agent_connection', { name: 'alpha-helper', token_id: out.info.id });
    let s = await status();
    expect(s.connected).toBe(false);
    expect(s.last_contact_at).toBeNull();
    expect(s.not_sees).toBeNull();
    // Not by reading the guide, the token list, the status itself, or a request with a wrong token.
    await alice.call('admin_connect_guide', { principal: 'alpha-helper' });
    await alice.call('admin_token_list', { principal: 'alpha-helper' });
    await status();
    const wrong = `${out.token.slice(0, -2)}${out.token.endsWith('AA') ? 'BB' : 'AA'}`;
    expect((await makeClient('mcp', h, wrong).raw('whoami')).status).toBe(401);
    // Nor by another token of the same agent.
    const other = await alice.call<{ token: string }>('admin_token_issue', { principal: 'alpha-helper' });
    await makeClient('rest', h, other.token).call('whoami');
    expect((await status()).connected).toBe(false);
    // The first authenticated call with it.
    await makeClient('mcp', h, out.token).call('start_here');
    s = await status();
    expect(s.connected).toBe(true);
    expect(s.last_contact_at).not.toBeNull();
    // Revoked: no longer connected.
    await alice.call('admin_token_revoke', { id: out.info.id });
    expect((await status()).connected).toBe(false);
  });

  it('Sees its spaces with roles; Does not see: every other active space, each a confirmed not_found (Alpha↛Beta)', async () => {
    await world();
    const docs = await seedBeta(w);
    const alice = w.client('alice');
    const out = await connect(alice);
    const agent = makeClient('rest', h, out.token);
    // A fresh agent: start_here asks for its profile first.
    const start = await agent.call<{ onboarding: { pending: boolean; op?: string } }>('start_here');
    expect(start.onboarding).toMatchObject({ pending: true, op: 'profile_update' });
    const s = await alice.call<Status>('admin_agent_connection', { name: 'alpha-helper', token_id: out.info.id });
    expect(s.connected).toBe(true);
    expect(s.sees.map((x) => `${x.space}:${x.role}${x.messages_only ? ':messages' : ''}`).sort()).toEqual(['handoff:guest:messages', 'proj-alpha:editor', 'recipes:viewer']);
    expect(s.sees.find((x) => x.space === 'recipes')?.via).toEqual(['all-agents']);
    expect(s.sees.find((x) => x.space === 'proj-alpha')?.via).toEqual([]);
    const ns = s.not_sees!;
    expect(ns.count).toBe(2);
    expect(ns.probes.map((p) => p.space).sort()).toEqual(['proj-beta', 'shared']);
    for (const p of ns.probes) expect(p, p.space).toMatchObject({ list: 'not_found', read: 'not_found', confirmed: true });
    expect(ns.probes.find((p) => p.space === 'proj-beta')).toMatchObject({ name: 'Beta project', canary: true });
    expect(ns.all_confirmed).toBe(true);
    // An archived space is not counted.
    await alice.call('admin_space_archive', { slug: 'shared' });
    expect((await alice.call<Status>('admin_agent_connection', { name: 'alpha-helper', token_id: out.info.id })).not_sees!.count).toBe(1);

    // The agent itself never learns the other spaces' names: the status op does not exist for it, and its own
    // reads of the hidden space answer exactly like a missing one.
    const markers = [...hiddenMarkers(w, docs), 'Beta project'];
    const asAgent = await agent.raw('admin_agent_connection', { name: 'alpha-helper', token_id: out.info.id });
    const missing = await agent.raw('no_such_op', {});
    expect(asAgent.status).toBe(missing.status);
    expect(asAgent.text.replace('admin_agent_connection', 'X')).toBe(missing.text.replace('no_such_op', 'X'));
    for (const [op, input] of [
      ['list', { space: 'proj-beta' }],
      ['read', { space: 'proj-beta', path: docs.paths.plain }],
      ['read', { id: docs.secret.doc.id }],
      ['search', { query: w.canary.body }],
      ['spaces', {}],
      ['start_here', {}],
      ['profile_get', { name: 'betabot' }],
      ['handoff_recipients', {}],
      ['admin_connect_guide', {}],
    ] as const) {
      for (const c of [agent, makeClient('mcp', h, out.token)]) {
        const r = await c.raw(op, input);
        assertNoMarkers(r.text, markers, `${c.adapter} ${op}`);
      }
    }
  });

  it('a probe that would see the space is not confirmed', async () => {
    await world();
    await seedBeta(w);
    const alice = w.client('alice');
    const out = await connect(alice, { spaces: [{ space: 'proj-alpha', role: 'write' }] });
    await makeClient('rest', h, out.token).call('whoami');
    // A folder grant in proj-beta opens part of it: it is now among "Sees", not "Does not see".
    await alice.call('admin_grant_set', { space: 'proj-beta', scope: 'path', path_prefix: 'notes', subject: { type: 'principal', name: 'alpha-helper' }, role: 'read' });
    const s = await alice.call<Status>('admin_agent_connection', { name: 'alpha-helper', token_id: out.info.id });
    expect(s.not_sees!.probes.map((p) => p.space)).not.toContain('proj-beta');
    expect(s.sees.map((x) => x.space)).toContain('proj-beta');
  });

  it('is for Brain administrators only and checks that the token is that agent’s', async () => {
    await world();
    const alice = w.client('alice');
    const out = await connect(alice);
    expect((await alice.raw('admin_agent_connection', { name: 'alphabot', token_id: out.info.id })).status).toBe(404);
    expect((await alice.raw('admin_agent_connection', { name: 'alpha-helper', token_id: w.tokenIds.alphabot })).status).toBe(404);
    expect((await w.client('alphabot').raw('admin_agent_connect', { name: 'x-agent', harness: 'generic', spaces: [] })).status).toBe(404);
  });
});
