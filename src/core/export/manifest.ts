// Export archive format: `brain-export/manifest.json`, `tree/<path>`, `blobs/<sha256>`.
// The format is part of the portability contract: fields are only ever added.
import { z } from 'zod';

export const ARCHIVE_ROOT = 'brain-export';
export const FORMAT = 'brain-export';
export const FORMAT_VERSION = 1;

const Trust = z.enum(['admin', 'trusted', 'limited']);
const Kind = z.enum(['human', 'agent', 'system']);
const Iso = z.iso.datetime({ offset: false });
const Hash = z.string().regex(/^[0-9a-f]{64}$/);

export const ManifestRevisionSchema = z.object({
  rev: z.number().int().min(1),
  kind: z.enum(['create', 'update', 'move', 'delete', 'restore', 'revert', 'undo', 'expire', 'import']),
  /** Empty string: the location is hidden from the exporter. */
  path: z.string().max(1024),
  prev_path: z.string().max(1024).nullable(),
  author: z.string().min(1).max(63),
  author_trust: Trust,
  approved_by: z.string().min(1).max(63).nullable(),
  via: z.enum(['mcp', 'mcpl', 'rest', 'ui', 'cli', 'import', 'system']),
  message: z.string().max(500),
  created_at: Iso,
  content_hash: Hash,
  size: z.number().int().min(0),
  ref_rev: z.number().int().min(1).nullable(),
  purged: z.boolean(),
  attention: z.boolean().default(false),
});

/** Handoff message envelope: principals by name, revisions of this document. */
export const ManifestMessageSchema = z.object({
  from: z.string().min(1).max(63),
  to: z.string().min(1).max(63),
  thread_id: z.string().max(64),
  reply_to: z.string().max(64).nullable(),
  created_at: Iso,
  content_rev: z.number().int().min(1),
  changed_at: Iso,
  received_rev: z.number().int().min(1).nullable(),
  received_at: Iso.nullable(),
  resolution: z.enum(['done', 'declined']).nullable(),
  resolved_rev: z.number().int().min(1).nullable(),
  resolved_at: Iso.nullable(),
  resolved_by: z.string().min(1).max(63).nullable(),
  note: z.string().max(500).nullable(),
});

export const ManifestDocumentSchema = z.object({
  id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  path: z.string().min(1).max(1024),
  kind: z.enum(['text', 'file']),
  mime: z.string().min(1).max(255),
  head_rev: z.number().int().min(1),
  deleted: z.boolean(),
  revisions: z.array(ManifestRevisionSchema).min(1),
  handoff: ManifestMessageSchema.optional(),
});

export const ManifestSpaceSchema = z.object({
  slug: z.string().min(1).max(63),
  name: z.string().max(200),
  description: z.string().max(10_000),
  review_mode: z.enum(['off', 'limited', 'all']),
  executable: z.boolean(),
  /** Absent in older exports (then: slug `handoff`). */
  inbox: z.boolean().optional(),
  ttl_days: z.number().int().min(1).nullable(),
  trash_retention_days: z.number().int().min(1).nullable(),
  quota_bytes: z.number().int().min(1),
  max_doc_bytes: z.number().int().min(1).nullable(),
  protected_paths: z.array(z.string().max(1024)),
});

export const ManifestSchema = z.object({
  format: z.literal(FORMAT),
  format_version: z.literal(FORMAT_VERSION),
  contract_version: z.string(),
  exported_at: Iso,
  mode: z.enum(['head', 'full']),
  space: ManifestSpaceSchema,
  documents: z.array(ManifestDocumentSchema),
  // `external`: an imported placeholder of an external agent stays external.
  principals: z.array(z.object({ name: z.string().min(1).max(63), kind: Kind, trust: Trust, external: z.boolean().optional() })),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestDocument = z.infer<typeof ManifestDocumentSchema>;
export type ManifestRevision = z.infer<typeof ManifestRevisionSchema>;
export type ManifestMessage = z.infer<typeof ManifestMessageSchema>;

export const treeEntry = (path: string): string => `${ARCHIVE_ROOT}/tree/${path}`;
export const blobEntry = (hash: string): string => `${ARCHIVE_ROOT}/blobs/${hash}`;
export const MANIFEST_ENTRY = `${ARCHIVE_ROOT}/manifest.json`;
