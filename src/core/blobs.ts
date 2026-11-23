// Content-addressed bodies: texts in a `blobs` row, files in data/blobs/<2>/<hash>.
// Identical bodies are not duplicated; text is not compressed (the format is open).
import fs from 'node:fs';
import path from 'node:path';
import { getBlob, insertBlobIfMissing } from '../store/blobs.js';
import type { Core } from './context.js';
import { sha256 } from './content.js';

function blobPath(core: Core, hash: string): string {
  return path.join(core.config.dataDir, 'blobs', hash.slice(0, 2), hash);
}

export const blobFilePath = blobPath;

/**
 * Backup lock file: while it exists, the janitor does not delete body files. It is set by
 * `brain backup` for the duration of the snapshot.
 */
export function backupLockPath(core: Core): string {
  return path.join(core.config.dataDir, 'backup.lock');
}

export function blobGcPaused(core: Core): boolean {
  return fs.existsSync(backupLockPath(core));
}

/** Files older than this without a row in blobs are orphans (a rolled-back file write). */
const ORPHAN_AGE_MS = 60 * 60 * 1000;

/**
 * Orphan collector: files in data/blobs without a `blobs` row (and abandoned `.tmp` files) older than
 * an hour. Age is measured by real file-system time. Paused during a backup.
 */
export function sweepOrphanBlobs(core: Core, exists: (hash: string) => boolean): number {
  if (blobGcPaused(core)) return 0;
  const root = path.join(core.config.dataDir, 'blobs');
  if (!fs.existsSync(root)) return 0;
  const cutoff = Date.now() - ORPHAN_AGE_MS;
  let n = 0;
  for (const dir of fs.readdirSync(root)) {
    const sub = path.join(root, dir);
    if (!/^[0-9a-f]{2}$/.test(dir) || !fs.statSync(sub).isDirectory()) continue;
    for (const name of fs.readdirSync(sub)) {
      const file = path.join(sub, name);
      const st = fs.statSync(file);
      if (!st.isFile() || st.mtimeMs > cutoff) continue;
      const isTmp = name.endsWith('.tmp');
      if (!isTmp && (!/^[0-9a-f]{64}$/.test(name) || exists(name))) continue;
      fs.rmSync(file, { force: true });
      n++;
    }
  }
  return n;
}

/** Stores text (inside a write transaction) and returns its hash and size. */
export function putTextBlob(core: Core, text: string): { hash: string; size: number } {
  const hash = sha256(text);
  const size = Buffer.byteLength(text, 'utf8');
  insertBlobIfMissing(core.db, { hash, storage: 'inline', text, size, created_at: core.now() });
  return { hash, size };
}

/**
 * Stores file bytes: first the file on disk (temporary → rename, idempotent by hash), then the
 * `blobs` row. If the transaction rolls back, a file without a row is left on disk; the orphan
 * collector (sweepOrphanBlobs, janitor) picks it up; nothing references it.
 */
export function putFileBlob(core: Core, bytes: Uint8Array): { hash: string; size: number } {
  const hash = sha256(bytes);
  // The same bytes are already stored (as text or as a file): the body is read in the needed form (readBlob).
  if (getBlob(core.db, hash)) return { hash, size: bytes.length };
  const file = blobPath(core, hash);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  insertBlobIfMissing(core.db, { hash, storage: 'file', text: null, size: bytes.length, created_at: core.now() });
  return { hash, size: bytes.length };
}

export type Body = { kind: 'text'; text: string } | { kind: 'bytes'; bytes: Buffer };

/**
 * Body by hash in the document's form: `text` is a string, `file` is bytes; `undefined` if there is no
 * body (purged or lost). There is one `blobs` row per hash, and the same bytes may arrive both as text
 * and as a file: the storage kind does not determine the body kind, the document does. The hash is
 * sha256 of the text's UTF-8 bytes, so converting between kinds is exact.
 */
export function readBlob(core: Core, hash: string, as: 'text' | 'file'): Body | undefined {
  const row = getBlob(core.db, hash);
  if (!row) return undefined;
  if (row.storage === 'inline') {
    const text = row.text ?? '';
    return as === 'text' ? { kind: 'text', text } : { kind: 'bytes', bytes: Buffer.from(text, 'utf8') };
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(blobPath(core, hash));
  } catch {
    return undefined;
  }
  return as === 'file' ? { kind: 'bytes', bytes } : { kind: 'text', text: bytes.toString('utf8') };
}

/** Body text of a text document, or `undefined` (no body). */
export function readTextBlob(core: Core, hash: string): string | undefined {
  const b = readBlob(core, hash, 'text');
  return b?.kind === 'text' ? b.text : undefined;
}
