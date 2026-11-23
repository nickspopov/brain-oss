// List without space, validation errors name the field, case-insensitive path conflicts,
// the space creator gets admin.
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAgentsMd } from '../../src/adapters/http/discovery.js';
import { createPrincipal } from '../../src/core/principals.js';
import { issueToken } from '../../src/core/tokens.js';
import { getOp } from '../../src/ops/registry.js';
import { ApiError } from '../helpers/clients/types.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
let w: World;
const open: SdkClient[] = [];

beforeEach(async () => {
  h = await startHarness();
  w = buildWorld(h, 'rest');
});
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
  await h.close();
});

async function mcp(token: string): Promise<SdkClient> {
  const transport = new StreamableHTTPClientTransport(new URL(`${h.url}/mcp/v1`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new SdkClient({ name: 'brain-test', version: '0.0.0' });
  await client.connect(transport);
  open.push(client);
  return client;
}
const textOf = (r: CallToolResult): string => r.content.map((x) => (x.type === 'text' ? x.text : '')).join('\n');

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected an error');
}

function auditDetail(op: string, outcome: string): unknown {
  const row = h.core.db.prepare('SELECT detail FROM audit WHERE op = ? AND outcome = ? ORDER BY id DESC LIMIT 1').get(op, outcome) as
    | { detail: string | null }
    | undefined;
  return row?.detail ? JSON.parse(row.detail) : undefined;
}

/** An agent with the admin capability (role admin) and no grants. */
function adminAgent(): { id: string; token: string } {
  const p = createPrincipal(h.core, { name: 'curator-bot', kind: 'agent', trust: 'trusted', admin: true, ownerId: w.principals.alice.id }, w.principals.alice.id);
  return { id: p.id, token: issueToken(h.core, p.id, { label: 'admin agent', createdBy: w.principals.alice.id }).token };
}

describe('list without space', () => {
  it('returns the caller’s spaces (slug, role, description, AGENTS.md readable), never invisible ones', async () => {
    await w.client('alice').call('write', { space: 'proj-alpha', path: 'AGENTS.md', content: '# Rules', expected_rev: 0, message: 'rules' });
    const r = await w.client('alphabot').call<{ entries: unknown[]; spaces: { slug: string; role: string; description: string; agents_md: boolean }[] }>('list', {});
    expect(r.entries).toEqual([]);
    expect(r.spaces.map((s) => s.slug)).toEqual(['handoff', 'proj-alpha', 'recipes', 'shared']);
    expect(r.spaces.find((s) => s.slug === 'proj-alpha')).toEqual({ slug: 'proj-alpha', role: 'write', description: '', agents_md: true });
    expect(r.spaces.find((s) => s.slug === 'shared')).toEqual({ slug: 'shared', role: 'read', description: 'Common knowledge', agents_md: false });
    // Same data as `spaces` (slugs and roles).
    const sp = await w.client('alphabot').call<{ spaces: { slug: string; role: string }[] }>('spaces', {});
    expect(sp.spaces.map((s) => [s.slug, s.role]).sort()).toEqual(r.spaces.map((s) => [s.slug, s.role]));
  });

  it('over MCP: text lists the spaces; with a space it is the tree as before; spaces still works', async () => {
    const c = await mcp(w.tokens.alphabot);
    const r = (await c.callTool({ name: 'list', arguments: {} })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    const text = textOf(r);
    expect(text).toContain('Your spaces (call list with space to see its tree):');
    expect(text).toContain('proj-alpha (write)');
    expect(text).not.toContain('proj-beta');
    const tree = (await c.callTool({ name: 'list', arguments: { space: 'proj-alpha' } })) as CallToolResult;
    expect(textOf(tree)).toContain('Empty.');
    const sp = (await c.callTool({ name: 'spaces', arguments: {} })) as CallToolResult;
    expect(sp.isError).toBeFalsy();
  });

  it('schema: space is optional; path or cursor without space is invalid_input naming space', async () => {
    const tool = getOp('list')!;
    expect(tool.description).toMatch(/^Without space: lists the spaces you can see/);
    const e = await failure(w.client('alphabot').call('list', { path: 'notes' }));
    expect(e.code).toBe('invalid_input');
    expect(e.message).toContain('space: required when path is given');
  });
});

describe('validation errors name the field', () => {
  it('REST: message and issues name the fields and rules, never the values', async () => {
    const e = await failure(w.client('alphabot').call('list', { space: 'proj-alpha', depth: 9, include_deleted: 'zzvalue', bogus_key: 1 }));
    expect(e.code).toBe('invalid_input');
    const raw = e.raw.text;
    expect(raw).not.toContain('zzvalue');
    expect(e.details?.issues).toEqual(
      expect.arrayContaining([
        { path: 'depth', message: 'must be 1–5' },
        { path: 'include_deleted', message: 'must be true or false' },
        { path: 'bogus_key', message: 'unknown field' },
      ]),
    );
    expect(e.raw.body).toMatchObject({ error: { message: expect.stringMatching(/^Input is invalid: .*depth: must be 1–5/) } });
  });

  it('a required field is "required"; enums list the allowed values; strings give the length', async () => {
    const missing = await failure(w.client('alphabot').call('read', { space: 'proj-alpha' }));
    expect(missing.code).toBe('invalid_input');
    const write = await failure(w.client('alphabot').call('write', { space: 'proj-alpha', path: 'a.md', content: 'x' }));
    expect(write.details?.issues).toEqual([{ path: 'message', message: 'required' }]);
    expect((write.raw.body as { error: { message: string } }).error.message).toBe('Input is invalid: message: required.');
    const grant = await failure(w.client('alice').call('admin_grant_set', { space: 'shared', scope: 'space', subject: { type: 'principal', name: 'alphabot' }, role: 'owner' }));
    expect(grant.details?.issues).toEqual([{ path: 'role', message: 'must be one of "none", "guest", "read", "propose", "write", "admin"' }]);
    const empty = await failure(w.client('alphabot').call('list', { space: '' }));
    expect(empty.details?.issues).toEqual([{ path: 'space', message: 'must not be empty' }]);
  });

  it('a hostile unknown key is not echoed', async () => {
    const e = await failure(w.client('alphabot').call('list', { space: 'proj-alpha', 'zz<script>': 1 }));
    expect(e.raw.text).not.toContain('zz<script>');
    expect(e.details?.issues).toEqual([{ path: '(unnamed)', message: 'unknown field' }]);
  });

  it('MCP: the error text names the field; the audit row stores field names only', async () => {
    const c = await mcp(w.tokens.alphabot);
    const r = (await c.callTool({ name: 'list', arguments: { space: 'proj-alpha', depth: 0 } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('ERROR invalid_input: Input is invalid: depth: must be 1–5.');
    expect(auditDetail('list', 'invalid_input')).toEqual({ fields: ['depth'] });
  });

  it('errors raised in the core also name the field, and the audit row keeps the field', async () => {
    const e = await failure(w.client('alphabot').call('write', { space: 'proj-alpha', path: '/abs.md', content: 'x', expected_rev: 0, message: 'm' }));
    expect(e.code).toBe('invalid_input');
    expect(e.message).toContain('Input is invalid: path: Path must not start or end with "/"');
    expect(auditDetail('write', 'invalid_input')).toEqual({ fields: ['path'] });
  });
});

describe('case-insensitive paths', () => {
  it('write that differs only by case: conflict names the existing path', async () => {
    const alice = w.client('alice');
    await alice.call('write', { space: 'shared', path: 'admin/AGENTS.md', content: '# A', expected_rev: 0, message: 'm' });
    for (const input of [{}, { expected_rev: 0 }, { expected_rev: 7 }]) {
      const e = await failure(alice.call('write', { space: 'shared', path: 'admin/agents.md', content: '# B', message: 'm', ...input }));
      expect(e.code).toBe('conflict');
      expect(e.message).toBe("write failed: conflict: Path conflicts with existing 'admin/AGENTS.md' (paths are case-insensitive).");
      expect(e.details).toMatchObject({ existing_path: 'admin/AGENTS.md', case_insensitive: true });
    }
    // Same case: the old message stays.
    const same = await failure(alice.call('write', { space: 'shared', path: 'admin/AGENTS.md', content: '# B', message: 'm' }));
    expect(same.message).toBe('write failed: conflict: Conflict with the current state.');
    expect(same.details).not.toHaveProperty('existing_path');
  });

  it('move onto a path taken by another document in a different case says so; a case-only rename works', async () => {
    const alice = w.client('alice');
    await alice.call('write', { space: 'shared', path: 'Notes/Plan.md', content: 'a', expected_rev: 0, message: 'm' });
    const other = await alice.call<{ doc: { id: string } }>('write', { space: 'shared', path: 'other.md', content: 'b', expected_rev: 0, message: 'm' });
    const e = await failure(alice.call('move', { id: other.doc.id, to_path: 'notes/plan.md', message: 'm' }));
    expect(e.code).toBe('conflict');
    expect(e.details).toMatchObject({ reason: 'path_taken', existing_path: 'Notes/Plan.md' });
    expect(e.message).toBe("move failed: conflict: Path conflicts with existing 'Notes/Plan.md' (paths are case-insensitive).");
    const renamed = await alice.call<{ doc: { path: string } }>('move', { id: other.doc.id, to_path: 'OTHER.md', message: 'm' });
    expect(renamed.doc.path).toBe('OTHER.md');
  });

  it('documented in /agents.md, docs and the write/move descriptions', () => {
    expect(buildAgentsMd('https://b.example')).toContain('Paths are case-insensitive');
    expect(getOp('write')!.description).toContain('Paths are case-insensitive');
    expect(getOp('move')!.description).toContain('Paths are case-insensitive');
    expect(fs.readFileSync(new URL('../../docs/connect/README.md', import.meta.url), 'utf8')).toContain('Paths are case-insensitive');
  });
});

describe('admin_space_create grants the creator admin', () => {
  it('an admin agent can use its new space at once; the grant is listed and audited', async () => {
    const bot = adminAgent();
    const c = await mcp(bot.token);
    const created = (await c.callTool({ name: 'admin_space_create', arguments: { slug: 'bot-space', request_id: 'req-bot-space-1' } })) as CallToolResult;
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent).toMatchObject({
      space: { slug: 'bot-space' },
      grant: { space: 'bot-space', scope: 'space', subject: { type: 'principal', name: 'curator-bot' }, role: 'admin', granted_by: 'curator-bot' },
    });
    const write = (await c.callTool({ name: 'write', arguments: { space: 'bot-space', path: 'AGENTS.md', content: '# Rules', expected_rev: 0, message: 'rules' } })) as CallToolResult;
    expect(write.isError).toBeFalsy();
    const grants = await w.client('alice').call<{ grants: { space: string; role: string; subject: { name: string } }[] }>('admin_grant_list', { space: 'bot-space' });
    expect(grants.grants.map((g) => [g.subject.name, g.role])).toEqual([['curator-bot', 'admin']]);
    const detail = auditDetail('admin_space_create', 'ok') as { result: { grant: { role: string; subject: { name: string } } } };
    expect(detail.result.grant).toMatchObject({ role: 'admin', subject: { name: 'curator-bot' } });
    // A retry with the same request_id does not grant twice.
    const again = (await c.callTool({ name: 'admin_space_create', arguments: { slug: 'bot-space', request_id: 'req-bot-space-1' } })) as CallToolResult;
    expect(again.isError).toBeFalsy();
    const after = await w.client('alice').call<{ grants: unknown[] }>('admin_grant_list', { space: 'bot-space' });
    expect(after.grants).toHaveLength(1);
  });

  it('a failed create (slug taken) leaves no grant', async () => {
    const before = (h.core.db.prepare('SELECT count(*) AS n FROM grants').get() as { n: number }).n;
    const e = await failure(w.client('alice').call('admin_space_create', { slug: 'shared' }));
    expect(e.code).toBe('conflict');
    expect((h.core.db.prepare('SELECT count(*) AS n FROM grants').get() as { n: number }).n).toBe(before);
  });
});
