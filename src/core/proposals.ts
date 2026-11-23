// Proposals: list, view, decision, withdrawal.
// Creation is in core/documents (write routing and the propose operation); acceptance is
// an ordinary revision through the same write path (acceptProposalInTx).
import { decideProposal, getProposalView, type ProposalStatus } from '../store/proposals.js';
import { openCursor, sealCursor } from './cursor.js';
import { acceptProposalInTx, auditWrite, bodyText, inWriteTx, type WriteContext } from './documents.js';
import { docInfo, type DocInfoOut } from './docview.js';
import { conflict, OpError } from './errors.js';
import {
  candidateSpaceIds,
  requireProposal,
  requireSpace,
  visibleProposals,
  type AccessContext,
  type ProposalAccess,
} from './guard.js';
import { proposalOut, type ProposalOut } from './proposalview.js';
import { scanText, secretDetected } from './secrets/scan.js';
import { boundedPatch } from './textdiff.js';

export interface ProposalListInput {
  space?: string | undefined;
  status?: ProposalStatus | undefined;
  mine?: boolean | undefined;
  cursor?: string | undefined;
  limit: number;
}

/** `proposal_list`: proposals visible to the caller, newest first. */
export function listProposals(ctx: AccessContext, input: ProposalListInput): { proposals: ProposalOut[]; next_cursor?: string } {
  const params = { space: input.space ?? null, status: input.status ?? null, mine: input.mine ?? false, limit: input.limit };
  const beforeOrd = input.cursor === undefined ? undefined : openCursor(ctx, 'proposals', input.cursor, params);
  const spaceIds = input.space !== undefined ? [requireSpace(ctx, input.space, 'read').space.id] : candidateSpaceIds(ctx);
  const page = visibleProposals(ctx, {
    spaceIds,
    status: input.status,
    authorId: input.mine ? ctx.principal.id : undefined,
    beforeOrd,
    limit: input.limit,
  });
  const proposals = page.items.map(proposalOut);
  return page.nextOrd !== undefined ? { proposals, next_cursor: sealCursor(ctx, 'proposals', page.nextOrd, params) } : { proposals };
}

/** Whether a proposal is stale relative to the current state of its target. */
function isStale(a: ProposalAccess): boolean {
  if (a.proposal.status !== 'open') return false;
  if (!a.doc) return false;
  return a.doc.deleted_at !== null || a.doc.head_rev !== a.proposal.base_rev;
}

export interface ProposalDetail {
  proposal: ProposalOut;
  content: string;
  /** Unified diff from the current head (for a new document, from empty) to the proposal text. */
  diff: string;
  /** Diff not computed: the proposal differs from the head by more than 1000 lines. */
  diff_truncated?: boolean;
  stale: boolean;
}

/** `proposal_get`: only with current `read` on the target. */
export function getProposal(ctx: AccessContext, id: string): ProposalDetail {
  const a = requireProposal(ctx, id, 'read');
  const content = bodyText(ctx, a.proposal.content_hash) ?? '';
  const head = a.doc && a.doc.deleted_at === null ? (bodyText(ctx, a.doc.content_hash) ?? '') : '';
  const fromRev = a.doc && a.doc.deleted_at === null ? a.doc.head_rev : 0;
  const diff = boundedPatch(a.path, fromRev, 'proposal', head, content);
  return {
    proposal: proposalOut(a),
    content,
    diff: diff ?? '',
    ...(diff === undefined ? { diff_truncated: true } : {}),
    stale: isStale(a),
  };
}

export interface DecideInput {
  id: string;
  decision: 'accept' | 'reject';
  note?: string | undefined;
  expectedRev?: number | undefined;
}

function reload(ctx: AccessContext, a: ProposalAccess): ProposalOut {
  const view = getProposalView(ctx.core.db, a.proposal.id);
  if (!view) throw new Error('proposal row is missing');
  return proposalOut({ ...a, proposal: view });
}

/**
 * `proposal_decide`: role `admin` on the target; an author does not accept their own; in an
 * executable space a proposal by an author with trust below admin can only be accepted by a human.
 */
export function decideProposalOp(ctx: WriteContext, input: DecideInput): { proposal: ProposalOut; doc?: DocInfoOut } {
  return inWriteTx(ctx, () => {
    const a = requireProposal(ctx, input.id, 'admin');
    const p = a.proposal;
    if (p.status !== 'open') throw conflict('not_open');
    const note = input.note ?? null;
    // The proposal's author sees the note: secret scanner, as for a revision message.
    if (note !== null) {
      const findings = scanText(note, 'message');
      if (findings.length > 0) throw secretDetected(findings);
    }
    const now = ctx.core.now();
    if (input.decision === 'reject') {
      decideProposal(ctx.core.db, p.id, { status: 'rejected', decided_by: ctx.principal.id, decided_at: now, decision_note: note, result_seq: null, doc_id: null });
      auditWrite(ctx, { space_id: a.space.id, doc_id: p.doc_id, rev: null }, { proposal_id: p.id, decision: 'reject' });
      return { proposal: reload(ctx, a) };
    }
    if (p.author_id === ctx.principal.id) throw new OpError('forbidden', { required_role: 'admin', reason: 'own_proposal' });
    if (a.space.executable === 1 && p.author_trust !== 'admin' && ctx.principal.kind !== 'human') {
      throw new OpError('forbidden', { required_role: 'admin', reason: 'human_required' });
    }
    const doc = acceptProposalInTx(ctx, a, input.expectedRev, note);
    const target = doc ?? a.doc;
    decideProposal(ctx.core.db, p.id, {
      status: 'accepted',
      decided_by: ctx.principal.id,
      decided_at: now,
      decision_note: note,
      result_seq: doc ? doc.head_seq : null,
      doc_id: doc ? doc.id : null,
    });
    const after = { ...a, ...(doc ? { doc, path: doc.path } : {}) };
    return { proposal: reload(ctx, after), ...(target ? { doc: docInfo(ctx, target) } : {}) };
  });
}

/** `proposal_withdraw`: only by the author and only while open. */
export function withdrawProposal(ctx: WriteContext, id: string): { proposal: ProposalOut } {
  return inWriteTx(ctx, () => {
    const a = requireProposal(ctx, id, 'read');
    const p = a.proposal;
    if (p.author_id !== ctx.principal.id) throw new OpError('forbidden', { required_role: 'admin', reason: 'not_author' });
    if (p.status !== 'open') throw conflict('not_open');
    decideProposal(ctx.core.db, p.id, { status: 'withdrawn', decided_by: ctx.principal.id, decided_at: ctx.core.now(), decision_note: null, result_seq: null, doc_id: null });
    auditWrite(ctx, { space_id: a.space.id, doc_id: p.doc_id, rev: null }, { proposal_id: p.id, decision: 'withdraw' });
    return { proposal: reload(ctx, a) };
  });
}

/** Repeat by request_id: the proposal from the response must still be visible. */
export function recheckProposal(ctx: AccessContext, id: string): void {
  requireProposal(ctx, id, 'read');
}
