// `brain doctor`: integrity check: structure, revisions without gaps, body hashes,
// Yjs text equals the head body, the search index covers exactly the live documents.
import { createHash } from 'node:crypto';
import type { Db } from '../db/open.js';
import {
  foreignKeyViolations,
  headHashMismatches,
  integrityCheck,
  iterateInlineBlobs,
  missingBlobs,
  revisionGaps,
  textDocsWithoutYState,
} from '../store/doctor.js';
import { getBlob } from '../store/blobs.js';
import { indexMismatches } from '../store/search.js';
import { iterateYStates } from '../store/ystate.js';
import { yText } from './ydoc/body.js';

export interface DoctorReport {
  ok: boolean;
  problems: string[];
}

export function runDoctor(db: Db, opts: { expectedSchemaVersion: number }): DoctorReport {
  const problems: string[] = [];
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version !== opts.expectedSchemaVersion) {
    problems.push(`schema version ${version}, expected ${opts.expectedSchemaVersion}`);
  }
  const integrity = integrityCheck(db);
  if (!(integrity.length === 1 && integrity[0] === 'ok')) problems.push(`integrity_check: ${integrity.join('; ')}`);
  for (const v of foreignKeyViolations(db)) problems.push(`foreign key violation in ${v.table} rowid ${v.rowid} -> ${v.parent}`);
  for (const g of revisionGaps(db)) problems.push(`document ${g.doc_id}: revisions are not 1..${g.head_rev} without gaps`);
  for (const m of headHashMismatches(db)) problems.push(`document ${m.doc_id}: head does not match head revision`);
  for (const b of missingBlobs(db)) problems.push(`document ${b.doc_id} rev ${b.rev}: body missing`);
  for (const blob of iterateInlineBlobs(db)) {
    const actual = createHash('sha256').update(blob.text, 'utf8').digest('hex');
    if (actual !== blob.hash) problems.push(`blob ${blob.hash}: content hash mismatch`);
    if (Buffer.byteLength(blob.text, 'utf8') !== blob.size) problems.push(`blob ${blob.hash}: size mismatch`);
  }
  for (const d of textDocsWithoutYState(db)) problems.push(`document ${d.doc_id}: missing Yjs body`);
  for (const y of iterateYStates(db)) {
    if (y.kind !== 'text') {
      problems.push(`document ${y.doc_id}: Yjs body for a file`);
      continue;
    }
    if (y.head_rev !== y.doc_head_rev) problems.push(`document ${y.doc_id}: Yjs body is at rev ${y.head_rev}, head is ${y.doc_head_rev}`);
    const head = getBlob(db, y.content_hash);
    let text: string | null = null;
    try {
      text = yText(new Uint8Array(y.state));
    } catch {
      problems.push(`document ${y.doc_id}: Yjs body cannot be decoded`);
    }
    if (text !== null && head?.storage === 'inline' && head.text !== text) {
      problems.push(`document ${y.doc_id}: Yjs text differs from the head revision`);
    }
  }
  // Search index: one row per live document, and only for live ones.
  const idx = indexMismatches(db);
  if (idx.missing > 0) problems.push(`search index: ${idx.missing} live document(s) not indexed (run brain reindex)`);
  if (idx.stale > 0) problems.push(`search index: ${idx.stale} row(s) without a live document (run brain reindex)`);
  return { ok: problems.length === 0, problems };
}
