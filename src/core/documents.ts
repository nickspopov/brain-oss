// Documents: the single write path `commit` and the operations on a document.
// Each operation is one SQLite transaction (BEGIN IMMEDIATE): guard → routing →
// revision check → body (blobs, Yjs) → revision → document head → bytes_used → audit.
// The search index is step 10 (core/search/index); the webhook event is step 12 (core/events).
// A write that routing turns into a proposal is saved here too (proposeInTx), and accepting
// a proposal is an ordinary revision through applyRevision (acceptProposalInTx).
import { insertDocument, noteDocRead, updateDocument, type DocumentPatch, type DocumentView } from '../store/documents.js';
import { countOpenProposals, getProposalView, insertProposal } from '../store/proposals.js';
import { insertRevision, type RevisionInsert, type RevisionKind, type RevisionVia } from '../store/revisions.js';
import { addBytesUsed } from '../store/spaces.js';
import { getYState, putYState, setYStateHeadRev } from '../store/ystate.js';
import type { Kind, Role, SpaceRow, Trust } from '../store/types.js';
import { recordAudit } from './audit.js';
import { putFileBlob, putTextBlob, readBlob, readTextBlob, type Body } from './blobs.js';
import { byteLength, checkSize, decodeBase64, normalizeText, sha256, sniffMime, textMime } from './content.js';
import { docInfo, iso, type DocInfoOut } from './docview.js';
import { conflict, forbidden, invalidInput, notFound, OpError } from './errors.js';
import { fileTitle, parseText } from './frontmatter.js';
import {
  atLeast,
  reloadDoc,
  requireDoc,
  requirePathIn,
  requireWriteTarget,
  revisionOf,
  roleAt,
  type AccessContext,
  type DocAccess,
  type DocRefInput,
  type ProposalAccess,
} from './guard.js';
import { isAgentCard, isInboxSpace } from './handoff.js';
import { applyMessagePlan, getMessage, isResolved, planMessage, statusOf } from './inbox.js';
import { newId } from './ids.js';
import { normalizePath, pathKey } from './paths.js';
import { proposalOut, type ProposalOut } from './proposalview.js';
import { checkQuota } from './quota.js';
import { needsAttention, requireDirectWrite, reviewRequired, routeWrite } from './review.js';
import { indexDocument } from './search/index.js';
import { fileAsText, scanWrite, secretDetected, type ScanInput } from './secrets/scan.js';
import { applyText } from './ydoc/body.js';
import { boundedPatch } from './textdiff.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Current version text in a `conflict` body: at most 64 KB. */
const CONFLICT_CONTENT_MAX = 64 * 1024;
/** A file as a base64 string via `write`: up to 1 MB of source bytes. */
export const MAX_BASE64_FILE = 1024 * 1024;

/** Write context: access plus what goes into the revision and the audit. */
export interface WriteContext extends AccessContext {
  via: RevisionVia;
  tokenId: string | null;
  ip: string | null;
  /** Operation name for the audit. */
  op: string;
  requestId: string | null;
  /**
   * Secret scanner bypass: only a superadmin from the UI with an explicit flag. Findings (rules,
   * without values) are written to the write's audit row.
   */
  allowSecret?: boolean;
}

export type CommitResult =
  | { status: 'committed'; doc: DocInfoOut; unchanged?: true; warnings?: string[] }
  | { status: 'proposed'; proposal: ProposalOut; warnings?: string[] };

// --- Body ------------------------------------------------------------------------------------

interface TextBody {
  kind: 'text';
  text: string;
  hash: string;
  size: number;
}
interface FileBody {
  kind: 'file';
  bytes: Buffer;
  hash: string;
  size: number;
}
type NewBody = TextBody | FileBody;

function textBody(text: string): TextBody {
  return { kind: 'text', text, hash: sha256(text), size: byteLength(text) };
}

function fileBody(bytes: Buffer): FileBody {
  return { kind: 'file', bytes, hash: sha256(bytes), size: bytes.length };
}

function maxDocBytes(ctx: AccessContext, space: SpaceRow): number {
  return space.max_doc_bytes ?? ctx.core.config.limits.maxDocBytes;
}

/** Title, MIME and meta from the body and the path. */
function describe(path: string, body: { kind: 'text'; text: string } | { kind: 'file'; bytes: Buffer }) {
  if (body.kind === 'text') {
    const p = parseText(body.text, path);
    return { mime: textMime(path), title: p.title, meta: JSON.stringify(p.meta), warnings: p.warnings };
  }
  return { mime: sniffMime(body.bytes), title: fileTitle(path), meta: '{}', warnings: [] as string[] };
}

function bodyOf(ctx: AccessContext, hash: string, kind: 'text' | 'file'): Body {
  const b = readBlob(ctx.core, hash, kind);
  if (!b) throw new Error('document body is missing');
  return b;
}

/** Space usage in `quota_exceeded`: only for its administrator. */
function seesSpaceUsage(ctx: AccessContext, space: SpaceRow): boolean {
  return atLeast(roleAt(ctx, space), 'admin');
}

// --- Trust ------------------------------------------------------------------------------------

const TRUST_RANK: Record<Trust, number> = { limited: 0, trusted: 1, admin: 2 };
const minTrust = (a: Trust, b: Trust): Trust => (TRUST_RANK[a] <= TRUST_RANK[b] ? a : b);

/** Revisions that change the body: they may lower trust_floor. */
const BODY_KINDS: ReadonlySet<RevisionKind> = new Set(['create', 'update', 'revert', 'undo', 'import']);

// --- commit ------------------------------------------------------------------------------------

