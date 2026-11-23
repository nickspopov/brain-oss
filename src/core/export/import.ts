// Import: a separate atomic `restore-batch` path rather than replaying history through commit.
// Archive-wide validation → body hash check → secret scanner → one transaction: space, authors,
// bodies, documents, revisions (rev, author, time, kind and via are kept; the global seq is assigned
// anew by time), Yjs and the index from the latest body.
// A plain-tree import (`--plain`) goes through an ordinary commit write on behalf of the caller.
import zlib from 'node:zlib';
import { aclSnapshot } from '../access/snapshot.js';
import { docNum, documentIdExists, insertDocument, updateDocument } from '../../store/documents.js';
import { insertRevision, markRevisionPurged, type RevisionKind } from '../../store/revisions.js';
import { addBytesUsed } from '../../store/spaces.js';
import { putYState } from '../../store/ystate.js';
import type { Kind, PrincipalRow, SpaceRow, Trust } from '../../store/types.js';
import { putFileBlob, putTextBlob } from '../blobs.js';
import { sha256, textMime } from '../content.js';
import type { Core } from '../context.js';
import { writeDocument, type WriteContext } from '../documents.js';
import { conflict, forbidden, invalidInput, OpError } from '../errors.js';
import { fileTitle, parseText } from '../frontmatter.js';
import { isSuperadmin, type AccessContext } from '../guard.js';
import { newId } from '../ids.js';
import { resolvedExpiry } from '../inbox.js';
import { normalizePath, pathKey } from '../paths.js';
import { createPrincipal, findPrincipal, setDisabled } from '../principals.js';
import { checkQuota } from '../quota.js';
import { indexDocument } from '../search/index.js';
import { fileAsText, scanWrite, secretDetected, type SecretFinding } from '../secrets/scan.js';
import { createSpace, findSpace } from '../spaces.js';
import { applyText } from '../ydoc/body.js';
import { blobEntry, MANIFEST_ENTRY, ManifestSchema, treeEntry, type Manifest, type ManifestDocument, type ManifestRevision } from './manifest.js';
import { TarError, tarUnpack } from './tar.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Archive limits: number of entries and total unpacked size. */
export const MAX_IMPORT_ENTRIES = 200_000;

export interface ImportInput {
  /** tar.gz in the export format. */
  archive: Buffer;
  /** slug of the new space. */
  space: string;
  mode: 'restore' | 'as-new';
  /** superadmin explicitly confirmed the secret scanner findings. */
  confirmSecrets?: boolean | undefined;
}

export interface ImportOut {
  space: string;
  mode: 'restore' | 'as-new';
  documents: number;
  revisions: number;
  principals_created: string[];
  secrets_confirmed?: number;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function bad(message: string): OpError {
  return invalidInput('archive', message);
}

function unpack(core: Core, archive: Buffer): Map<string, Buffer> {
  const max = core.config.limits.maxImportBytes;
  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(archive, { maxOutputLength: max });
  } catch (err) {
    if (err instanceof RangeError || (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new OpError('too_large', { limit: max });
    }
    throw bad('The archive is not a gzip-compressed tar file.');
  }
  try {
    return tarUnpack(tar, { maxEntries: MAX_IMPORT_ENTRIES, maxTotalBytes: max });
  } catch (err) {
    if (err instanceof TarError) throw bad(err.message);
    throw err;
  }
}

function readManifest(files: Map<string, Buffer>): Manifest {
  const raw = files.get(MANIFEST_ENTRY);
  if (!raw) throw bad('manifest.json is missing.');
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    throw bad('manifest.json is not valid JSON.');
  }
  const parsed = ManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new OpError('invalid_input', {
      issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: `manifest.${i.path.map(String).join('.')}`, message: i.message })),
    });
  }
  return parsed.data;
}

/** A revision prepared for insertion. */
interface PlannedRevision extends ManifestRevision {
  createdAtMs: number;
}

