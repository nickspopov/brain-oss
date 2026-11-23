// admin_audit_query: the audit log for investigations, admin capability only.
import { z } from 'zod';
import { auditQuery } from '../../core/audit.js';
import { invalidInput } from '../../core/errors.js';
import { defineOp } from '../define.js';
import { CursorSchema, IdSchema, IsoTime, SlugSchema, toIso } from '../types.js';
import { ADMIN, ADMIN_ISOLATION, NameSchema } from './common.js';

const AuditEntrySchema = z.object({
  id: z.number().int(),
  ts: IsoTime,
  principal: z.string().nullable(),
  token_id: z.string().nullable(),
  via: z.string(),
  op: z.string(),
  outcome: z.string(),
  space: z.string().nullable(),
  doc_id: z.string().nullable(),
  rev: z.number().int().nullable(),
  request_id: z.string().nullable(),
  ip: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
});

function timeOf(v: string | undefined, field: string): number | undefined {
  if (v === undefined) return undefined;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw invalidInput(field, 'Expected an ISO 8601 time.');
  return ms;
}

export const adminAuditQueryOp = defineOp({
  name: 'admin_audit_query',
  summary: 'Query the audit log: one row per call, including reads and refusals (admin).',
  description:
    'Returns audit rows newest first: who (principal, token), when, via which adapter, which operation, the outcome ' +
    '("ok" or the error code), the space/document/revision touched, request_id, IP and a small detail (for search: ' +
    'the query and the number of results). Failed authentications have no principal. Document contents and tokens ' +
    'are never in the audit. Filters: principal (name), op, outcome, space (slug), doc_id, since/until (ISO time). ' +
    'Paginate with cursor (next_cursor).',
  input: z
    .object({
      principal: NameSchema.optional(),
      op: z.string().min(1).max(64).optional(),
      outcome: z.string().min(1).max(64).optional(),
      space: SlugSchema.optional(),
      doc_id: IdSchema.optional(),
      since: z.string().max(64).optional(),
      until: z.string().max(64).optional(),
      cursor: CursorSchema.optional(),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
  output: z.object({ entries: z.array(AuditEntrySchema), next_cursor: z.string().optional() }),
  ...ADMIN,
  idempotent: false,
  handler: (ctx, i) => {
    const r = auditQuery(ctx, {
      principal: i.principal,
      op: i.op,
      outcome: i.outcome,
      space: i.space,
      docId: i.doc_id,
      since: timeOf(i.since, 'since'),
      until: timeOf(i.until, 'until'),
      cursor: i.cursor,
      limit: i.limit ?? 100,
    });
    return { ...r, entries: r.entries.map((e) => ({ ...e, ts: toIso(e.ts) })) };
  },
  render: (o) =>
    o.entries
      .map((e) => `${e.ts} ${e.principal ?? '-'} ${e.via} ${e.op} ${e.outcome}${e.space ? ` ${e.space}` : ''}${e.doc_id ? ` ${e.doc_id}` : ''}`)
      .join('\n') + (o.next_cursor ? `\nMore: cursor ${o.next_cursor}` : ''),
  isolation: ADMIN_ISOLATION,
});