interface Intent {
  space: SpaceRow;
  existing: DocumentView | undefined;
  kind: RevisionKind;
  path: string;
  body?: NewBody;
  message: string;
  refRev?: number;
  prev?: { spaceId: string; path: string };
  deleted?: 'set' | 'clear';
  /** `undefined` keeps it as is. */
  expiresAt?: number | null;
  /** Do not write an audit row (the next step of the same operation writes it: one row per call). */
  skipAudit?: boolean;
  /** The `detail` field of the audit row. */
  auditDetail?: Record<string, unknown>;
  /** Revision author, if not the caller: an accepted proposal. */
  author?: RevisionAuthor;
  /** Who accepted the proposal. */
  approvedBy?: string;
  proposalId?: string;
}

export interface RevisionAuthor {
  id: string;
  name: string;
  kind: Kind;
  trust: Trust;
}

/**
 * Steps 7–11 of `commit` inside an already open transaction: body, Yjs, revision, head,
 * bytes_used, audit. Permission, routing and revision checks are done by the calling function.
 */
function applyRevision(ctx: WriteContext, it: Intent): DocumentView {
  const core = ctx.core;
  const now = core.now();
  const author: RevisionAuthor = it.author ?? ctx.principal;
  const trust = author.trust;
  const prev = it.existing;
  const id = prev?.id ?? newId(now);
  const rev = (prev?.head_rev ?? 0) + 1;
  const docKind = it.body?.kind ?? prev?.kind;
  if (!docKind) throw new Error('a new document needs a body');

  // 6. Quotas: only if the write adds bytes.
  const newSize = it.body ? it.body.size : (prev?.size ?? 0);
  const goesLive = it.deleted === 'set' ? false : it.deleted === 'clear' ? true : prev ? prev.deleted_at === null : true;
  checkQuota(core, {
    space: it.space,
    liveDelta: (goesLive ? newSize : 0) - (prev && prev.deleted_at === null ? prev.size : 0),
    newBodyBytes: it.body && it.body.hash !== prev?.content_hash ? it.body.size : 0,
    showUsed: seesSpaceUsage(ctx, it.space),
  });

  // 7. Body and Yjs.
  let hash = prev?.content_hash ?? '';
  let size = prev?.size ?? 0;
  let described: ReturnType<typeof describe> | undefined;
  if (it.body) {
    const b = it.body;
    const stored = b.kind === 'text' ? putTextBlob(core, b.text) : putFileBlob(core, b.bytes);
    hash = stored.hash;
    size = stored.size;
    described = describe(it.path, b.kind === 'text' ? { kind: 'text', text: b.text } : { kind: 'file', bytes: b.bytes });
  } else if (prev && it.path !== prev.path) {
    // Move: the file-name title and the MIME depend on the path.
    const b = bodyOf(ctx, prev.content_hash, prev.kind);
    described = describe(it.path, b.kind === 'text' ? { kind: 'text', text: b.text } : { kind: 'file', bytes: b.bytes });
    if (prev.kind === 'file') described.mime = prev.mime;
  }

  // 8. Trust level of the text (per revision, not per character).
  const floor = BODY_KINDS.has(it.kind) ? (prev ? minTrust(prev.trust_floor, trust) : trust) : (prev?.trust_floor ?? trust);

  // Lifetime: agent cards handoff/_agents/ do not expire; a document moved out of there gets the space's lifetime.
  let expiresAt = it.expiresAt;
  if (isAgentCard(it.space, it.path)) expiresAt = null;
  else if (prev && expiresAt === undefined && isAgentCard(it.space, prev.path)) expiresAt = expiresFor(ctx, it.space, undefined);
  // Handoff messages: a create under handoff/<name>/ registers one, a body change reopens
  // it; a message that is not done/declined never expires.
  const bodyChanged = it.body !== undefined && BODY_KINDS.has(it.kind) && (!prev || it.body.hash !== prev.content_hash);
  const message = planMessage(core, it.space, prev, it.path, it.kind, bodyChanged);
  if (message?.pendingAfter) expiresAt = null;

  // 9. Revision and head.
  const deletedAt = it.deleted === 'set' ? now : it.deleted === 'clear' ? null : (prev?.deleted_at ?? null);
  const revisionRow = (): RevisionInsert => ({
    doc_id: id,
    rev,
    kind: it.kind,
    space_id: it.space.id,
    path: it.path,
    prev_space_id: it.prev?.spaceId ?? null,
    prev_path: it.prev?.path ?? null,
    content_hash: hash,
    size,
    author_id: author.id,
    author_trust: trust,
    approved_by: it.approvedBy ?? null,
    proposal_id: it.proposalId ?? null,
    via: ctx.via,
    message: it.message,
    ref_rev: it.refRev ?? null,
    attention: needsAttention(it.space, trust) ? 1 : 0,
    created_at: now,
  });
  if (!prev) {
    if (!described) throw new Error('a new document needs a body');
    insertDocument(core.db, {
      id,
      tenant_id: core.tenantId,
      space_id: it.space.id,
      path: it.path,
      path_key: pathKey(it.path),
      kind: docKind,
      mime: described.mime,
      title: described.title,
      meta: described.meta,
      head_rev: rev,
      head_seq: 0,
      content_hash: hash,
      size,
      attribution: '[]',
      trust_floor: floor,
      created_at: now,
      created_by: author.id,
      updated_at: now,
      updated_by: author.id,
      deleted_at: null,
      deleted_by: null,
      expires_at: expiresAt ?? null,
    });
    // The revision references the document (FK): first the document row, then the revision and its seq.
    updateDocument(core.db, id, { head_seq: insertRevision(core.db, revisionRow()) });
  } else {
    const seq = insertRevision(core.db, revisionRow());
    const patch: DocumentPatch = {
      space_id: it.space.id,
      path: it.path,
      path_key: pathKey(it.path),
      head_rev: rev,
      head_seq: seq,
      content_hash: hash,
      size,
      trust_floor: floor,
      updated_at: now,
      updated_by: author.id,
      deleted_at: deletedAt,
      deleted_by: it.deleted === 'set' ? ctx.principal.id : it.deleted === 'clear' ? null : prev.deleted_by,
    };
    if (described) {
      patch.mime = described.mime;
      patch.title = described.title;
      patch.meta = described.meta;
    }
    if (expiresAt !== undefined) patch.expires_at = expiresAt;
    updateDocument(core.db, id, patch);
  }

  if (message) {
    applyMessagePlan(core.db, message, { tenantId: core.tenantId, docId: id, rev, senderId: author.id, now });
    // Parked waits of both parties re-check after this transaction (they resume asynchronously).
    core.waiters.wake(message.kind === 'create' ? [message.recipientId, author.id] : [message.row.recipient_id, message.row.sender_id]);
  }

  // The Yjs body holds the same as the head; files have none.
  if (docKind === 'text') {
    if (it.body?.kind === 'text') {
      const state = getYState(core.db, id);
      putYState(core.db, { doc_id: id, state: applyText(state ? new Uint8Array(state.state) : null, it.body.text), head_rev: rev });
    } else {
      setYStateHeadRev(core.db, id, rev);
    }
  }

  const liveBefore = prev && prev.deleted_at === null ? prev.size : 0;
  const liveAfter = deletedAt === null ? size : 0;
  addBytesUsed(core.db, it.space.id, liveAfter - liveBefore);

  // 10. Search index: only the head of a live document, in the same transaction.
  const after = reloadDoc(ctx, id);
  const live = after.deleted_at === null;
  const wasLive = prev !== undefined && prev.deleted_at === null;
  if (it.body || live !== wasLive || (prev !== undefined && prev.path !== after.path)) {
    const text = !live || after.kind !== 'text' ? undefined : it.body?.kind === 'text' ? it.body.text : readTextBlob(core, after.content_hash);
    indexDocument(core, { num: after.num, path: after.path, kind: after.kind, title: after.title, text }, live);
  }

  // 11. Audit in the same transaction.
  if (!it.skipAudit) audit(ctx, { space_id: it.space.id, doc_id: id, rev }, it.auditDetail);

  // 12. Event: subscribers write the webhook queue in the same transaction.
  core.events.publish({
    type: 'revision.created',
    seq: after.head_seq,
    space_id: it.space.id,
    doc: { id, space: it.space.slug, path: after.path },
    rev,
    kind: it.kind,
    author: { name: author.name, kind: author.kind, trust },
    attention: needsAttention(it.space, trust),
    created_at: now,
  });
  return after;
}

