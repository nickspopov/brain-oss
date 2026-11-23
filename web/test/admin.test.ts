// Administration helpers: form fields, settings diffs, the grants matrix, token status,
// connection instructions.
import { describe, expect, it } from 'vitest';
import type { AdminGrant, AdminSpace, AdminToken } from '../src/api/types';
import { folderPrefix, grantMatrix, mbText, parseIntField, parseMb, parsePaths, settingsFromForm, spaceForm, tokenStatus, withToken } from '../src/lib/admin';
import { conflictText } from '../src/lib/edit';
import { routes } from '../src/lib/routes';

const SPACE: AdminSpace = {
  id: '01S',
  slug: 'handoff',
  name: 'Handoff',
  description: '',
  review_mode: 'off',
  executable: false,
  inbox: true,
  ttl_days: 14,
  trash_retention_days: 30,
  quota_bytes: 500 * 1024 * 1024,
  max_doc_bytes: null,
  protected_paths: [],
  bytes_used: 0,
  archived: false,
  archived_at: null,
  created_at: '2026-11-14T00:00:00.000Z',
};

const grant = (over: Partial<AdminGrant>): AdminGrant => ({
  id: Math.random().toString(36),
  space: 'shared',
  scope: 'space',
  path_prefix: null,
  doc_id: null,
  subject: { type: 'group', name: 'all-agents' },
  role: 'read',
  granted_by: 'alice',
  granted_at: '2026-11-14T00:00:00.000Z',
  ...over,
});

describe('form fields', () => {
  it('parses integers, megabytes and protected paths', () => {
    expect(parseIntField('')).toBeNull();
    expect(parseIntField(' 14 ')).toBe(14);
    expect(parseIntField('0')).toBeUndefined();
    expect(parseIntField('1.5')).toBeUndefined();
    expect(parseIntField('-3')).toBeUndefined();
    expect(parseMb('')).toBeNull();
    expect(parseMb('500')).toBe(500 * 1024 * 1024);
    expect(parseMb('0,5')).toBe(512 * 1024);
    expect(parseMb('abc')).toBeUndefined();
    expect(parseMb('0')).toBeUndefined();
    expect(mbText(500 * 1024 * 1024)).toBe('500');
    expect(mbText(null)).toBe('');
    expect(parsePaths('AGENTS.md\n recipes/ , AGENTS.md\n\n')).toEqual(['AGENTS.md', 'recipes/']);
  });

  it('folder prefix is normalized with a trailing slash and rejects escapes', () => {
    expect(folderPrefix('drafts')).toBe('drafts/');
    expect(folderPrefix('/a/b/')).toBe('a/b/');
    expect(folderPrefix('')).toBeNull();
    expect(folderPrefix('a/../b')).toBeNull();
    expect(folderPrefix('a//b')).toBeNull();
    expect(folderPrefix('a\\b')).toBeNull();
  });
});

describe('space settings from the form', () => {
  it('create: empty fields are not sent, so server defaults apply (review off, no protected paths, 500 MB)', () => {
    const f = { ...spaceForm(), name: 'Project' };
    const r = settingsFromForm(f);
    expect(r).toEqual({ ok: true, settings: { name: 'Project', description: '', review_mode: 'off', executable: false, protected_paths: [] } });
  });

  it('update: only changed fields; null clears TTL', () => {
    const f = { ...spaceForm(SPACE), ttl_days: '', executable: true, protected_paths: 'AGENTS.md' };
    const r = settingsFromForm(f, SPACE);
    expect(r).toEqual({ ok: true, settings: { ttl_days: null, executable: true, protected_paths: ['AGENTS.md'] } });
    // Inbox setting: sent only when changed; on create only when checked.
    expect(settingsFromForm({ ...spaceForm(SPACE), inbox: false }, SPACE)).toEqual({ ok: true, settings: { inbox: false } });
    expect(settingsFromForm({ ...spaceForm(), name: 'X', inbox: true })).toMatchObject({ ok: true, settings: { inbox: true } });
    expect(settingsFromForm({ ...spaceForm(), name: 'X' })).not.toMatchObject({ settings: { inbox: expect.anything() } });
    expect(settingsFromForm(spaceForm(SPACE), SPACE)).toEqual({ ok: true, settings: {} });
  });

  it('update: quota in MB becomes bytes; bad input names the field', () => {
    expect(settingsFromForm({ ...spaceForm(SPACE), quota_mb: '100' }, SPACE)).toEqual({ ok: true, settings: { quota_bytes: 100 * 1024 * 1024 } });
    expect(settingsFromForm({ ...spaceForm(SPACE), quota_mb: '' }, SPACE)).toMatchObject({ ok: false, field: 'quota_mb' });
    expect(settingsFromForm({ ...spaceForm(SPACE), ttl_days: 'x' }, SPACE)).toMatchObject({ ok: false, field: 'ttl_days' });
    expect(settingsFromForm({ ...spaceForm(SPACE), name: ' ' }, SPACE)).toMatchObject({ ok: false, field: 'name' });
  });
});

