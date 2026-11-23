// Space export: a tar.gz in data/tmp/exports with a download link (1 hour). The set of documents and
// revisions comes from the guard (only what the caller can read); export changes no data. The order
// of entries and keys is deterministic.
import { findPrincipal } from '../principals.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { deleteExportRow, exportsOfSpace, getExport, insertExport, type ExportRow } from '../../store/exports.js';
import { readBlob } from '../blobs.js';
import type { Core } from '../context.js';
import { iso } from '../docview.js';
import { notFound, OpError } from '../errors.js';
import { exportSet, exportStillReadable, visibleProtectedPaths, type AccessContext, type ExportDoc } from '../guard.js';
import { newId } from '../ids.js';
import { getMessage } from '../inbox.js';
import type { Db } from '../../db/open.js';
import { CONTRACT_VERSION } from '../../version.js';
import { blobEntry, FORMAT, FORMAT_VERSION, MANIFEST_ENTRY, treeEntry, type Manifest, type ManifestDocument, type ManifestMessage } from './manifest.js';
import { entryChunks, tarEnd } from './tar.js';

const EXPORT_TTL_MS = 60 * 60 * 1000;
export const EXPORTS_DIR = path.join('tmp', 'exports');

export interface ExportInput {
  space: string;
  mode: 'head' | 'full';
  /** Export moment (ms). Only "now or after the latest revision": exporting a past state is not supported. */
  at?: number | undefined;
}

export interface ExportOut {
  export_id: string;
  download_path: string;
  size: number;
  sha256: string;
  expires_at: string;
}

interface PlannedEntry {
  name: string;
  mtime: number;
  hash: string;
}

function body(core: Core, hash: string): Buffer {
  const b = readBlob(core, hash, 'file');
  // The body may have been purged between the snapshot and writing the archive: the export must be retried.
  if (!b) throw new OpError('conflict', { reason: 'changed_during_export' });
  return b.kind === 'text' ? Buffer.from(b.text, 'utf8') : b.bytes;
}

type PrincipalRef = { name: string; kind: 'human' | 'agent' | 'system'; trust: 'admin' | 'trusted' | 'limited' };

function principalRef(db: Db, id: string): PrincipalRef {
  return db.prepare('SELECT name, kind, trust FROM principals WHERE id = ?').get(id) as PrincipalRef;
}

/** Envelope of a handoff message; in a head export the only revision is rev 1. */
function manifestMessage(db: Db, d: ExportDoc, mode: 'head' | 'full', refs: Map<string, PrincipalRef>): ManifestMessage | undefined {
  const m = getMessage(db, d.access.doc.id);
  if (!m) return undefined;
  const name = (id: string): string => {
    const p = principalRef(db, id);
    refs.set(p.name, p);
    return p.name;
  };
  const rev = (r: number | null): number | null => (r === null ? null : mode === 'full' ? r : r >= m.content_rev ? 1 : null);
  const isoOrNull = (t: number | null): string | null => (t === null ? null : iso(t));
  return {
    from: name(m.sender_id),
    to: name(m.recipient_id),
    thread_id: m.thread_id,
    reply_to: m.reply_to,
    created_at: iso(m.created_at),
    content_rev: mode === 'full' ? m.content_rev : 1,
    changed_at: iso(m.changed_at),
    received_rev: rev(m.received_rev),
    received_at: rev(m.received_rev) === null ? null : isoOrNull(m.received_at),
    resolution: rev(m.resolved_rev) === null ? null : m.resolution,
    resolved_rev: rev(m.resolved_rev),
    resolved_at: rev(m.resolved_rev) === null ? null : isoOrNull(m.resolved_at),
    resolved_by: m.resolved_by === null || rev(m.resolved_rev) === null ? null : name(m.resolved_by),
    note: rev(m.resolved_rev) === null ? null : m.note,
  };
}

function manifestDoc(d: ExportDoc, handoff?: ManifestMessage): ManifestDocument {
  const doc = d.access.doc;
  return {
    id: doc.id,
    path: doc.path,
    kind: doc.kind,
    mime: doc.mime,
    head_rev: doc.head_rev,
    deleted: doc.deleted_at !== null,
    revisions: d.revisions.map((r) => ({
      rev: r.rev,
      kind: r.kind,
      path: r.path,
      prev_path: r.prev_path,
      author: r.author_name,
      author_trust: r.author_trust,
      approved_by: r.approver_name,
      via: r.via,
      message: r.message,
      created_at: iso(r.created_at),
      content_hash: r.content_hash,
      size: r.size,
      ref_rev: r.ref_rev,
      purged: r.purged_at !== null,
      attention: r.attention === 1,
    })),
    ...(handoff ? { handoff } : {}),
  };
}