function audit(ctx: WriteContext, where: { space_id: string; doc_id: string | null; rev: number | null }, detail?: Record<string, unknown>): void {
  recordAudit(ctx.core, {
    principal_id: ctx.principal.id,
    token_id: ctx.tokenId,
    via: ctx.via,
    op: ctx.op,
    outcome: 'ok',
    request_id: ctx.requestId,
    ip: ctx.ip,
    ...where,
    ...(detail ? { detail } : {}),
  });
}

/** Write transaction: BEGIN IMMEDIATE (or a savepoint inside an already open one). */
function tx<T>(ctx: AccessContext, fn: () => T): T {
  return ctx.core.db.transaction(fn).immediate();
}

// --- Secret scanner (commit step 3) -------------------------------------------------------------

function mayBypassSecrets(ctx: WriteContext): boolean {
  return ctx.principal.kind === 'human' && ctx.principal.role === 'superadmin' && ctx.via === 'ui';
}

/** Checks the bypass flag before permissions and the write: agents cannot use the flag. */
function checkBypassFlag(ctx: WriteContext): void {
  if (ctx.allowSecret && !mayBypassSecrets(ctx)) {
    throw invalidInput('allow_secret', 'Only the superadmin can override the secret scanner, from the UI.');
  }
}

/**
 * Step 3 of `commit`: path, message and the added lines of the body. Findings → `secret_detected`
 * without values; with an allowed bypass, `detail` for the audit (rule names only).
 */
function scanSecrets(ctx: WriteContext, input: ScanInput): Record<string, unknown> | undefined {
  const findings = scanWrite(input);
  if (findings.length === 0) return undefined;
  if (ctx.allowSecret && mayBypassSecrets(ctx)) return { secret_override: [...new Set(findings.map((f) => f.rule))] };
  throw secretDetected(findings);
}

/** Body text for the scanner: text as is, a file if it is UTF-8 up to 1 MB. */
function scannable(body: NewBody | Body | undefined): string | undefined {
  if (!body) return undefined;
  return body.kind === 'text' ? body.text : fileAsText(body.bytes);
}

/** Body of the document head as text, for comparing "added lines". */
function headText(ctx: AccessContext, doc: DocumentView | undefined): string | undefined {
  if (!doc) return undefined;
  return scannable(readBlob(ctx.core, doc.content_hash, doc.kind));
}

// --- Conflicts ----------------------------------------------------------------------------------

