// The durable mail-event history (migration 0012), SQL only, no access checks.
import type { Db } from '../db/open.js';

export type MailEventKind = 'inbound' | 'updated' | 'answered';

export interface MailEventRow {
  seq: number;
  doc_id: string;
  rev: number;
  kind: MailEventKind;
}

/** One event for `principalId`, inside the transaction of the change it records. */
export function recordMailEvent(db: Db, e: { tenantId: string; principalId: string; docId: string; rev: number; kind: MailEventKind; now: number }): void {
  db.prepare('INSERT INTO mail_events (tenant_id, principal_id, doc_id, rev, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    e.tenantId,
    e.principalId,
    e.docId,
    e.rev,
    e.kind,
    e.now,
  );
}

/** Highest seq ever assigned (AUTOINCREMENT never reuses one), 0 before the first event. */
export function mailEventsHead(db: Db): number {
  const v = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'mail_events'").pluck().get() as number | undefined;
  return v ?? 0;
}

/** Events at or below this seq were pruned. */
export function mailEventsFloor(db: Db): number {
  return (db.prepare('SELECT seq FROM mail_events_floor WHERE id = 1').pluck().get() as number | undefined) ?? 0;
}

/** Events of a principal after `after`, of the given kinds, in seq order. */
export function mailEventsAfter(db: Db, tenantId: string, principalId: string, after: number, kinds: readonly MailEventKind[], limit: number): MailEventRow[] {
  return db
    .prepare(
      `SELECT seq, doc_id, rev, kind FROM mail_events
       WHERE tenant_id = ? AND principal_id = ? AND seq > ? AND kind IN (${kinds.map(() => '?').join(', ')})
       ORDER BY seq LIMIT ?`,
    )
    .all(tenantId, principalId, after, ...kinds, limit) as MailEventRow[];
}

/** Drops events older than `before` and raises the floor over them; returns the number dropped. */
export function pruneMailEvents(db: Db, before: number): number {
  return db.transaction(() => {
    const top = db.prepare('SELECT max(seq) FROM mail_events WHERE created_at < ?').pluck().get(before) as number | null;
    if (top === null) return 0;
    const n = db.prepare('DELETE FROM mail_events WHERE seq <= ?').run(top).changes;
    db.prepare('UPDATE mail_events_floor SET seq = max(seq, ?) WHERE id = 1').run(top);
    return n;
  })();
}

/** A message erased for good takes its events along (they would be filtered out anyway). */
export function deleteMailEventsForDoc(db: Db, docId: string): void {
  db.prepare('DELETE FROM mail_events WHERE doc_id = ?').run(docId);
}
