// Shared schemas and helpers for document operations.
import { z } from 'zod';
import type { WriteContext } from '../../core/documents.js';
import { requireDoc } from '../../core/guard.js';
import { recheckProposal } from '../../core/proposals.js';
import type { IsolationTarget, OpContext } from '../define.js';
import { DocInfoSchema, DocRefShape, MessageSchema, ProposalSchema, RequestIdSchema } from '../types.js';

/** A surely non-existent id for the "empty" inputs of the isolation test. */
export const MISSING_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
export const MISSING_PATH = 'no-such-folder/no-such-doc.md';

export const RevNumber = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const ExpectedRev = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Input referencing a document: `{ id }` or `{ space, path }`. */
export const docRef = DocRefShape;

/** Common fields of mutating operations. */
export const writeMeta = {
  request_id: RequestIdSchema.optional(),
};
export const requiredMessage = MessageSchema.min(1);

export const WriteResultSchema = z.object({
  status: z.enum(['committed', 'proposed']),
  doc: DocInfoSchema.optional(),
  unchanged: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
  /** `status: "proposed"`: the write became a proposal. */
  proposal: ProposalSchema.optional(),
});

export const DocResultSchema = z.object({ doc: DocInfoSchema });

export function refOf(input: { id?: string | undefined; space?: string | undefined; path?: string | undefined }) {
  return { id: input.id, space: input.space, path: input.path };
}

/** Write context from the operation context: author and channel come from the server, not from input. */
export function writeCtx(ctx: OpContext, op: string, requestId: string | undefined, allowSecret?: boolean): WriteContext {
  return {
    ...ctx,
    via: ctx.caller.via,
    tokenId: ctx.caller.tokenId ?? null,
    ip: ctx.caller.ip,
    op,
    requestId: requestId ?? null,
    ...(allowSecret ? { allowSecret: true } : {}),
  };
}

/** Flag to bypass the secret scanner: superadmin from the UI only; for agents — invalid_input. */
export const allowSecretField = {
  allow_secret: z.boolean().optional(),
};

/**
  * Before returning a saved response, access is checked again:
  * the document in the response must still be visible to the caller.
 */
export function recheckDocReplay(ctx: OpContext, output: unknown): void {
  const out = output as { doc?: { id?: unknown }; proposal?: { id?: unknown } } | null;
  const id = out?.doc?.id;
  if (typeof id === 'string') requireDoc(ctx, { id }, 'read', { includeDeleted: true });
  const pid = out?.proposal?.id;
  if (typeof pid === 'string') recheckProposal(ctx, pid);
}

/** Text of a write response for the LLM (MCP `content`). */
export function renderWrite(verb: string, o: { status: string; doc?: { space: string; path: string; rev: number; id: string } | undefined; unchanged?: boolean | undefined; warnings?: string[] | undefined; proposal?: { id: string; space: string; path: string } | undefined }): string {
  const warn = o.warnings?.length ? `\nWarnings: ${o.warnings.join(', ')}` : '';
  if (o.status === 'proposed' && o.proposal) {
    return `Proposed (review required): proposal ${o.proposal.id} for ${o.proposal.space}/${o.proposal.path}. It is applied when a space admin accepts it.${warn}`;
  }
  if (o.doc) return `${o.unchanged ? 'Unchanged' : verb}: ${o.doc.space}/${o.doc.path} rev ${o.doc.rev} (id ${o.doc.id})${warn}`;
  return `Status: ${o.status}`;
}

/** Addressed inputs on hidden documents (by id and by path) for the isolation test. */
export function addressedDocRefs(hidden: IsolationTarget, extra: Record<string, unknown> = {}) {
  return [
    ...hidden.docIds.map((id) => ({ input: { id, ...extra }, missing: { id: MISSING_ID, ...extra } })),
    ...hidden.paths.map((path) => ({
      input: { space: hidden.space, path, ...extra },
      missing: { space: hidden.space, path: MISSING_PATH, ...extra },
    })),
  ];
}