function currentOf(ctx: AccessContext, doc: DocumentView): Record<string, unknown> {
  const cur: Record<string, unknown> = {
    rev: doc.head_rev,
    content_hash: doc.content_hash,
    author: { name: doc.author_name, kind: doc.author_kind, trust: doc.author_trust },
    updated_at: iso(doc.updated_at),
  };
  if (doc.kind === 'text') {
    const text = readTextBlob(ctx.core, doc.content_hash);
    if (text !== undefined) {
      if (byteLength(text) <= CONFLICT_CONTENT_MAX) cur.content = text;
      else cur.content_truncated = true;
    }
  }
  return cur;
}

/** `conflict` with the current version and a diff from `expected_rev` to the head (if it exists and is not purged). */
function conflictAt(ctx: AccessContext, access: DocAccess, reason: string, expectedRev?: number, requested?: string): OpError {
  const doc = access.doc;
  const note = requested === undefined ? undefined : caseNote(requested, doc);
  const extra: Record<string, unknown> = { ...(note?.extra ?? {}), current: currentOf(ctx, doc) };
  if (doc.kind === 'text' && expectedRev !== undefined && expectedRev >= 1 && expectedRev < doc.head_rev) {
    const base = revisionOf(ctx, access, expectedRev);
    const a = base.purged_at === null ? readTextBlob(ctx.core, base.content_hash) : undefined;
    const b = readTextBlob(ctx.core, doc.content_hash);
    if (a !== undefined && b !== undefined) {
      // Inside the write transaction: the diff is bounded; above the cap, only a flag.
      const diff = boundedPatch(doc.path, expectedRev, doc.head_rev, a, b);
      if (diff !== undefined) extra.diff = diff;
      else extra.diff_truncated = true;
    }
  }
  return note ? new OpError('conflict', { reason, ...extra }, note.message) : conflict(reason, extra);
}

/**
 * Paths are case-insensitive (one live document per path_key). When the caller's path differs from
 * the existing one only by letter case, the conflict says so. The caller can read the
 * existing document (requirePathIn requires read), so its path is not a leak.
 */
function caseNote(requested: string, existing: { path: string }): { message: string; extra: Record<string, unknown> } | undefined {
  if (requested === existing.path) return undefined;
  return {
    message: `Path conflicts with existing '${existing.path}' (paths are case-insensitive).`,
    extra: { existing_path: existing.path, case_insensitive: true },
  };
}

/** `conflict` with reason, plus the case-insensitive note when the paths differ only by case. */
function pathConflict(reason: string, requested: string, existing: { path: string }): OpError {
  const note = caseNote(requested, existing);
  return note ? new OpError('conflict', { reason, ...note.extra }, note.message) : conflict(reason);
}

function checkExpected(ctx: AccessContext, access: DocAccess, expectedRev: number | undefined): void {
  if (expectedRev !== undefined && expectedRev !== access.doc.head_rev) throw conflictAt(ctx, access, 'stale', expectedRev);
}

// --- write -------------------------------------------------------------------------------------

export interface WriteInput {
  space: string;
  path: string;
  content?: string | undefined;
  contentBase64?: string | undefined;
  /** File bytes from the upload route or a tree import: up to `BRAIN_MAX_FILE_MB`. */
  bytes?: Buffer | undefined;
  expectedRev?: number | undefined;
  ttlDays?: number | undefined;
  message: string;
}

/** Lifetime: `ttl_days` of a write is at most the space's value. */
function expiresFor(ctx: AccessContext, space: SpaceRow, ttlDays: number | undefined): number | null {
  const days = ttlDays !== undefined && space.ttl_days !== null ? Math.min(ttlDays, space.ttl_days) : (ttlDays ?? space.ttl_days);
  return days === null || days === undefined ? null : ctx.core.now() + days * DAY_MS;
}

/**
 * Lifetime for a new revision of an existing document without an explicit `ttl_days`: it is
 * extended by the document's own lifetime (`expires_at − updated_at`, rounded up to whole days),
 * not by the space's lifetime. A document without a lifetime or already expired (restore after
 * expire) gets the space's lifetime, as before.
 */
function renewedExpiry(ctx: AccessContext, space: SpaceRow, doc: DocumentView): number | null {
  // The lifetime had already passed by the last revision (restoring an expired one): its own length is unknown, use the space's.
  if (doc.expires_at === null || doc.expires_at <= doc.updated_at) return expiresFor(ctx, space, undefined);
  const days = Math.ceil((doc.expires_at - doc.updated_at) / DAY_MS);
  return expiresFor(ctx, space, days);
}

