// Table rows as SQLite returns them. Data only, no permission logic.
export type Kind = 'human' | 'agent' | 'system';
export type Trust = 'admin' | 'trusted' | 'limited';
export type PrincipalRole = 'superadmin' | 'member';
export type Role = 'none' | 'guest' | 'read' | 'propose' | 'write' | 'admin';

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  created_at: number;
  /** Owner-edited start_here guide; NULL — the built-in default. */
  guide_text?: string | null;
}

export interface PrincipalRow {
  id: string;
  tenant_id: string;
  name: string;
  display_name: string;
  kind: Kind;
  role: PrincipalRole;
  trust: Trust;
  owner_id: string | null;
  harness: string | null;
  password_hash: string | null;
  start_seq: number;
  disabled_at: number | null;
  /** Capability `admin`: admin_* operations for any kind. */
  can_admin: 0 | 1;
  /** External principal: another person's agent; `owner_label` names that person. */
  external: 0 | 1;
  owner_label: string | null;
  /** JSON of per-principal limits (core/external.ts); null = defaults. */
  limits: string | null;
  /** Profile: the one-line "what I do", how to reach it / response times. */
  what_i_do?: string | null;
  contact_notes?: string | null;
  profile_updated_at?: number | null;
  created_at: number;
  created_by: string | null;
}

export interface TokenRow {
  id: string;
  principal_id: string;
  hash: string;
  prefix: string;
  label: string;
  created_at: number;
  created_by: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  revoked_by: string | null;
  last_used_at: number | null;
  last_used_ip: string | null;
}

export interface SpaceRow {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string;
  review_mode: 'off' | 'limited' | 'all';
  executable: 0 | 1;
  /** Inbox space: messages under `<slug>/<name>/`, agent cards `_agents/`. */
  inbox: 0 | 1;
  ttl_days: number | null;
  trash_retention_days: number | null;
  quota_bytes: number;
  max_doc_bytes: number | null;
  protected_paths: string;
  bytes_used: number;
  archived_at: number | null;
  archived_by: string | null;
  created_at: number;
  created_by: string | null;
  /**
   * The canonical space this row is an alias of (an inbox space re-homed by
   * `brain migrate-spaces`). Alias rows are never listed; their slug and id resolve to the canonical row.
   */
  alias_of?: string | null;
}

export interface GroupRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  system: 0 | 1;
  created_at: number;
  created_by: string | null;
}

export interface GrantRow {
  id: string;
  space_id: string;
  scope: 'space' | 'path' | 'doc';
  path_prefix: string | null;
  doc_id: string | null;
  subject_type: 'principal' | 'group';
  subject_id: string;
  role: Role;
  granted_by: string | null;
  granted_at: number;
}

export interface AuditInsert {
  ts: number;
  principal_id: string | null;
  token_id: string | null;
  via: string;
  op: string;
  outcome: string;
  space_id?: string | null;
  doc_id?: string | null;
  rev?: number | null;
  request_id?: string | null;
  ip?: string | null;
  detail?: string | null;
}

export interface SessionRow {
  id_hash: string;
  principal_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  user_agent: string | null;
}

export interface IdempotencyRow {
  principal_id: string;
  request_id: string;
  op: string;
  input_hash: string;
  response: string;
  created_at: number;
}

export interface GroupMemberRow {
  group_id: string;
  principal_id: string;
  added_by: string | null;
  added_at: number;
}
