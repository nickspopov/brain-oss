// Parked waits for mail: one
// in-memory map shared by GET /api/v1/inbox?wait and handoff_wait. No DB polling: the message commit
// hook and handoff_ack wake the principals involved, and each waiter re-checks its own condition.
// One waiter per principal (a new one supersedes the old), a global cap (over it: rate_limited), and
// every waiter is released on client close, token revoke / principal disable and shutdown.
// A cursor wait (`since`) is one of several independent listeners of the same
// principal, so cursor waits do not supersede the level wait or each other — up to CURSOR_SLOTS per
// principal; one more supersedes the oldest of them.
import { OpError } from './errors.js';

export type WakeReason = 'event' | 'timeout' | 'superseded' | 'aborted' | 'revoked' | 'shutdown';

/** `level`: the classic single wait of a principal; `cursor`: one of up to CURSOR_SLOTS listener waits. */
export type WaitSlot = 'level' | 'cursor';
export const CURSOR_SLOTS = 4;

interface Entry {
  principalId: string;
  tokenId: string | undefined;
  slot: WaitSlot;
  resolve: (r: WakeReason) => void;
}

/** Text of the 429 when the process already parks the maximum number of waits. */
export const SERVER_BUSY = 'Server busy; stop watching, check later.';
const BUSY_RETRY_MS = 60_000;

export class WaiterMap {
  private readonly byPrincipal = new Map<string, Entry[]>();
  private count = 0;
  private closed = false;

  constructor(private readonly cap: number) {}

  /** Parked waits now. */
  get size(): number {
    return this.count;
  }

  private entries(): Entry[] {
    return [...this.byPrincipal.values()].flat();
  }

  /**
   * Parks until an event for this principal, `ms` elapsed, the signal aborts, the token or principal
   * is revoked, a newer wait of the same principal starts, or shutdown. Never rejects after parking;
   * over the cap it throws `rate_limited` before parking.
   */
  park(principalId: string, tokenId: string | undefined, ms: number, signal?: AbortSignal, slot: WaitSlot = 'level'): Promise<WakeReason> {
    if (this.closed) return Promise.resolve('shutdown');
    if (signal?.aborted) return Promise.resolve('aborted');
    const mine = (this.byPrincipal.get(principalId) ?? []).filter((e) => e.slot === slot);
    const previous = slot === 'level' ? mine[0] : mine.length >= CURSOR_SLOTS ? mine[0] : undefined;
    if (!previous && this.count >= this.cap) {
      throw new OpError('rate_limited', { retry_after_ms: BUSY_RETRY_MS, reason: 'server_busy' }, SERVER_BUSY);
    }
    previous?.resolve('superseded');
    return new Promise<WakeReason>((resolve) => {
      let done = false;
      const finish = (r: WakeReason): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const list = this.byPrincipal.get(principalId);
        const at = list ? list.indexOf(entry) : -1;
        if (list && at >= 0) {
          list.splice(at, 1);
          this.count--;
          if (list.length === 0) this.byPrincipal.delete(principalId);
        }
        resolve(r);
      };
      const onAbort = (): void => finish('aborted');
      const entry: Entry = { principalId, tokenId, slot, resolve: finish };
      const timer = setTimeout(() => finish('timeout'), Math.max(0, ms));
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      const list = this.byPrincipal.get(principalId);
      if (list) list.push(entry);
      else this.byPrincipal.set(principalId, [entry]);
      this.count++;
    });
  }

  /** Something changed for these principals (a message to or from them): their waiters re-check. */
  wake(principalIds: Iterable<string>): void {
    for (const id of principalIds) for (const e of [...(this.byPrincipal.get(id) ?? [])]) e.resolve('event');
  }

  /** A token was revoked: its wait ends at once. */
  revokeToken(tokenId: string): void {
    for (const e of this.entries()) if (e.tokenId === tokenId) e.resolve('revoked');
  }

  /** A principal was disabled (or lost its tokens): its wait ends at once. */
  revokePrincipal(principalId: string): void {
    for (const e of [...(this.byPrincipal.get(principalId) ?? [])]) e.resolve('revoked');
  }

  /** Shutdown: every wait returns now and no new one parks. */
  closeAll(): void {
    this.closed = true;
    for (const e of this.entries()) e.resolve('shutdown');
  }
}