describe('grant matrix', () => {
  it('space-level grants are cells; folder and document grants are overrides', () => {
    const gs = [
      grant({ space: 'shared', subject: { type: 'group', name: 'all-agents' }, role: 'read' }),
      grant({ space: 'shared', subject: { type: 'principal', name: 'alice-helper' }, role: 'write' }),
      grant({ space: 'shared', scope: 'path', path_prefix: 'private/', subject: { type: 'principal', name: 'alice-helper' }, role: 'none' }),
      grant({ space: 'handoff', scope: 'doc', doc_id: '01D', role: 'admin' }),
    ];
    const m = grantMatrix(gs);
    expect(m.cell('shared', { type: 'group', name: 'all-agents' })?.role).toBe('read');
    expect(m.cell('shared', { type: 'principal', name: 'alice-helper' })?.role).toBe('write');
    // A group and a principal with the same name are not mixed up.
    expect(m.cell('shared', { type: 'principal', name: 'all-agents' })).toBeUndefined();
    expect(m.cell('handoff', { type: 'group', name: 'all-agents' })).toBeUndefined();
    expect(m.overrides.map((g) => [g.space, g.scope])).toEqual([
      ['handoff', 'doc'],
      ['shared', 'path'],
    ]);
  });
});

describe('tokens and connect instruction', () => {
  const tok = (over: Partial<AdminToken>): AdminToken => ({
    id: '01T',
    principal: 'alice-helper',
    prefix: 'brn_abcdefgh',
    label: '',
    created_at: '2026-11-01T00:00:00.000Z',
    expires_at: null,
    revoked: false,
    revoked_at: null,
    last_used_at: null,
    last_used_ip: null,
    ...over,
  });
  it('status: revoked, expired, active', () => {
    const now = Date.parse('2026-11-14T00:00:00Z');
    expect(tokenStatus(tok({}), now)).toBe('active');
    expect(tokenStatus(tok({ expires_at: '2026-11-13T00:00:00.000Z' }), now)).toBe('expired');
    expect(tokenStatus(tok({ revoked: true, revoked_at: '2026-11-02T00:00:00.000Z' }), now)).toBe('revoked');
  });

  it('the one-time token is prepended to the server instruction, which never carries it', () => {
    const t = 'brn_' + 'x'.repeat(43);
    const g = withToken('# Connect cc to Brain\nMCP endpoint: https://brain.example/mcp/v1', t);
    expect(g.split('\n')[0]).toBe(`Token (shown once, keep it secret): export BRAIN_TOKEN=${t}`);
    expect(g).toContain('https://brain.example/mcp/v1');
  });

  it('admin conflicts read as sentences; routes encode names', () => {
    expect(conflictText('slug_taken')).toBe('This slug is already taken.');
    expect(conflictText('token_already_issued')).toMatch(/Issue a new one/);
    expect(routes.admin.principal('a b')).toBe('/admin/agents/a%20b');
    expect(routes.admin.principal('alice-helper', 'access')).toBe('/admin/agents/alice-helper/access');
    expect(routes.spaceMembers('proj x')).toBe('/s/proj%20x/members');
    expect(routes.newAt('shared', 'AGENTS.md')).toBe('/s/shared/new?path=AGENTS.md');
  });
});