interface PlannedDoc {
  src: ManifestDocument;
  id: string;
  path: string;
  revisions: PlannedRevision[];
  /** Bodies by hash (non-purged revisions). */
  bodies: Map<string, Buffer>;
  head: PlannedRevision;
  headBody: Buffer;
}

function ms(isoTime: string): number {
  const t = Date.parse(isoTime);
  if (!Number.isFinite(t)) throw bad('Bad time in manifest.');
  return t;
}

/**
 * Document check: revisions are numbered 1..head_rev without gaps (full archive), the head is not
 * purged, every non-purged revision has a body with the right sha256 and size; text is valid UTF-8.
 */
function planDoc(m: Manifest, d: ManifestDocument, files: Map<string, Buffer>, mode: ImportInput['mode']): PlannedDoc {
  const path = normalizePath(d.path, 'archive');
  let revisions: PlannedRevision[] = d.revisions.map((r) => ({ ...r, createdAtMs: ms(r.created_at) }));
  if (m.mode === 'full') {
    revisions.forEach((r, i) => {
      if (r.rev !== i + 1) throw bad('Revisions of a document must be numbered 1..head_rev without gaps.');
    });
    if (revisions.length !== d.head_rev) throw bad('head_rev does not match the revisions.');
  } else {
    if (revisions.length !== 1 || revisions[0]!.rev !== d.head_rev) throw bad('A head export has exactly the head revision per document.');
    if (d.deleted) throw bad('A head export has no deleted documents.');
    // Head only: the document starts its history anew, with revision 1 of kind import.
    const h = revisions[0]!;
    revisions = [{ ...h, rev: 1, kind: 'import', prev_path: null, ref_rev: null, path: h.path || path }];
  }
  const head = revisions[revisions.length - 1]!;
  if (head.purged) throw bad('The head revision cannot be purged.');
  const bodies = new Map<string, Buffer>();
  for (const r of revisions) {
    if (r.purged || bodies.has(r.content_hash)) continue;
    const entry = m.mode === 'full' ? files.get(blobEntry(r.content_hash)) : files.get(treeEntry(d.path));
    if (!entry) throw bad('A revision body is missing from the archive.');
    if (sha256(entry) !== r.content_hash || entry.length !== r.size) throw bad('A revision body does not match its sha256.');
    if (d.kind === 'text') {
      try {
        utf8.decode(entry);
      } catch {
        throw bad('A text body is not valid UTF-8.');
      }
    }
    bodies.set(r.content_hash, entry);
  }
  return { src: d, id: mode === 'restore' ? d.id : '', path, revisions, bodies, head, headBody: bodies.get(head.content_hash)! };
}

/** Secret scanner over the whole history: path, message and added lines of every revision. */
function scanArchive(docs: readonly PlannedDoc[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const d of docs) {
    let previous: string | undefined;
    for (const r of d.revisions) {
      const raw = r.purged ? undefined : d.bodies.get(r.content_hash);
      const text = raw === undefined ? undefined : d.src.kind === 'text' ? raw.toString('utf8') : fileAsText(raw);
      findings.push(...scanWrite({ path: r.path || undefined, message: r.message, content: text, previous: text === undefined ? undefined : previous }));
      if (text !== undefined) previous = text;
    }
  }
  return findings;
}

const TRUST_RANK: Record<Trust, number> = { limited: 0, trusted: 1, admin: 2 };
const BODY_KINDS: ReadonlySet<RevisionKind> = new Set(['create', 'update', 'revert', 'undo', 'import']);

function describeHead(d: PlannedDoc): { mime: string; title: string; meta: string } {
  if (d.src.kind === 'text') {
    const p = parseText(d.headBody.toString('utf8'), d.path);
    return { mime: textMime(d.path), title: p.title, meta: JSON.stringify(p.meta) };
  }
  return { mime: d.src.mime, title: fileTitle(d.path), meta: '{}' };
}

