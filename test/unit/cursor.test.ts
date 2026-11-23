// Cursor encryption: bound to the caller, kind and parameters; tampering → invalid_input.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Core } from '../../src/core/context.js';
import { openCursor, sealCursor } from '../../src/core/cursor.js';
import { OpError } from '../../src/core/errors.js';

const core = { secretKey: randomBytes(32) } as unknown as Core;
const other = { secretKey: randomBytes(32) } as unknown as Core;
const me = { core, principal: { id: 'p1' } };

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof OpError ? `${e.code}:${JSON.stringify(e.details)}` : 'other';
  }
  return undefined;
}

describe('cursor', () => {
  it('round-trips and is opaque', () => {
    const c = sealCursor(me, 'search', 40, { q: 'x' });
    expect(openCursor(me, 'search', c, { q: 'x' })).toBe(40);
    expect(Buffer.from(c, 'base64url').toString('utf8')).not.toContain('40');
    expect(c).not.toContain('p1');
  });

  it('is randomized and of fixed width: equal states and value sizes are not visible', () => {
    const a = sealCursor(me, 'changes', 7);
    const b = sealCursor(me, 'changes', 7);
    expect(a).not.toBe(b);
    expect(openCursor(me, 'changes', a)).toBe(7);
    expect(openCursor(me, 'changes', b)).toBe(7);
    const lengths = new Set([0, 7, 99, 12345, 10 ** 9, Number.MAX_SAFE_INTEGER].map((v) => sealCursor(me, 'changes', v).length));
    expect(lengths.size).toBe(1);
    expect(openCursor(me, 'changes', sealCursor(me, 'changes', Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('another caller, kind, params or key → invalid_input with the same text', () => {
    const c = sealCursor(me, 'list', 100, { s: 'a' });
    const bad = code(() => openCursor(me, 'list', 'garbage'));
    expect(bad).toMatch(/^invalid_input:/);
    expect(code(() => openCursor({ core, principal: { id: 'p2' } }, 'list', c, { s: 'a' }))).toBe(bad);
    expect(code(() => openCursor(me, 'hist', c, { s: 'a' }))).toBe(bad);
    expect(code(() => openCursor(me, 'list', c, { s: 'b' }))).toBe(bad);
    expect(code(() => openCursor({ core: other, principal: { id: 'p1' } }, 'list', c, { s: 'a' }))).toBe(bad);
    const raw = Buffer.from(c, 'base64url');
    raw[14] = raw[14]! ^ 1;
    expect(code(() => openCursor(me, 'list', raw.toString('base64url'), { s: 'a' }))).toBe(bad);
  });
});
