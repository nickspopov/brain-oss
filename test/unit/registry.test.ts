// Operation registry: every operation has an isolation factory or an explicit
// `not_applicable` with a reason; admin_* require the admin capability in every adapter.
import { describe, expect, it } from 'vitest';
import { listOps } from '../../src/ops/registry.js';
import { ERROR_CODES, ERROR_HTTP } from '../../src/ops/errors.js';

const HIDDEN = { space: 'proj-beta', paths: ['a.md'], docIds: ['01JZZZZZZZZZZZZZZZZZZZZZZZ'], proposalIds: ['01JZZZZZZZZZZZZZZZZZZZZZZY'], queries: ['zq'] };

describe('operation registry', () => {
  const ops = listOps();

  it('is not empty and has unique snake_case names', () => {
    expect(ops.length).toBeGreaterThan(0);
    const names = ops.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it.each(ops.map((o) => [o.name, o] as const))('%s declares isolation inputs or not_applicable with a reason', (_n, op) => {
    expect(op.isolation).toBeDefined();
    if (op.isolation.kind === 'not_applicable') {
      expect(op.isolation.reason.length).toBeGreaterThan(10);
    } else {
      const built = op.isolation.build(HIDDEN);
      expect(built.addressed.length + built.broad.length).toBeGreaterThan(0);
      for (const b of built.broad) expect(op.input.safeParse(b).success).toBe(true);
      for (const a of built.addressed) {
        expect(op.input.safeParse(a.input).success).toBe(true);
        expect(op.input.safeParse(a.missing).success).toBe(true);
      }
    }
  });

  it.each(ops.map((o) => [o.name, o] as const))('%s has an agent-facing description and sane flags', (_n, op) => {
    expect(op.summary.length).toBeGreaterThan(10);
    expect(op.description.length).toBeGreaterThan(20);
    expect(op.expose.length).toBeGreaterThan(0);
    if (op.name.startsWith('admin_')) {
      expect([...op.expose].sort()).toEqual(['mcp', 'mcpl', 'rest']);
      expect(['admin', 'superadmin']).toContain(op.requires);
      expect(op.effect).toBe('admin');
    }
    if (op.effect === 'write') expect(op.idempotent).toBe(true);
  });

  it('admin_* are visible only with the admin capability, in every adapter', async () => {
    const { isVisibleTo } = await import('../../src/ops/registry.js');
    const base = { id: 'x', name: 'x', trust: 'admin' as const };
    const agent = { ...base, kind: 'agent' as const, role: 'member' as const };
    const adminAgent = { ...agent, admin: true };
    const alice = { ...base, kind: 'human' as const, role: 'superadmin' as const };
    const op = ops.find((o) => o.name === 'admin_token_issue')!;
    for (const via of ['rest', 'mcp', 'mcpl', 'ui'] as const) {
      expect(isVisibleTo(op, { principal: agent, via, ip: null })).toBe(false);
      expect(isVisibleTo(op, { principal: adminAgent, via, ip: null })).toBe(true);
      expect(isVisibleTo(op, { principal: alice, via, ip: null })).toBe(true);
    }
  });

  it('error codes match the contract', () => {
    expect(ERROR_CODES).toEqual([
      'unauthenticated', 'forbidden', 'not_found', 'invalid_input', 'conflict', 'idempotency_mismatch',
      'edit_failed', 'secret_detected', 'too_large', 'quota_exceeded', 'rate_limited', 'purged',
      'unsupported', 'internal',
    ]);
    expect(ERROR_HTTP.edit_failed).toBe(422);
    expect(ERROR_HTTP.purged).toBe(410);
  });
});