/** Authors by name: existing ones are matched, missing ones are created disabled and without tokens. */
function resolveAuthors(core: Core, m: Manifest, docs: readonly PlannedDoc[], by: string): { ids: Map<string, string>; created: string[] } {
  const kinds = new Map<string, { kind: Kind; trust: Trust; external?: boolean }>();
  for (const p of m.principals) kinds.set(p.name, { kind: p.kind, trust: p.trust, ...(p.external ? { external: true } : {}) });
  const names = new Set<string>();
  for (const d of docs) {
    for (const r of d.revisions) {
      names.add(r.author);
      if (r.approved_by) names.add(r.approved_by);
    }
    const m = d.src.handoff;
    if (m) for (const n of [m.from, m.to, m.resolved_by]) if (n) names.add(n);
  }
  const ids = new Map<string, string>();
  const created: string[] = [];
  for (const name of [...names].sort()) {
    const existing = findPrincipal(core, name);
    if (existing) {
      ids.set(name, existing.id);
      continue;
    }
    const k = kinds.get(name) ?? { kind: 'agent' as const, trust: 'limited' as const };
    if (k.kind === 'system') throw bad('Unknown system principal in archive.');
    const row: PrincipalRow = createPrincipal(
      core,
      { name, kind: k.kind, trust: k.trust, harness: null, ownerId: null, ...(k.external && k.kind === 'agent' ? { external: true } : {}) },
      by,
    );
    setDisabled(core, row, true);
    ids.set(name, row.id);
    created.push(name);
  }
  return { ids, created };
}

/**
 * `POST /api/v1/import` and `brain import`: superadmin only. `restore` keeps document ids (they must
 * not exist on the server), `as-new` assigns new ones. Both modes create a new space with the given
 * slug; grants are not carried in the archive.
 */
