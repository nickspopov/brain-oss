// export: a tar.gz archive of a space with a download link.
import { z } from 'zod';
import { createExport } from '../../core/export/export.js';
import { defineOp } from '../define.js';
import { SlugSchema } from '../types.js';

const AtSchema = z
  .string()
  .max(64)
  .refine((v) => Number.isFinite(Date.parse(v)), 'Expected an ISO 8601 time.');

export const exportOp = defineOp({
  name: 'export',
  summary: 'Export a space as a tar.gz archive (a plain Markdown tree plus manifest) and get a download link.',
  description:
    'Builds an archive of the space and returns download_path (GET it with the same token within an hour; only you ' +
    'can download it). mode "head" (default, needs read) has the live documents you can read, as a plain tree under ' +
    'brain-export/tree/, and manifest.json with metadata. mode "full" (needs admin on the space) adds every revision, ' +
    'deleted documents and all bodies by sha256 under brain-export/blobs/: it can be imported on another server. ' +
    'Documents you cannot read are never included. at fixes the export time (ISO 8601); it must not be earlier than ' +
    'the latest revision: exports of past states are not supported. If your access to anything inside changes before ' +
    'the download, the link answers not_found: export again.',
  input: z
    .object({
      space: SlugSchema,
      mode: z.enum(['head', 'full']).optional(),
      at: AtSchema.optional(),
    })
    .strict(),
  output: z.object({
    export_id: z.string(),
    download_path: z.string(),
    size: z.number().int(),
    sha256: z.string(),
    expires_at: z.string(),
  }),
  effect: 'read',
  requires: 'any',
  expose: ['mcp', 'mcpl', 'rest'],
  featureSet: 'brain.read',
  idempotent: false,
  handler: (ctx, input) =>
    createExport(ctx, { space: input.space, mode: input.mode ?? 'head', at: input.at === undefined ? undefined : Date.parse(input.at) }),
  render: (o) => `Export ready: GET ${o.download_path} (${o.size} bytes, sha256 ${o.sha256}), valid until ${o.expires_at}.`,
  auditDetail: (input, o) => ({ space: input.space, mode: input.mode ?? 'head', size: o.size }),
  isolation: {
    kind: 'inputs',
    build: (hidden) => ({
      addressed: [
        { input: { space: hidden.space }, missing: { space: 'no-such-space' } },
        { input: { space: hidden.space, mode: 'full' }, missing: { space: 'no-such-space', mode: 'full' } },
      ],
      broad: [],
    }),
  },
});