/** `write`: create or replace the body, checking `expected_rev`. */
export function writeDocument(ctx: WriteContext, input: WriteInput): CommitResult {
  // 1. Normalise path and content (before permissions: the error depends only on the input).
  const forms = [input.content, input.contentBase64, input.bytes].filter((v) => v !== undefined).length;
  if (forms !== 1) {
    throw invalidInput('content', 'Pass either content or content_base64.');
  }
  const path = normalizePath(input.path);
  let body: NewBody;
  if (input.content !== undefined) {
    body = textBody(normalizeText(input.content));
  } else if (input.bytes !== undefined) {
    checkSize(input.bytes.length, ctx.core.config.limits.maxFileBytes);
    body = fileBody(input.bytes);
  } else {
    const bytes = decodeBase64(input.contentBase64!);
    checkSize(bytes.length, Math.min(MAX_BASE64_FILE, ctx.core.config.limits.maxFileBytes));
    body = fileBody(bytes);
  }
  checkBypassFlag(ctx);
  return tx(ctx, () => {
    // 2. Guard and routing.
    const target = requireWriteTarget(ctx, input.space, path, 'propose');
    if (body.kind === 'text') checkSize(body.size, maxDocBytes(ctx, target.space));
    const route = routeWrite(target.space, target.path, target.role, ctx.principal.trust);
    // A proposal is the full text; files are never turned into proposals.
    if (route === 'propose' && body.kind !== 'text') throw reviewRequired();
    const existing = target.existing;
    // 3. Secret scanner: path, message, lines added relative to the head.
    const content = scannable(body);
    const override = scanSecrets(ctx, {
      path: target.path,
      message: input.message,
      content,
      previous: content === undefined ? undefined : headText(ctx, existing),
    });
    // 5. Revision check.
    if (!existing) {
      if (input.expectedRev !== undefined && input.expectedRev > 0) throw conflict('not_found_at_rev');
    } else {
      const access: DocAccess = { space: target.space, doc: existing, role: target.role };
      if (input.expectedRev === undefined) throw conflictAt(ctx, access, 'expected_rev_required', undefined, path);
      if (input.expectedRev === 0) throw conflictAt(ctx, access, 'already_exists', undefined, path);
      if (input.expectedRev !== existing.head_rev) throw conflictAt(ctx, access, 'stale', input.expectedRev, path);
      if (existing.kind !== body.kind) throw new OpError('unsupported', { reason: 'kind_mismatch' });
      if (existing.content_hash === body.hash) {
        audit(ctx, { space_id: target.space.id, doc_id: existing.id, rev: existing.head_rev }, { unchanged: true });
        return { status: 'committed', doc: docInfo(ctx, existing), unchanged: true };
      }
    }
    const warnings = body.kind === 'text' ? parseText(body.text, path).warnings : [];
    if (route === 'propose' && body.kind === 'text') {
      return proposeInTx(ctx, {
        space: target.space,
        path: existing ? existing.path : target.path,
        existing,
        body,
        message: input.message,
        warnings,
        ...(override ? { auditDetail: override } : {}),
      });
    }
    const doc = applyRevision(ctx, {
      space: target.space,
      existing,
      kind: existing ? 'update' : 'create',
      // Only move changes the case of a path.
      path: existing ? existing.path : target.path,
      body,
      message: input.message,
      expiresAt: existing && input.ttlDays === undefined ? renewedExpiry(ctx, target.space, existing) : expiresFor(ctx, target.space, input.ttlDays),
      ...(override ? { auditDetail: override } : {}),
    });
    return { status: 'committed', doc: docInfo(ctx, doc), ...(warnings.length ? { warnings } : {}) };
  });
}

// --- edit ----------------------------------------------------------------------------------------

/** An edit: exact replacement of a fragment, exactly one match. */
export interface TextEdit {
  oldText: string;
  newText: string;
}

export interface EditInput {
  ref: DocRefInput;
  edits: readonly TextEdit[];
  expectedRev?: number | undefined;
  message: string;
}

/** Line numbers (from 1) of at most this many matches are named in an `ambiguous` error. */
const MAX_MATCH_LINES = 20;

function editFailed(index: number, reason: 'not_found' | 'ambiguous', lines?: number[]): OpError {
  return new OpError('edit_failed', { edit_index: index, reason, ...(lines ? { lines } : {}) });
}

function lineOf(text: string, offset: number): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/**
 * Apply edits in order to one text. Each `old_text` must occur exactly once in the text
 * after the previous edits; otherwise `edit_failed` with the edit number, and nothing is
 * applied.
 */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let out = text;
  edits.forEach((e, index) => {
    const oldText = normalizeText(e.oldText, `edits.${index}.old_text`);
    const newText = normalizeText(e.newText, `edits.${index}.new_text`);
    const first = out.indexOf(oldText);
    if (first === -1) throw editFailed(index, 'not_found');
    const second = out.indexOf(oldText, first + 1);
    if (second !== -1) {
      const lines: number[] = [];
      for (let at = first; at !== -1 && lines.length < MAX_MATCH_LINES; at = out.indexOf(oldText, at + 1)) lines.push(lineOf(out, at));
      throw editFailed(index, 'ambiguous', lines);
    }
    out = out.slice(0, first) + newText + out.slice(first + oldText.length);
  });
  return out;
}

/**
 * `edit`: edits are applied to the head inside the write transaction.
 * Without `expected_rev`, to the current head (the anchor itself checks that the text is there); with it,
 * it is checked. Then as for `write`: size, routing, scanner (on the result), quota.
 */
export function editDocument(ctx: WriteContext, input: EditInput): CommitResult {
  checkBypassFlag(ctx);
  return tx(ctx, () => {
    const access = requireDoc(ctx, input.ref, 'propose');
    const route = routeWrite(access.space, access.doc.path, access.role, ctx.principal.trust);
    if (access.doc.kind !== 'text') throw new OpError('unsupported', { reason: 'not_text' });
    const head = readTextBlob(ctx.core, access.doc.content_hash);
    if (head === undefined) throw new Error('document body is missing');
    checkExpected(ctx, access, input.expectedRev);
    const body = textBody(applyEdits(head, input.edits));
    checkSize(body.size, maxDocBytes(ctx, access.space));
    const override = scanSecrets(ctx, { message: input.message, content: body.text, previous: head });
    if (body.hash === access.doc.content_hash) {
      audit(ctx, { space_id: access.space.id, doc_id: access.doc.id, rev: access.doc.head_rev }, { unchanged: true });
      return { status: 'committed', doc: docInfo(ctx, access.doc), unchanged: true };
    }
    const warnings = parseText(body.text, access.doc.path).warnings;
    if (route === 'propose') {
      return proposeInTx(ctx, {
        space: access.space,
        path: access.doc.path,
        existing: access.doc,
        body,
        message: input.message,
        warnings,
        ...(override ? { auditDetail: override } : {}),
      });
    }
    const doc = applyRevision(ctx, {
      space: access.space,
      existing: access.doc,
      kind: 'update',
      path: access.doc.path,
      body,
      message: input.message,
      expiresAt: renewedExpiry(ctx, access.space, access.doc),
      ...(override ? { auditDetail: override } : {}),
    });
    return { status: 'committed', doc: docInfo(ctx, doc), ...(warnings.length ? { warnings } : {}) };
  });
}

