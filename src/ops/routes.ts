// Byte route operations: file upload, document body, export download,
// archive import. They are not described by a JSON schema, so they are not in the registry (contract, MCP, OpenAPI),
// but they go through the same execute pipeline: visibility, limit, validation, guard, audit, idempotency.
// The HTTP adapter (adapters/http/files.ts) only maps the request to input and the result to a response.
import { z } from 'zod';
import { writeDocument } from '../core/documents.js';
import { openExport } from '../core/export/export.js';
import { importArchive } from '../core/export/import.js';
import { rawBody } from '../core/revisions.js';
import { defineOp, type AnyOp, type IsolationSpec } from './define.js';
import { IdSchema, PathSchema, RequestIdSchema, SlugSchema } from './types.js';
import { recheckDocReplay, writeCtx, WriteResultSchema } from './agent/common.js';

const ROUTE_ISOLATION: IsolationSpec = {
  kind: 'not_applicable',
  reason: 'byte routes are checked by the explicit route list of the isolation test',
};

/** A number from the query string (`?rev=3`). */
const QueryInt = (min: number) =>
  z
    .string()
    .regex(/^\d{1,15}$/, 'Expected a non-negative integer.')
    .transform(Number)
    .pipe(z.number().int().min(min));

const QueryFlag = z
  .enum(['1', 'true', '0', 'false'])
  .transform((v) => v === '1' || v === 'true');

const BytesSchema = z.instanceof(Buffer);

export const docRawRoute = defineOp({
  name: 'doc_raw',
  summary: 'GET /api/v1/docs/{id}/raw?rev=: the body as is.',
  description: 'Body of the head or of revision rev, as an attachment.',
  input: z.object({ id: IdSchema, rev: QueryInt(1).optional() }).strict(),
  output: z.object({ doc_id: z.string(), bytes: BytesSchema, mime: z.string(), filename: z.string(), rev: z.number().int() }),
  effect: 'read',
  requires: 'any',
  expose: ['rest'],
  featureSet: 'brain.read',
  idempotent: false,
  handler: (ctx, input) => rawBody(ctx, input.id, input.rev),
  // The read audit row names the document (as for read).
  auditTarget: (o) => ({ doc_id: o.doc_id, rev: o.rev }),
  isolation: ROUTE_ISOLATION,
});

export const exportDownloadRoute = defineOp({
  name: 'export_download',
  summary: 'GET /api/v1/exports/{export_id}: the export archive.',
  description: 'Only for its creator, before expires_at, and only while every object inside is still readable.',
  input: z.object({ id: IdSchema }).strict(),
  output: z.object({ file: z.string(), size: z.number().int(), filename: z.string() }),
  effect: 'read',
  requires: 'any',
  expose: ['rest'],
  featureSet: 'brain.read',
  idempotent: false,
  handler: (ctx, input) => openExport(ctx, input.id),
  auditDetail: (input) => ({ export_id: input.id }),
  isolation: ROUTE_ISOLATION,
});

export const fileUploadRoute = defineOp({
  name: 'file_upload',
  summary: 'PUT /api/v1/files/{space}/{path…}: upload a file body.',
  description: 'The request body is the file; then the usual commit (expected_rev, quotas, secrets, audit).',
  input: z
    .object({
      space: SlugSchema,
      path: PathSchema,
      bytes: BytesSchema,
      expected_rev: QueryInt(0).optional(),
      message: z.string().max(500).optional(),
      request_id: RequestIdSchema.optional(),
    })
    .strict(),
  output: WriteResultSchema,
  effect: 'write',
  requires: 'any',
  expose: ['rest'],
  featureSet: 'brain.write',
  idempotent: true,
  handler: (ctx, input) =>
    writeDocument(writeCtx(ctx, 'file_upload', input.request_id), {
      space: input.space,
      path: input.path,
      bytes: input.bytes,
      expectedRev: input.expected_rev,
      message: input.message || 'upload',
    }),
  replayCheck: recheckDocReplay,
  isolation: ROUTE_ISOLATION,
});

export const importRoute = defineOp({
  name: 'import',
  summary: 'POST /api/v1/import?space=&mode=: import an export archive into a new space.',
  description: 'Superadmin only.',
  input: z
    .object({
      space: SlugSchema,
      mode: z.enum(['restore', 'as-new']),
      archive: BytesSchema,
      confirm_secrets: QueryFlag.optional(),
    })
    .strict(),
  output: z.object({
    space: z.string(),
    mode: z.enum(['restore', 'as-new']),
    documents: z.number().int(),
    revisions: z.number().int(),
    principals_created: z.array(z.string()),
    secrets_confirmed: z.number().int().optional(),
  }),
  effect: 'admin',
  requires: 'superadmin',
  expose: ['rest'],
  featureSet: 'brain.admin',
  idempotent: false,
  handler: (ctx, input) =>
    importArchive(ctx, { archive: input.archive, space: input.space, mode: input.mode, confirmSecrets: input.confirm_secrets }),
  auditDetail: (input, o) => ({ space: input.space, mode: input.mode, documents: o.documents, revisions: o.revisions }),
  isolation: ROUTE_ISOLATION,
});

const ROUTES = new Map<string, AnyOp>(
  ([docRawRoute, exportDownloadRoute, fileUploadRoute, importRoute] as unknown as AnyOp[]).map((op) => [op.name, op]),
);

export function getRouteOp(name: string): AnyOp | undefined {
  return ROUTES.get(name);
}

export function listRouteOps(): AnyOp[] {
  return [...ROUTES.values()];
}