export function importArchive(ctx: AccessContext, input: ImportInput): ImportOut {
  const core = ctx.core;
  if (!isSuperadmin(ctx)) throw forbidden('admin');
  const files = unpack(core, input.archive);
  const m = readManifest(files);
  const docs = m.documents.map((d) => planDoc(m, d, files, input.mode));
  const ids = new Set<string>();
  const livePaths = new Set<string>();
  for (const d of docs) {
    if (ids.has(d.src.id)) throw bad('Duplicate document id in manifest.');
    ids.add(d.src.id);
    if (!d.src.deleted) {
      const key = pathKey(d.path);
      if (livePaths.has(key)) throw bad('Two live documents share a path.');
      livePaths.add(key);
    }
  }
  const findings = scanArchive(docs);
  if (findings.length > 0 && !input.confirmSecrets) throw secretDetected(findings);

  return core.db
    .transaction((): ImportOut => {
      if (findSpace(core, input.space)) throw conflict('slug_taken');
      if (input.mode === 'restore') {
        for (const d of docs) if (documentIdExists(core.db, d.src.id)) throw conflict('ids_taken');
      }
      const now = core.now();
      for (const d of docs) if (!d.id) d.id = newId(now);
      const s = m.space;
      const space: SpaceRow = createSpace(
        core,
        {
          slug: input.space,
          name: s.name,
          description: s.description,
          reviewMode: s.review_mode,
          executable: s.executable,
          inbox: s.inbox ?? s.slug === 'handoff',
          ttlDays: s.ttl_days,
          trashRetentionDays: s.trash_retention_days,
          quotaBytes: s.quota_bytes,
          maxDocBytes: s.max_doc_bytes,
          protectedPaths: s.protected_paths,
        },
        ctx.principal.id,
      );
      const authors = resolveAuthors(core, m, docs, ctx.principal.id);
      const author = (name: string): string => authors.ids.get(name)!;

      // Quotas: live heads and all history bodies.
      const live = docs.filter((d) => !d.src.deleted);
      const liveBytes = live.reduce((n, d) => n + d.head.size, 0);
      const allBodies = new Map<string, Buffer>();
      for (const d of docs) for (const [h, b] of d.bodies) allBodies.set(h, b);
      checkQuota(core, { space, liveDelta: liveBytes, newBodyBytes: [...allBodies.values()].reduce((n, b) => n + b.length, 0), showUsed: true });
      for (const d of docs) {
        for (const [, b] of d.bodies) {
          if (d.src.kind === 'text') putTextBlob(core, b.toString('utf8'));
          else putFileBlob(core, b);
        }
      }

      // Documents (head = last revision), then revisions in time order (new seq).
      for (const d of docs) {
        const first = d.revisions[0]!;
        const h = d.head;
        const bodyRevs = d.revisions.filter((r) => BODY_KINDS.has(r.kind));
        const floor = (bodyRevs.length ? bodyRevs : [h]).reduce<Trust>(
          (min, r) => (TRUST_RANK[r.author_trust] < TRUST_RANK[min] ? r.author_trust : min),
          'admin',
        );
        const lastBody = bodyRevs.length ? bodyRevs[bodyRevs.length - 1]!.createdAtMs : h.createdAtMs;
        const desc = describeHead(d);
        insertDocument(core.db, {
          id: d.id,
          tenant_id: core.tenantId,
          space_id: space.id,
          path: d.path,
          path_key: pathKey(d.path),
          kind: d.src.kind,
          mime: desc.mime,
          title: desc.title,
          meta: desc.meta,
          head_rev: h.rev,
          head_seq: 0,
          content_hash: h.content_hash,
          size: h.size,
          attribution: '[]',
          trust_floor: floor,
          created_at: first.createdAtMs,
          created_by: author(first.author),
          updated_at: h.createdAtMs,
          updated_by: author(h.author),
          deleted_at: d.src.deleted ? h.createdAtMs : null,
          deleted_by: d.src.deleted ? author(h.author) : null,
          expires_at: !d.src.deleted && space.ttl_days !== null ? lastBody + space.ttl_days * DAY_MS : null,
        });
      }
      const order = docs.flatMap((d, i) => d.revisions.map((r) => ({ d, i, r })));
      order.sort((a, b) => a.r.createdAtMs - b.r.createdAtMs || a.i - b.i || a.r.rev - b.r.rev);
      const headSeq = new Map<string, number>();
      for (const { d, r } of order) {
        const seq = insertRevision(core.db, {
          doc_id: d.id,
          rev: r.rev,
          kind: r.kind,
          space_id: space.id,
          // A location hidden from the exporter is unknown: the document's current path is used.
          path: r.path ? normalizePath(r.path, 'archive') : d.path,
          prev_space_id: r.prev_path ? space.id : null,
          prev_path: r.prev_path ? normalizePath(r.prev_path, 'archive') : null,
          content_hash: r.content_hash,
          size: r.size,
          author_id: author(r.author),
          author_trust: r.author_trust,
          approved_by: r.approved_by ? author(r.approved_by) : null,
          proposal_id: null,
          via: r.via,
          message: r.message,
          ref_rev: r.ref_rev,
          attention: r.attention ? 1 : 0,
          created_at: r.createdAtMs,
        });
        if (r.purged) markRevisionPurged(core.db, d.id, r.rev, now, ctx.principal.id);
        if (r === d.head) headSeq.set(d.id, seq);
      }
      for (const d of docs) {
        updateDocument(core.db, d.id, { head_seq: headSeq.get(d.id)! });
        // Yjs and the index come from the latest body, without replaying history.
        const text = d.src.kind === 'text' ? d.headBody.toString('utf8') : undefined;
        if (text !== undefined) putYState(core.db, { doc_id: d.id, state: applyText(null, text), head_rev: d.head.rev });
        if (!d.src.deleted) {
          indexDocument(core, { num: docNum(core.db, d.id), path: d.path, kind: d.src.kind, title: describeHead(d).title, text }, true);
        }
      }
      restoreMessages(core, space, docs, author);
      addBytesUsed(core.db, space.id, liveBytes);
      return {
        space: space.slug,
        mode: input.mode,
        documents: docs.length,
        revisions: order.length,
        principals_created: authors.created,
        ...(findings.length > 0 ? { secrets_confirmed: findings.length } : {}),
      };
    })
    .immediate();
}

