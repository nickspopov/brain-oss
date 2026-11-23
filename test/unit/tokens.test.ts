import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPrincipal } from '../../src/core/principals.js';
import { authenticateToken, hashToken, issueToken, revokeToken } from '../../src/core/tokens.js';
import { hashPassword, verifyPassword } from '../../src/core/password.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

function agent(name = 'alice-helper') {
  return createPrincipal(h.core, { name, kind: 'agent', trust: 'trusted' }, null);
}

describe('tokens', () => {
  it('format is brn_ + 43 base64url chars; only the sha256 and a 12-char prefix are stored', () => {
    const p = agent();
    const t = issueToken(h.core, p.id, { label: 'test' });
    expect(t.token).toMatch(/^brn_[A-Za-z0-9_-]{43}$/);
    const row = h.core.db.prepare('SELECT * FROM tokens WHERE id = ?').get(t.id) as Record<string, unknown>;
    expect(row.hash).toBe(hashToken(t.token));
    expect(row.prefix).toBe(t.token.slice(0, 12));
    expect(JSON.stringify(row)).not.toContain(t.token);
  });

  it('default expiry is BRAIN_TOKEN_DAYS; no-expiry only when asked', () => {
    const p = agent();
    const now = h.clock.now();
    const t = issueToken(h.core, p.id);
    expect(t.expiresAt).toBeGreaterThanOrEqual(now + 90 * 86400_000);
    expect(t.expiresAt).toBeLessThan(now + 90 * 86400_000 + 60_000);
    expect(issueToken(h.core, p.id, { days: null }).expiresAt).toBeNull();
  });

  it('authenticates a valid token and rejects revoked, expired, disabled, malformed, unknown', () => {
    const p = agent();
    const t = issueToken(h.core, p.id, { days: 1 });
    expect(authenticateToken(h.core, t.token, null)?.principal.name).toBe('alice-helper');
    expect(authenticateToken(h.core, 'brn_' + 'A'.repeat(43), null)).toBeNull();
    expect(authenticateToken(h.core, 'not-a-token', null)).toBeNull();
    expect(authenticateToken(h.core, t.token + 'x', null)).toBeNull();

    const r = issueToken(h.core, p.id);
    revokeToken(h.core, r.id, null);
    expect(authenticateToken(h.core, r.token, null)).toBeNull();

    h.clock.advanceDays(2);
    expect(authenticateToken(h.core, t.token, null)).toBeNull();

    const fresh = issueToken(h.core, p.id);
    h.core.db.prepare('UPDATE principals SET disabled_at = 1 WHERE id = ?').run(p.id);
    expect(authenticateToken(h.core, fresh.token, null)).toBeNull();
  });

  it('updates last_used at most once a minute', () => {
    const p = agent();
    const t = issueToken(h.core, p.id);
    const lastUsed = () => (h.core.db.prepare('SELECT last_used_at FROM tokens WHERE id = ?').get(t.id) as { last_used_at: number | null }).last_used_at;
    authenticateToken(h.core, t.token, '10.0.0.1');
    const first = lastUsed();
    expect(first).not.toBeNull();
    h.clock.advance(10_000);
    authenticateToken(h.core, t.token, '10.0.0.1');
    expect(lastUsed()).toBe(first);
    h.clock.advance(60_000);
    authenticateToken(h.core, t.token, '10.0.0.1');
    expect(lastUsed()).toBeGreaterThan(first!);
  });
});

describe('principals', () => {
  it('validates names and refuses an agent superadmin', () => {
    expect(() => createPrincipal(h.core, { name: 'Bad Name', kind: 'agent', trust: 'limited' }, null)).toThrow();
    expect(() => createPrincipal(h.core, { name: 'x', kind: 'agent', trust: 'limited' }, null)).toThrow();
    expect(() => createPrincipal(h.core, { name: 'evil', kind: 'agent', role: 'superadmin', trust: 'admin' }, null)).toThrow(
      expect.objectContaining({ code: 'invalid_input' }),
    );
    agent('dup-agent');
    expect(() => agent('dup-agent')).toThrow(expect.objectContaining({ code: 'conflict', details: { reason: 'name_taken' } }));
  });

  it('start_seq is the current global seq', () => {
    const p = agent();
    expect(p.start_seq).toBe(0);
  });
});

describe('password (scrypt)', () => {
  it('hashes in the scrypt$N$r$p$salt$hash format and verifies', () => {
    const stored = hashPassword('correct-horse-battery-staple');
    expect(stored.split('$')).toHaveLength(6);
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct-horse-battery-staple', stored)).toBe(true);
    expect(verifyPassword('wrong-horse-battery-staple', stored)).toBe(false);
    expect(verifyPassword('x', 'garbage')).toBe(false);
  });
});