// --- delete / restore / move -----------------------------------------------------------------

/** `delete`: a delete revision; the document leaves list and the path is freed. */
export function deleteDocument(ctx: WriteContext, ref: DocRefInput, expectedRev: number | undefined, message: string): { doc: DocInfoOut } {
  return tx(ctx, () => {
    const access = requireDoc(ctx, ref, 'write');
    requireDirectWrite(access.space, access.doc.path, access.role, ctx.principal.trust);
    scanSecrets(ctx, { message });
    checkExpected(ctx, access, expectedRev);
    const doc = applyRevision(ctx, {
      space: access.space,
      existing: access.doc,
      kind: 'delete',
      path: access.doc.path,
      message,
      deleted: 'set',
    });
    return { doc: docInfo(ctx, doc) };
  });
}

/**
 * Role on the target path of `move`/`restore`: path and space grants, **without** a doc grant;
 * otherwise a grant on one document would let it be moved into a folder where the caller has
 * only `read` (or into AGENTS.md). The grant on the document itself is checked by the caller.
 * At the document's previous location (restore without a path) the doc grant applies too: an in-place edit.
 * < read → not_found, < min → forbidden.
 */
function roleOnTarget(ctx: AccessContext, space: SpaceRow, path: string, doc: DocumentView, min: Role): Role {
  const key = pathKey(path);
  const role = key === doc.path_key ? roleAt(ctx, space, key, doc.id) : roleAt(ctx, space, key);
  if (!atLeast(role, 'read')) throw notFound();
  if (!atLeast(role, min)) throw forbidden(min);
  return role;
}

/**
 * `restore`: a restore revision; the same routing and
 * protected_paths check as for a write, for the target path. Path taken → conflict path_taken.
 */
export function restoreDocument(ctx: WriteContext, id: string, rawPath: string | undefined, message: string): { doc: DocInfoOut } {
  const newPath = rawPath === undefined ? undefined : normalizePath(rawPath);
  return tx(ctx, () => {
    const access = requireDoc(ctx, { id }, 'write', { includeDeleted: true });
    if (access.doc.deleted_at === null) throw conflict('not_deleted');
    const doc = restoreInTx(ctx, access, newPath ?? access.doc.path, message);
    return { doc: docInfo(ctx, doc) };
  });
}

function restoreInTx(ctx: WriteContext, access: DocAccess, path: string, message: string, skipAudit = false): DocumentView {
  const role = roleOnTarget(ctx, access.space, path, access.doc, 'write');
  requireDirectWrite(access.space, path, role, ctx.principal.trust);
  scanSecrets(ctx, { path, message });
  const taken = requirePathIn(ctx, access.space, path, 'none').existing;
  if (taken) throw pathConflict('path_taken', normalizePath(path), taken);
  return applyRevision(ctx, {
    space: access.space,
    existing: access.doc,
    kind: 'restore',
    path,
    message,
    deleted: 'clear',
    expiresAt: renewedExpiry(ctx, access.space, access.doc),
    skipAudit,
  });
}

export interface MoveInput {
  ref: DocRefInput;
  toSpace?: string | undefined;
  toPath: string;
  expectedRev?: number | undefined;
  message: string;
}

/**
 * `move`: only a document and only within a space; `write` on
 * the source and target paths.
 */
export function moveDocument(ctx: WriteContext, input: MoveInput): { doc: DocInfoOut } {
  if (input.toPath.endsWith('/')) throw invalidInput('to_path', 'Moving folders is not supported.');
  const toPath = normalizePath(input.toPath, 'to_path');
  return tx(ctx, () => {
    const access = requireDoc(ctx, input.ref, 'write');
    if (input.toSpace !== undefined && input.toSpace !== access.space.slug) {
      throw invalidInput('to_space', 'Moving a document to another space is not supported.');
    }
    requireDirectWrite(access.space, access.doc.path, access.role, ctx.principal.trust);
    const role = roleOnTarget(ctx, access.space, toPath, access.doc, 'write');
    requireDirectWrite(access.space, toPath, role, ctx.principal.trust);
    scanSecrets(ctx, { path: toPath, message: input.message });
    checkExpected(ctx, access, input.expectedRev);
    if (toPath === access.doc.path) {
      audit(ctx, { space_id: access.space.id, doc_id: access.doc.id, rev: access.doc.head_rev }, { unchanged: true });
      return { doc: docInfo(ctx, access.doc) };
    }
    const taken = requirePathIn(ctx, access.space, toPath, 'none').existing;
    if (taken && taken.id !== access.doc.id) throw pathConflict('path_taken', toPath, taken);
    const doc = applyRevision(ctx, {
      space: access.space,
      existing: access.doc,
      kind: 'move',
      path: toPath,
      prev: { spaceId: access.space.id, path: access.doc.path },
      message: input.message,
    });
    return { doc: docInfo(ctx, doc) };
  });
}

// --- revert ------------------------------------------------------------------------------------

/**
 * `revert(to_rev)`: a new revert revision with the body of `to_rev`, `ref_rev = to_rev`.
 * A deleted document is restored first (a restore revision).
 */
