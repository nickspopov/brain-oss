// The level wait of a principal is still superseded by a newer one; cursor waits (several
// listeners of one principal) park side by side up to CURSOR_SLOTS, one more ends the oldest of them.
import { describe, expect, it } from 'vitest';
import { CURSOR_SLOTS, WaiterMap } from '../../src/core/waiters.js';

describe('WaiterMap slots', () => {
  it('level supersedes level; cursor waits neither supersede it nor each other below the limit', async () => {
    const m = new WaiterMap(100);
    const l1 = m.park('p', undefined, 10_000);
    const l2 = m.park('p', undefined, 10_000);
    expect(await l1).toBe('superseded');
    const cursors = Array.from({ length: CURSOR_SLOTS }, () => m.park('p', undefined, 10_000, undefined, 'cursor'));
    expect(m.size).toBe(1 + CURSOR_SLOTS);
    const extra = m.park('p', undefined, 10_000, undefined, 'cursor');
    expect(await cursors[0]).toBe('superseded');
    expect(m.size).toBe(1 + CURSOR_SLOTS);
    m.wake(['p']);
    expect(await l2).toBe('event');
    expect(await Promise.all([...cursors.slice(1), extra])).toEqual(Array(CURSOR_SLOTS).fill('event'));
    expect(m.size).toBe(0);
  });

  it('the global cap counts every wait; revoke and shutdown release all of a principal', async () => {
    const m = new WaiterMap(2);
    const a = m.park('p', 't1', 10_000, undefined, 'cursor');
    const b = m.park('p', 't2', 10_000, undefined, 'cursor');
    expect(() => m.park('q', undefined, 10_000)).toThrow();
    m.revokeToken('t1');
    expect(await a).toBe('revoked');
    m.revokePrincipal('p');
    expect(await b).toBe('revoked');
    const c = m.park('q', undefined, 10_000);
    m.closeAll();
    expect(await c).toBe('shutdown');
  });
});
