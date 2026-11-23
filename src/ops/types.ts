// Shared types of the v1 contract. zod schemas give validation, TS types and JSON Schema.
import { z } from 'zod';

export { CONTRACT_VERSION } from '../version.js';

export const TrustSchema = z.enum(['admin', 'trusted', 'limited']);
export const PrincipalKindSchema = z.enum(['human', 'agent', 'system']);
export const RoleSchema = z.enum(['none', 'guest', 'read', 'propose', 'write', 'admin']);
export const ViaSchema = z.enum(['mcp', 'mcpl', 'rest', 'ui', 'cli', 'import', 'system']);

/** Time on the wire is an ISO 8601 UTC string. */
export const IsoTime = z.string();
export const toIso = (ms: number): string => new Date(ms).toISOString();

/** Opaque cursor (encrypted with the server key, core/cursor.ts). */
export const CursorSchema = z.string().min(1).max(2048);

export const SlugSchema = z.string().min(1).max(63);
export const PathSchema = z.string().min(1).max(1024);
export const IdSchema = z.string().min(1).max(64);
export const RequestIdSchema = z.string().min(8).max(128);
export const MessageSchema = z.string().max(500);

export const AuthorSchema = z.object({
  name: z.string(),
  kind: PrincipalKindSchema,
  trust: TrustSchema,
});
export type Author = z.infer<typeof AuthorSchema>;

/** `{ id }` or `{ space, path }`. */
export const DocRefShape = {
  id: IdSchema.optional(),
  space: SlugSchema.optional(),
  path: PathSchema.optional(),
};

export const DocInfoSchema = z.object({
  id: z.string(),
  space: z.string(),
  path: z.string(),
  kind: z.enum(['text', 'file']),
  mime: z.string(),
  title: z.string(),
  rev: z.number().int(),
  content_hash: z.string(),
  size: z.number().int(),
  updated_at: IsoTime,
  author: AuthorSchema,
  approved_by: AuthorSchema.optional(),
  trust_floor: TrustSchema,
  deleted: z.boolean(),
  expires_at: IsoTime.optional(),
  tags: z.array(z.string()).optional(),
});
export type DocInfo = z.infer<typeof DocInfoSchema>;

export const RevInfoSchema = z.object({
  rev: z.number().int(),
  kind: z.enum(['create', 'update', 'move', 'delete', 'restore', 'revert', 'undo', 'expire', 'import']),
  author: AuthorSchema,
  approved_by: AuthorSchema.optional(),
  via: ViaSchema,
  message: z.string(),
  created_at: IsoTime,
  size: z.number().int(),
  content_hash: z.string(),
  path: z.string().optional(),
  prev_path: z.string().optional(),
  ref_rev: z.number().int().optional(),
  purged: z.boolean(),
  attention: z.boolean(),
});
export type RevInfo = z.infer<typeof RevInfoSchema>;

export const ProposalSchema = z.object({
  id: z.string(),
  space: z.string(),
  path: z.string(),
  doc_id: z.string().optional(),
  base_rev: z.number().int(),
  content_hash: z.string(),
  size: z.number().int(),
  message: z.string(),
  author: AuthorSchema,
  status: z.enum(['open', 'accepted', 'rejected', 'withdrawn']),
  created_at: IsoTime,
  decided_by: AuthorSchema.optional(),
  decided_at: IsoTime.optional(),
  decision_note: z.string().optional(),
  result_rev: z.number().int().optional(),
  human_required: z.boolean(),
});
export type Proposal = z.infer<typeof ProposalSchema>;
