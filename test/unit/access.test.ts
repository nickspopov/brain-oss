// Case table for the role resolution algorithm and space visibility, without HTTP.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRole, type GrantLike } from '../../src/core/access/resolve.js';
import { contextFor, filterDocs, requireSpace, roleAt, visibleSpaces } from '../../src/core/guard.js';
import { toAuthenticated } from '../../src/core/tokens.js';
import type { Role } from '../../src/store/types.js';
import { buildWorld, type PrincipalName, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

const P = 'p1';
const G1 = 'g1';
const G2 = 'g2';
const subjects = { principalId: P, groupIds: [G1, G2] };
const flags = { superadmin: false, disabled: false, archived: false };

const sp = (subject: string, role: Role, type: 'principal' | 'group' = subject === P ? 'principal' : 'group'): GrantLike => ({
  scope: 'space', path_prefix: null, doc_id: null, subject_type: type, subject_id: subject, role,
});
const path = (prefix: string, subject: string, role: Role): GrantLike => ({
  scope: 'path', path_prefix: prefix, doc_id: null, subject_type: subject === P ? 'principal' : 'group', subject_id: subject, role,
});
const doc = (id: string, subject: string, role: Role): GrantLike => ({
  scope: 'doc', path_prefix: null, doc_id: id, subject_type: subject === P ? 'principal' : 'group', subject_id: subject, role,
});

interface Case {
  name: string;
  grants: GrantLike[];
  target: { pathKey?: string; docId?: string };
  flags?: Partial<typeof flags>;
  role: Role;
  level?: string;
}

const CASES: Case[] = [
  { name: 'no grants → none', grants: [], target: { pathKey: 'a.md' }, role: 'none', level: 'none' },
  { name: 'space grant applies to any path', grants: [sp(P, 'read')], target: { pathKey: 'x/y/z.md' }, role: 'read', level: 'space' },
  { name: 'grants of other subjects are ignored', grants: [sp('other', 'admin', 'principal'), sp('g-other', 'admin', 'group')], target: {}, role: 'none' },
  { name: 'group grant applies to members', grants: [sp(G1, 'write')], target: {}, role: 'write' },
  { name: 'max over groups on the same level', grants: [sp(G1, 'read'), sp(G2, 'write')], target: {}, role: 'write' },
  { name: 'personal beats group on the same level (narrows)', grants: [sp(G1, 'admin'), sp(P, 'read')], target: {}, role: 'read' },
  { name: 'personal beats group on the same level (widens)', grants: [sp(G1, 'read'), sp(P, 'write')], target: {}, role: 'write' },
  { name: 'narrow none on a folder hides it under read on the space', grants: [sp(P, 'read'), path('private/', P, 'none')], target: { pathKey: 'private/a.md' }, role: 'none', level: 'path' },
  { name: 'narrow none does not touch siblings', grants: [sp(P, 'read'), path('private/', P, 'none')], target: { pathKey: 'public/a.md' }, role: 'read', level: 'space' },
  { name: 'narrow write on a folder widens read on the space', grants: [sp(P, 'read'), path('drafts/', P, 'write')], target: { pathKey: 'drafts/x.md' }, role: 'write' },
  { name: 'longest prefix wins', grants: [path('a/', P, 'none'), path('a/b/', P, 'read')], target: { pathKey: 'a/b/c.md' }, role: 'read' },
  { name: 'shorter prefix applies outside the longer one', grants: [path('a/', P, 'none'), path('a/b/', P, 'read')], target: { pathKey: 'a/c.md' }, role: 'none', level: 'path' },
  { name: 'prefix must match whole segments', grants: [sp(P, 'read'), path('ab/', P, 'none')], target: { pathKey: 'abc.md' }, role: 'read' },
  { name: 'group on a narrower level beats personal on a wider level', grants: [sp(P, 'admin'), path('x/', G1, 'read')], target: { pathKey: 'x/1.md' }, role: 'read' },
  { name: 'doc grant beats path and space', grants: [sp(P, 'none'), path('x/', P, 'none'), doc('d1', G1, 'read')], target: { pathKey: 'x/1.md', docId: 'd1' }, role: 'read', level: 'doc' },
  { name: 'doc grant on another doc does not apply', grants: [sp(P, 'read'), doc('d2', P, 'none')], target: { pathKey: '1.md', docId: 'd1' }, role: 'read' },
  { name: 'personal none on a doc beats group read on the doc', grants: [doc('d1', G1, 'read'), doc('d1', P, 'none')], target: { docId: 'd1' }, role: 'none', level: 'doc' },
  { name: 'propose is a role between read and write', grants: [sp(G1, 'propose'), sp(G2, 'read')], target: {}, role: 'propose' },
  { name: 'superadmin is admin everywhere', grants: [sp(P, 'none')], target: {}, flags: { superadmin: true }, role: 'admin', level: 'superadmin' },
  { name: 'disabled → none', grants: [sp(P, 'admin')], target: {}, flags: { disabled: true }, role: 'none', level: 'disabled' },
  { name: 'archived space → none for non-superadmin', grants: [sp(P, 'admin')], target: {}, flags: { archived: true }, role: 'none', level: 'archived' },
  { name: 'archived space → admin for superadmin', grants: [], target: {}, flags: { archived: true, superadmin: true }, role: 'admin' },
];

describe('role resolution table', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const r = resolveRole(c.grants, subjects, c.target, { ...flags, ...c.flags });
    expect(r.role).toBe(c.role);
    if (c.level) expect(r.level).toBe(c.level);
  });
});