/**
 * Handoff envelopes: principals by name, thread and reply ids mapped to the new document
 * ids (unknown ones: the thread starts at the message, no reply_to). Pending messages do not expire;
 * resolved ones expire 14 days (the space TTL) after resolution.
 */
function restoreMessages(core: Core, space: SpaceRow, docs: readonly PlannedDoc[], author: (name: string) => string): void {
  const ids = new Map(docs.map((d) => [d.src.id, d.id]));
  const insert = core.db.prepare(
    `INSERT INTO handoff_messages (doc_id, tenant_id, sender_id, recipient_id, thread_id, reply_to, created_at, content_rev, changed_at,
       received_rev, received_at, resolution, resolved_rev, resolved_at, resolved_by, note)
     VALUES (@doc_id, @tenant_id, @sender_id, @recipient_id, @thread_id, @reply_to, @created_at, @content_rev, @changed_at,
       @received_rev, @received_at, @resolution, @resolved_rev, @resolved_at, @resolved_by, @note)`,
  );
  const at = (t: string | null): number | null => (t === null ? null : ms(t));
  for (const d of docs) {
    const m = d.src.handoff;
    if (!m) continue;
    const row = {
      doc_id: d.id,
      tenant_id: core.tenantId,
      sender_id: author(m.from),
      recipient_id: author(m.to),
      thread_id: ids.get(m.thread_id) ?? d.id,
      reply_to: m.reply_to !== null ? (ids.get(m.reply_to) ?? null) : null,
      created_at: ms(m.created_at),
      content_rev: Math.min(m.content_rev, d.head.rev),
      changed_at: ms(m.changed_at),
      received_rev: m.received_rev,
      received_at: at(m.received_at),
      resolution: m.resolution,
      resolved_rev: m.resolved_rev,
      resolved_at: at(m.resolved_at),
      resolved_by: m.resolved_by !== null ? author(m.resolved_by) : null,
      note: m.note,
    };
    insert.run(row);
    if (d.src.deleted) continue;
    const resolved = row.resolution !== null && row.resolved_rev !== null && row.resolved_rev >= row.content_rev;
    updateDocument(core.db, d.id, { expires_at: resolved && row.resolved_at !== null ? resolvedExpiry(space, row.resolved_at) : null });
  }
}

// --- Plain tree ------------------------------------------------------------------------------------

export interface PlainFile {
  path: string;
  bytes: Buffer;
}

const TEXT_EXT = /\.(md|markdown|txt)$/i;

/**
 * `brain import --plain <dir> --space <slug>`: every file becomes a document with revision 1 on behalf
 * of the caller, via an ordinary commit write (scanner, quotas, index). All in one transaction: on any
 * error nothing is imported. The space is created if it does not exist.
 */
export function importPlain(ctx: WriteContext, space: string, files: readonly PlainFile[]): { space: string; documents: number } {
  if (!isSuperadmin(ctx)) throw forbidden('admin');
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return ctx.core.db
    .transaction(() => {
      if (!findSpace(ctx.core, space)) createSpace(ctx.core, { slug: space }, ctx.principal.id);
      // Permission snapshot taken after the space is created.
      const c: WriteContext = { ...ctx, snapshot: aclSnapshot(ctx.core) };
      let n = 0;
      for (const f of sorted) {
        const text = TEXT_EXT.test(f.path) ? fileAsText(f.bytes) : undefined;
        writeDocument(c, {
          space,
          path: f.path,
          ...(text !== undefined ? { content: text } : { bytes: f.bytes }),
          message: 'import',
        });
        n++;
      }
      return { space, documents: n };
    })
    .immediate();
}

