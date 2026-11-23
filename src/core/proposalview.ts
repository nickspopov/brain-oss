// A proposal in contract form. The row comes from guard already checked.
import type { AuthorOut } from './docview.js';
import { iso } from './docview.js';
import type { ProposalAccess } from './guard.js';

export interface ProposalOut {
  id: string;
  space: string;
  path: string;
  /** None: a proposal for a new document (before acceptance). */
  doc_id?: string;
  base_rev: number;
  content_hash: string;
  size: number;
  message: string;
  author: AuthorOut;
  status: 'open' | 'accepted' | 'rejected' | 'withdrawn';
  created_at: string;
  decided_by?: AuthorOut;
  decided_at?: string;
  decision_note?: string;
  /** Document revision created by acceptance. */
  result_rev?: number;
  /** Executable space and the author is not admin: only a human can accept. */
  human_required: boolean;
}

export function proposalOut(a: ProposalAccess): ProposalOut {
  const p = a.proposal;
  return {
    id: p.id,
    space: a.space.slug,
    path: a.path,
    ...(p.doc_id !== null ? { doc_id: p.doc_id } : {}),
    base_rev: p.base_rev,
    content_hash: p.content_hash,
    size: p.size,
    message: p.message,
    author: { name: p.author_name, kind: p.author_kind, trust: p.author_trust },
    status: p.status,
    created_at: iso(p.created_at),
    ...(p.decider_name !== null && p.decider_kind !== null && p.decider_trust !== null
      ? { decided_by: { name: p.decider_name, kind: p.decider_kind, trust: p.decider_trust } }
      : {}),
    ...(p.decided_at !== null ? { decided_at: iso(p.decided_at) } : {}),
    ...(p.decision_note !== null ? { decision_note: p.decision_note } : {}),
    ...(p.result_rev !== null ? { result_rev: p.result_rev } : {}),
    human_required: a.space.executable === 1 && p.author_trust !== 'admin',
  };
}