describe('guard on the test world', () => {
  let h: Harness;
  let w: World;
  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h);
  });
  afterEach(async () => {
    await h.close();
  });
  const ctx = (name: PrincipalName) => contextFor(h.core, toAuthenticated(w.principals[name]));
  const slugs = (name: PrincipalName) => visibleSpaces(ctx(name)).map((v) => v.space.slug).sort();

  it('visible spaces follow grants, groups and all-agents', () => {
    expect(slugs('alphabot')).toEqual(['handoff', 'proj-alpha', 'recipes', 'shared']);
    expect(slugs('betabot')).toEqual(['handoff', 'proj-beta', 'recipes', 'shared']);
    expect(slugs('alice-assistant')).toEqual(['handoff', 'recipes', 'shared']);
    expect(slugs('alice')).toEqual(['handoff', 'proj-alpha', 'proj-beta', 'recipes', 'shared']);
    expect(visibleSpaces(ctx('alice-assistant')).find((v) => v.space.slug === 'recipes')?.role).toBe('admin');
  });

  it('a narrow read grant makes the space visible with role none; a narrow none does not', () => {
    w.grant('proj-beta', { principal: 'alphabot' }, 'none', { path: 'x/' });
    expect(slugs('alphabot')).not.toContain('proj-beta');
    w.grant('proj-beta', { principal: 'alphabot' }, 'read', { path: 'open/' });
    const v = visibleSpaces(ctx('alphabot')).find((s) => s.space.slug === 'proj-beta');
    expect(v?.role).toBe('none');
    // A group read on a folder, overridden by a personal none at the same level, grants no visibility.
    w.grant('proj-beta', { principal: 'alphabot' }, 'none', { path: 'open/' });
    w.grant('proj-beta', { group: 'all-agents' }, 'read', { path: 'open/' });
    expect(slugs('alphabot')).not.toContain('proj-beta');
  });

  it('requireSpace: invisible → not_found, visible but too weak → forbidden', () => {
    const c = ctx('alphabot');
    expect(() => requireSpace(c, 'proj-beta', 'read')).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => requireSpace(c, 'no-such', 'read')).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => requireSpace(c, 'shared', 'write')).toThrow(expect.objectContaining({ code: 'forbidden', details: { required_role: 'write' } }));
    expect(requireSpace(c, 'proj-alpha', 'write').role).toBe('write');
  });

  it('changes of grants and groups apply on the next context (aclVersion)', () => {
    const before = ctx('alphabot');
    w.grant('proj-beta', { principal: 'alphabot' }, 'read');
    expect(visibleSpaces(before).map((v) => v.space.slug)).not.toContain('proj-beta');
    expect(slugs('alphabot')).toContain('proj-beta');
    w.grant('proj-beta', { principal: 'alphabot' }, 'none');
    expect(slugs('alphabot')).not.toContain('proj-beta');
  });

  it('filterDocs keeps only rows with read, before any limit', () => {
    w.grant('shared', { principal: 'alphabot' }, 'none', { path: 'private/' });
    const s = w.spaces.shared.id;
    const rows = [
      { space_id: s, path_key: 'private/a.md', doc_id: 'd1' },
      { space_id: s, path_key: 'public/b.md', doc_id: 'd2' },
      { space_id: w.spaces['proj-beta'].id, path_key: 'c.md', doc_id: 'd3' },
      { space_id: 'nope', path_key: 'd.md', doc_id: 'd4' },
    ];
    expect(filterDocs(ctx('alphabot'), rows).map((r) => r.doc_id)).toEqual(['d2']);
    expect(roleAt(ctx('alphabot'), w.spaces.shared, 'PRIVATE/a.md'.toLowerCase())).toBe('none');
  });
});
