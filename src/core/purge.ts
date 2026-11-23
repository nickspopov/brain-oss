// Final erasure: a whole document (rows of the document, its revisions, Yjs, "seen" state,
// proposals, grants with scope = doc, FTS, saved idempotency responses; bodies no longer referenced
// by anything are removed from blobs and from disk) — the janitor for the trash and `admin_purge`;
// or the bodies of individual revisions (`admin_purge` with `revs`).
import fs from 'node:fs';
import { deleteBlob, deleteDocumentRows, deleteIdempotencyForDoc, unreferencedHashes } from '../store/janitor.js';
import { bodyStillReferenced, markRevisionPurged } from '../store/revisions.js';
import { optimizeFts } from '../store/search.js';
import { deleteOutboxForDoc } from '../store/webhooks.js';
import { putYState } from '../store/ystate.js';
import { blobFilePath, blobGcPaused, readTextBlob } from './blobs.js';
import type { Core } from './context.js';
import { conflict, invalidInput } from './errors.js';
import { dropSpaceExports } from './export/export.js';
import { requireDoc, revisionOf, type AccessContext } from './guard.js';
import { applyText } from './ydoc/body.js';

export interface PurgeResult {
  purged: boolean;
  blobs: number;
}

/** Erases a document in one transaction; body files are deleted after commit (unless GC is paused). */
export function purgeDocument(core: Core, docId: string): PurgeResult {
  const files: string[] = [];
  const result = core.db
    .transaction((): PurgeResult => {
      const gone = deleteDocumentRows(core.db, docId);
      if (!gone) return { purged: false, blobs: 0 };
      deleteOutboxForDoc(core.db, docId);
      let n = 0;
      for (const hash of unreferencedHashes(core.db, gone.hashes)) {
        const storage = deleteBlob(core.db, hash);
        if (storage === 'file') files.push(hash);
        if (storage) n++;
      }
      return { purged: true, blobs: n };
    })
    .immediate();
  // During a backup files are left alone: the orphan collector picks them up later.
  if (!blobGcPaused(core)) {
    for (const hash of files) fs.rmSync(blobFilePath(core, hash), { force: true });
  }
  if (result.purged) core.db.pragma('wal_checkpoint(TRUNCATE)');
  return result;
}

// --- admin_purge ------------------------------------------------------------------------------------

export interface AdminPurgeInput {
  id: string;
  /** Numbers of non-head revisions; without them, the whole document. */
  revs?: readonly number[] | undefined;
  reason: string;
}

export interface AdminPurgeOut {
  id: string;
  /** `document`: erased whole; `revisions`: revision bodies erased. */
  scope: 'document' | 'revisions';
  revs?: number[];
  /** Bodies deleted from blobs. */
  bodies_deleted: number;
  /** Bodies that remain: other revisions or proposals reference them. */
  bodies_kept: number;
  exports_dropped: number;
}

/** FTS merge and WAL checkpoint: erased data leaves the DB file before `brain vacuum`. */
function compact(core: Core): void {
  optimizeFts(core.db);
  core.db.pragma('wal_checkpoint(TRUNCATE)');
}

/**
 * `admin_purge`: the document must be visible to the caller (the invisible does not exist).
 * Without `revs`, the whole document (like the janitor for the trash). With `revs`, the bodies of the
 * given non-head revisions: the rows stay with `purged_at`, `read`/`diff`/`revert` on them answer `purged`.
 * A revision whose body equals the head is not erased (`conflict head_body`): write a new revision first.
 * The Yjs body is rebuilt from the head (no deleted text remains in it). Temporary space
 * exports and idempotency responses with the document id are deleted.
 */
export function adminPurge(ctx: AccessContext, input: AdminPurgeInput): AdminPurgeOut {
  const core = ctx.core;
  const access = requireDoc(ctx, { id: input.id }, 'read', { includeDeleted: true });
  const doc = access.doc;
  if (input.revs === undefined) {
    const r = purgeDocument(core, doc.id);
    const dropped = dropSpaceExports(core, access.space.id);
    compact(core);
    return { id: doc.id, scope: 'document', bodies_deleted: r.blobs, bodies_kept: 0, exports_dropped: dropped };
  }
  const revs = [...new Set(input.revs)].sort((a, b) => a - b);
  if (revs.length === 0) throw invalidInput('revs', 'Pass at least one revision, or omit revs to purge the whole document.');
  const files: string[] = [];
  const out = core.db
    .transaction((): AdminPurgeOut => {
      const hashes = new Set<string>();
      for (const rev of revs) {
        if (rev >= doc.head_rev) throw conflict('head_revision', { rev });
        const r = revisionOf(ctx, access, rev);
        if (r.content_hash === doc.content_hash) throw conflict('head_body', { rev });
        hashes.add(r.content_hash);
      }
      const now = core.now();
      for (const rev of revs) markRevisionPurged(core.db, doc.id, rev, now, ctx.principal.id);
      let deleted = 0;
      let kept = 0;
      for (const h of hashes) {
        if (bodyStillReferenced(core.db, h)) {
          kept++;
          continue;
        }
        const storage = deleteBlob(core.db, h);
        if (storage === 'file') files.push(h);
        if (storage) deleted++;
      }
      if (doc.kind === 'text') {
        const head = readTextBlob(core, doc.content_hash);
        if (head === undefined) throw new Error('document body is missing');
        putYState(core.db, { doc_id: doc.id, state: applyText(null, head), head_rev: doc.head_rev });
      }
      deleteIdempotencyForDoc(core.db, doc.id);
      const dropped = dropSpaceExports(core, access.space.id);
      return { id: doc.id, scope: 'revisions', revs, bodies_deleted: deleted, bodies_kept: kept, exports_dropped: dropped };
    })
    .immediate();
  if (!blobGcPaused(core)) {
    for (const hash of files) fs.rmSync(blobFilePath(core, hash), { force: true });
  }
  compact(core);
  return out;
}