/** Snapshot: the manifest and the list of archive entries (bodies are read later, by hash). */
function plan(ctx: AccessContext, input: ExportInput): { manifest: Manifest; entries: PlannedEntry[]; spaceId: string; docIds: string[]; exportedAt: number } {
  const set = exportSet(ctx, input.space, input.mode);
  const latest = Math.max(0, ...set.docs.flatMap((d) => d.revisions.map((r) => r.created_at)));
  if (input.at !== undefined && input.at < latest) {
    throw new OpError('unsupported', { reason: 'export_at_past' });
  }
  // The moment of the state, not the call time: the same export of the same state gives the same bytes.
  const exportedAt = latest > 0 ? latest : set.space.created_at;
  const principals = new Map<string, { name: string; kind: 'human' | 'agent' | 'system'; trust: 'admin' | 'trusted' | 'limited'; external?: boolean }>();
  for (const d of set.docs) {
    for (const r of d.revisions) {
      if (!principals.has(r.author_name)) principals.set(r.author_name, { name: r.author_name, kind: r.author_kind, trust: r.author_trust });
      if (r.approver_name && !principals.has(r.approver_name)) {
        principals.set(r.approver_name, { name: r.approver_name, kind: r.approver_kind!, trust: r.approver_trust! });
      }
    }
  }
  const messageRefs = new Map<string, PrincipalRef>();
  const documents = set.docs.map((d) => manifestDoc(d, manifestMessage(ctx.core.db, d, input.mode, messageRefs)));
  for (const [name, p] of messageRefs) if (!principals.has(name)) principals.set(name, p);
  for (const p of principals.values()) if (findPrincipal(ctx.core, p.name)?.external === 1) p.external = true;
  const s = set.space;
  const manifest: Manifest = {
    format: FORMAT,
    format_version: FORMAT_VERSION,
    contract_version: CONTRACT_VERSION,
    exported_at: iso(exportedAt),
    mode: input.mode,
    space: {
      slug: s.slug,
      name: s.name,
      description: s.description,
      review_mode: s.review_mode,
      executable: s.executable === 1,
      inbox: s.inbox === 1,
      ttl_days: s.ttl_days,
      trash_retention_days: s.trash_retention_days,
      quota_bytes: s.quota_bytes,
      max_doc_bytes: s.max_doc_bytes,
      protected_paths: visibleProtectedPaths(ctx, s),
    },
    documents,
    principals: [...principals.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
  const sec = (ms: number): number => Math.floor(ms / 1000);
  const tree: PlannedEntry[] = set.docs
    .filter((d) => d.access.doc.deleted_at === null)
    .map((d) => ({ name: treeEntry(d.access.doc.path), mtime: sec(d.access.doc.updated_at), hash: d.access.doc.content_hash }));
  tree.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const blobs: PlannedEntry[] = [];
  if (input.mode === 'full') {
    const hashes = new Set<string>();
    for (const d of set.docs) for (const r of d.revisions) if (r.purged_at === null) hashes.add(r.content_hash);
    for (const h of [...hashes].sort()) blobs.push({ name: blobEntry(h), mtime: sec(exportedAt), hash: h });
  }
  return {
    manifest,
    entries: [...tree, ...blobs],
    spaceId: s.id,
    docIds: set.docs.map((d) => d.access.doc.id),
    exportedAt,
  };
}

/** `export`: an archive in data/tmp/exports and an `exports` row; download via `download_path`. */
export async function createExport(ctx: AccessContext, input: ExportInput): Promise<ExportOut> {
  const core = ctx.core;
  const p = plan(ctx, input);
  const id = newId(core.now());
  const rel = path.join(EXPORTS_DIR, `${id}.tar.gz`);
  const file = path.join(core.config.dataDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const manifestBytes = Buffer.from(`${JSON.stringify(p.manifest, null, 2)}\n`, 'utf8');
  function* chunks(): Generator<Buffer> {
    yield* entryChunks({ name: MANIFEST_ENTRY, data: manifestBytes, mtime: Math.floor(p.exportedAt / 1000) });
    for (const e of p.entries) yield* entryChunks({ name: e.name, data: body(core, e.hash), mtime: e.mtime });
    yield tarEnd();
  }
  const hash = createHash('sha256');
  let size = 0;
  try {
    const gzip = zlib.createGzip({ level: 6 });
    gzip.on('data', (c: Buffer) => {
      hash.update(c);
      size += c.length;
    });
    await pipeline(Readable.from(chunks()), gzip, fs.createWriteStream(file, { mode: 0o600 }));
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
  const now = core.now();
  const row: ExportRow = {
    id,
    principal_id: ctx.principal.id,
    space_id: p.spaceId,
    file: rel,
    size,
    created_at: now,
    expires_at: now + EXPORT_TTL_MS,
    mode: input.mode,
    doc_ids: JSON.stringify(p.docIds),
    sha256: hash.digest('hex'),
  };
  insertExport(core.db, row);
  return { export_id: id, download_path: `/api/v1/exports/${id}`, size, sha256: row.sha256, expires_at: iso(row.expires_at) };
}

export interface ExportFile {
  file: string;
  size: number;
  filename: string;
}

function removeExport(core: Core, row: { id: string; file: string }): void {
  const abs = path.resolve(core.config.dataDir, row.file);
  if (abs.startsWith(path.resolve(core.config.dataDir) + path.sep)) fs.rmSync(abs, { force: true });
  deleteExportRow(core.db, row.id);
}

/**
 * A finished archive for download: only for its creator, until `expires_at`, and only if access to
 * every object inside is still in place. Otherwise `not_found`; an archive that has become
 * inaccessible is deleted, and a new export is needed.
 */
export function openExport(ctx: AccessContext, id: string): ExportFile {
  const core = ctx.core;
  const row = getExport(core.db, id);
  if (!row || row.principal_id !== ctx.principal.id || row.expires_at <= core.now()) throw notFound();
  const docIds = JSON.parse(row.doc_ids) as string[];
  if (!exportStillReadable(ctx, row.space_id, row.mode, docIds)) {
    removeExport(core, row);
    throw notFound();
  }
  const abs = path.resolve(core.config.dataDir, row.file);
  if (!abs.startsWith(path.resolve(core.config.dataDir) + path.sep) || !fs.existsSync(abs)) throw notFound();
  const slug = ctx.snapshot.spaceById.get(row.space_id)?.slug ?? 'space';
  return { file: abs, size: row.size, filename: `brain-export-${slug}-${row.mode}.tar.gz` };
}

/** Purge: temporary archives of a space are deleted along with the purged space. */
export function dropSpaceExports(core: Core, spaceId: string): number {
  const rows = exportsOfSpace(core.db, spaceId);
  for (const r of rows) removeExport(core, r);
  return rows.length;
}