export function revertDocument(
  ctx: WriteContext,
  ref: DocRefInput,
  toRev: number,
  expectedRev: number | undefined,
  message: string,
): CommitResult {
  return tx(ctx, () => {
    // The propose role is enough: with it the revert becomes a proposal.
    let access = requireDoc(ctx, ref, 'propose', { includeDeleted: true });
    const route = routeWrite(access.space, access.doc.path, access.role, ctx.principal.trust);
    // Restoring a deleted document and reverting a file are never turned into proposals.
    if (route === 'propose' && (access.doc.deleted_at !== null || access.doc.kind !== 'text')) throw reviewRequired();
    checkExpected(ctx, access, expectedRev);
    const target = revisionOf(ctx, access, toRev);
    if (target.purged_at !== null) throw new OpError('purged', { rev: toRev });
    const stored = bodyOf(ctx, target.content_hash, access.doc.kind);
    // Step 3: the body of to_rev returns to the head; its lines that are not in the head are "added".
    const content = scannable(stored);
    scanSecrets(ctx, { message, content, previous: content === undefined ? undefined : headText(ctx, access.doc) });
    const unchangedBody = access.doc.content_hash === target.content_hash;
    let restored = false;
    if (access.doc.deleted_at !== null) {
      // One audit row per call: the last revision of the operation writes it.
      access = { ...access, doc: restoreInTx(ctx, access, access.doc.path, message, !unchangedBody) };
      restored = true;
    }
    if (unchangedBody) {
      // The body is already the same: no new revert revision; the restore, if any, is recorded.
      if (restored) return { status: 'committed', doc: docInfo(ctx, access.doc) };
      audit(ctx, { space_id: access.space.id, doc_id: access.doc.id, rev: access.doc.head_rev }, { unchanged: true });
      return { status: 'committed', doc: docInfo(ctx, access.doc), unchanged: true };
    }
    const body: NewBody = stored.kind === 'text' ? textBody(stored.text) : fileBody(stored.bytes);
    if (route === 'propose' && body.kind === 'text') {
      return proposeInTx(ctx, { space: access.space, path: access.doc.path, existing: access.doc, body, message, warnings: [] });
    }
    const doc = applyRevision(ctx, {
      space: access.space,
      existing: access.doc,
      kind: 'revert',
      path: access.doc.path,
      body,
      message,
      refRev: toRev,
      // A new body means a new lifetime, as for a write, of the same length.
      expiresAt: renewedExpiry(ctx, access.space, access.doc),
    });
    return { status: 'committed', doc: docInfo(ctx, doc) };
  });
}

/** Full read of the head: the read counter for "unread → archive". */
export function noteFullRead(ctx: AccessContext, access: DocAccess): void {
  noteDocRead(ctx.core.db, access.doc.id, ctx.core.now());
}

// --- Proposals -------------------------------------------------------------------------------------

interface ProposeIntent {
  space: SpaceRow;
  path: string;
  existing: DocumentView | undefined;
  body: TextBody;
  message: string;
  warnings: string[];
  auditDetail?: Record<string, unknown>;
}

/**
 * Saves a proposal inside the write transaction: the limit of open proposals per author, the body in
 * blobs (data quotas), the `proposals` row, audit, the `proposal.created` event. Size and the secret
 * scanner are checked by the calling function. `base_rev` is the current head (0 for a new document).
 */
function proposeInTx(ctx: WriteContext, it: ProposeIntent): CommitResult {
  const core = ctx.core;
  const limit = core.config.limits.maxOpenProposals;
  const open = countOpenProposals(core.db, ctx.principal.id);
  if (open >= limit) throw new OpError('quota_exceeded', { limit, used: open, scope: 'open_proposals' });
  checkQuota(core, { space: it.space, liveDelta: 0, newBodyBytes: it.body.size, showUsed: seesSpaceUsage(ctx, it.space) });
  const stored = putTextBlob(core, it.body.text);
  const now = core.now();
  const id = newId(now);
  insertProposal(core.db, {
    id,
    space_id: it.space.id,
    doc_id: it.existing?.id ?? null,
    path: it.path,
    base_rev: it.existing?.head_rev ?? 0,
    content_hash: stored.hash,
    message: it.message,
    author_id: ctx.principal.id,
    author_trust: ctx.principal.trust,
    status: 'open',
    created_at: now,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    result_seq: null,
  });
  audit(ctx, { space_id: it.space.id, doc_id: it.existing?.id ?? null, rev: null }, { proposal_id: id, ...it.auditDetail });
  const view = getProposalView(core.db, id);
  if (!view) throw new Error('proposal row is missing');
  const access: ProposalAccess = { proposal: view, space: it.space, path: it.path, doc: it.existing, role: 'propose' };
  const proposal = proposalOut(access);
  core.events.publish({
    type: 'proposal.created',
    space_id: it.space.id,
    proposal: { id, space: it.space.slug, path: it.path, doc_id: it.existing?.id ?? null, base_rev: proposal.base_rev },
    author: { name: ctx.principal.name, kind: ctx.principal.kind, trust: ctx.principal.trust },
    attention: proposal.human_required,
    created_at: now,
  });
  return { status: 'proposed', proposal, ...(it.warnings.length ? { warnings: it.warnings } : {}) };
}

export interface ProposeInput {
  space: string;
  path: string;
  content: string;
  baseRev?: number | undefined;
  message: string;
}

/**
 * `propose`: a full-text proposal regardless of the space mode. Requires
 * role `propose` on the path. `base_rev` is checked like `expected_rev` of `write` (without it, the
 * current head); a proposal is always based on the head.
 */
export function proposeDocument(ctx: WriteContext, input: ProposeInput): { proposal: ProposalOut; warnings?: string[] } {
  const path = normalizePath(input.path);
  const body = textBody(normalizeText(input.content));
  checkBypassFlag(ctx);
  return tx(ctx, () => {
    const target = requireWriteTarget(ctx, input.space, path, 'propose');
    checkSize(body.size, maxDocBytes(ctx, target.space));
    const existing = target.existing;
    const override = scanSecrets(ctx, { path: target.path, message: input.message, content: body.text, previous: headText(ctx, existing) });
    if (!existing) {
      if (input.baseRev !== undefined && input.baseRev > 0) throw conflict('not_found_at_rev');
    } else {
      const access: DocAccess = { space: target.space, doc: existing, role: target.role };
      if (input.baseRev === 0) throw conflictAt(ctx, access, 'already_exists', undefined, path);
      checkExpected(ctx, access, input.baseRev);
      if (existing.kind !== 'text') throw new OpError('unsupported', { reason: 'not_text' });
    }
    const r = proposeInTx(ctx, {
      space: target.space,
      path: existing ? existing.path : target.path,
      existing,
      body,
      message: input.message,
      warnings: parseText(body.text, path).warnings,
      ...(override ? { auditDetail: override } : {}),
    });
    if (r.status !== 'proposed') throw new Error('unreachable');
    return { proposal: r.proposal, ...(r.warnings ? { warnings: r.warnings } : {}) };
  });
}

/**
 * Accepting a proposal inside a transaction: an ordinary revision through
 * applyRevision on behalf of the proposal's author, `approved_by` is the decider. The head must equal
 * `base_rev`, or the accepter passes `expected_rev` equal to the head they saw
 * (then the proposal text goes on top of it). Permissions and status are checked by the caller.
 */
export function acceptProposalInTx(ctx: WriteContext, a: ProposalAccess, expectedRev: number | undefined, note: string | null): DocumentView | undefined {
  const p = a.proposal;
  const text = readTextBlob(ctx.core, p.content_hash);
  if (text === undefined) throw new Error('proposal body is missing');
  const body = textBody(text);
  const author: RevisionAuthor = { id: p.author_id, name: p.author_name, kind: p.author_kind, trust: p.author_trust };
  const detail = { proposal_id: p.id, ...(note ? { note: true } : {}) };
  let existing: DocumentView | undefined;
  if (!a.doc) {
    const taken = requirePathIn(ctx, a.space, a.path, 'none').existing;
    if (taken) throw pathConflict('path_taken', a.path, taken);
  } else {
    if (a.doc.deleted_at !== null) throw conflict('deleted');
    const access: DocAccess = { space: a.space, doc: a.doc, role: a.role };
    if (expectedRev !== undefined) checkExpected(ctx, access, expectedRev);
    else if (a.doc.head_rev !== p.base_rev) throw conflictAt(ctx, access, 'stale_proposal', p.base_rev);
    if (a.doc.content_hash === body.hash) {
      audit(ctx, { space_id: a.space.id, doc_id: a.doc.id, rev: a.doc.head_rev }, { ...detail, unchanged: true });
      return undefined;
    }
    existing = a.doc;
  }
  checkSize(body.size, maxDocBytes(ctx, a.space));
  return applyRevision(ctx, {
    space: a.space,
    existing,
    kind: existing ? 'update' : 'create',
    path: existing ? existing.path : a.path,
    body,
    message: p.message,
    expiresAt: existing ? renewedExpiry(ctx, a.space, existing) : expiresFor(ctx, a.space, undefined),
    author,
    approvedBy: ctx.principal.id,
    proposalId: p.id,
    auditDetail: detail,
  });
}

/** Write transaction for core modules that change documents through this module. */
export function inWriteTx<T>(ctx: AccessContext, fn: () => T): T {
  return tx(ctx, fn);
}

/** Body text by hash (for a proposal diff). */
export function bodyText(ctx: AccessContext, hash: string): string | undefined {
  return readTextBlob(ctx.core, hash);
}

export { auditWrite };

function auditWrite(ctx: WriteContext, where: { space_id: string; doc_id: string | null; rev: number | null }, detail?: Record<string, unknown>): void {
  audit(ctx, where, detail);
}

// --- TTL ---------------------------------------------------------------------------------------------

/**
 * An `expire` revision (soft delete) for a document whose `expires_at` has passed; on behalf of `system`
 * (janitor). The expiry check is repeated inside the transaction: the document may have been updated or deleted.
 */
export function expireDocument(ctx: WriteContext, docId: string): boolean {
  return tx(ctx, () => {
    const doc = reloadDoc(ctx, docId);
    const now = ctx.core.now();
    if (doc.deleted_at !== null || doc.expires_at === null || doc.expires_at >= now) return false;
    const space = ctx.snapshot.spaceById.get(doc.space_id);
    if (!space) return false;
    const msg = getMessage(ctx.core.db, doc.id);
    if (isAgentCard(space, doc.path) || (msg && isInboxSpace(space) && !isResolved(statusOf(msg)))) {
      // Pending handoff messages do not expire either.
      // Agent cards do not expire: clear the lifetime so the janitor no longer selects them.
      updateDocument(ctx.core.db, doc.id, { expires_at: null });
      return false;
    }
    applyRevision(ctx, {
      space,
      existing: doc,
      kind: 'expire',
      path: doc.path,
      message: 'TTL expired',
      deleted: 'set',
    });
    return true;
  });
}
