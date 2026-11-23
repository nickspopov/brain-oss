// v1 contract types. Shared ones come only from ops/types (web/ imports only types from there);
// outputs of specific operations are described here (the fields the UI uses).
import type { Author, DocInfo, Proposal, RevInfo } from '../../../src/ops/types';

export type { Author, DocInfo, Proposal, RevInfo };
export type Trust = Author['trust'];
export type Role = 'none' | 'guest' | 'read' | 'propose' | 'write' | 'admin';

export interface SessionPrincipal {
  name: string;
  kind: Author['kind'];
  trust: Trust;
  role: string;
  admin: boolean;
}

export interface SpaceInfo {
  slug: string;
  name: string;
  description: string;
  role: Role;
  review_mode: 'off' | 'limited' | 'all';
  executable: boolean;
  inbox?: boolean;
  ttl_days?: number;
  protected_paths: string[];
  agents_md?: { rev: number; content: string; truncated: boolean };
  /** Only superadmins see archived spaces; hidden by default in the UI. */
  archived?: true;
}

export type ListEntry = { type: 'folder'; path: string; children: number } | ({ type: 'doc' } & DocInfo);

export interface ListOut {
  entries: ListEntry[];
  next_cursor?: string;
}

export interface ReadOut {
  doc: DocInfo;
  revision: RevInfo;
  content?: string;
  encoding: 'utf8' | 'base64';
  truncated: boolean;
  next_offset?: number;
}

export interface Snippet {
  text: string;
  /** [start, end) in UTF-16 positions of snippet.text. */
  highlights: [number, number][];
}

export interface SearchHit {
  doc: DocInfo;
  snippet: Snippet;
  matched_in: string[];
}

export interface SearchOut {
  results: SearchHit[];
  next_cursor?: string;
}

export interface WhoamiOut {
  contract_version: string;
  server_version: string;
  principal: { id: string; name: string; kind: Author['kind']; trust: Trust };
  capabilities?: string[];
  spaces: { slug: string; name: string; role: Role }[];
}

/** Output of `write`, `revert`, file upload: a commit or a proposal. */
export interface WriteOut {
  status: 'committed' | 'proposed';
  doc?: DocInfo;
  unchanged?: boolean;
  warnings?: string[];
  proposal?: Proposal;
}

export interface HistoryOut {
  revisions: RevInfo[];
  next_cursor?: string;
}

export interface DiffOut {
  from: number;
  to: number;
  diff?: string;
  added: number;
  removed: number;
  truncated: boolean;
}

/** `details.current` of a `conflict` error. */
export interface ConflictCurrent {
  rev: number;
  content_hash: string;
  author: Author;
  updated_at: string;
  content?: string;
  content_truncated?: boolean;
}

/** Envelope error. */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

// ---------------------------------------------------------------- administration
// admin_* shapes are described here from their schemas (web/ imports nothing but ops/types).

export type ReviewMode = 'off' | 'limited' | 'all';

export interface AdminSpace {
  id: string;
  slug: string;
  name: string;
  description: string;
  review_mode: ReviewMode;
  executable: boolean;
  inbox: boolean;
  ttl_days: number | null;
  trash_retention_days: number | null;
  quota_bytes: number;
  max_doc_bytes: number | null;
  protected_paths: string[];
  bytes_used: number;
  archived: boolean;
  archived_at: string | null;
  created_at: string;
}

/** Mutable space settings (`admin_space_create | update`). */
export interface SpaceSettingsInput {
  name?: string;
  description?: string;
  review_mode?: ReviewMode;
  executable?: boolean;
  inbox?: boolean;
  ttl_days?: number | null;
  trash_retention_days?: number | null;
  quota_bytes?: number;
  max_doc_bytes?: number | null;
  protected_paths?: string[];
}

export interface AdminPrincipal {
  id: string;
  name: string;
  display_name: string;
  kind: 'human' | 'agent' | 'system';
  role: 'superadmin' | 'member';
  trust: Trust;
  /** The `admin` capability. */
  admin: boolean;
  owner: string | null;
  harness: string | null;
  disabled: boolean;
  disabled_at: string | null;
  created_at: string;
  /** External agent (another person's); null for everyone else. */
  external?: { owner_label: string | null; limits: ExternalLimits; sent_today: number } | null;
  /** Profile fields and the last time it used Brain. */
  what_i_do?: string | null;
  contact?: string | null;
  last_seen?: string | null;
}

/** The role ladder (a name for the engine's space-level role). */
export type Ladder = 'none' | 'guest' | 'viewer' | 'proposer' | 'editor' | 'admin';

/** Ladder access of one principal in one space (admin_space_members, admin_access_explain). */
export interface MemberAccess {
  role: Ladder;
  engine_role: Role;
  messages_only: boolean;
  external_as_guest: boolean;
  superadmin: boolean;
  personal: Role | null;
  groups: { name: string; role: Role }[];
  overrides: AdminGrant[];
  custom: boolean;
  visible: boolean;
  member: boolean;
}

export interface SpaceMember {
  name: string;
  display_name: string;
  kind: 'human' | 'agent' | 'system';
  external: boolean;
  disabled: boolean;
  what_i_do: string | null;
  access: MemberAccess;
}

export interface SpaceMembersOut {
  space: AdminSpace;
  members: SpaceMember[];
  can_see: number;
  candidates: { type: 'principal' | 'group'; name: string; display_name: string; kind: 'human' | 'agent' | 'group'; external: boolean }[];
  notify: { people: string[]; webhooks: number };
}

export interface LegacyCard {
  space: string;
  path: string;
  doc_id: string;
  rev: number;
  what_i_do: string | null;
  contact: string | null;
  response_times: string | null;
}

export interface AdminProfileOut {
  profile: {
    name: string;
    display_name: string;
    kind: 'human' | 'agent' | 'system';
    what_i_do: string | null;
    contact: string | null;
    manager: string | null;
    external: boolean;
    active_today: boolean;
    harness: string | null;
    last_seen: string | null;
    updated_at: string | null;
    disabled: boolean;
  };
  cards: LegacyCard[];
  conflict: boolean;
}

/** Per-principal limits of an external agent; null = no limit. */
export interface ExternalLimits {
  msgs_per_day: number | null;
  body_bytes: number | null;
  pending_per_recipient: number | null;
  token_days: number | null;
}

export interface AdminToken {
  id: string;
  principal: string;
  prefix: string;
  label: string;
  created_at: string;
  expires_at: string | null;
  revoked: boolean;
  revoked_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
}

export interface AdminGroup {
  id: string;
  name: string;
  description: string;
  system: boolean;
  members: string[];
}

export type Scope = 'space' | 'path' | 'doc';
export interface Subject {
  type: 'principal' | 'group';
  name: string;
}

export interface AdminGrant {
  id: string;
  space: string;
  scope: Scope;
  path_prefix: string | null;
  doc_id: string | null;
  subject: Subject;
  role: Role;
  granted_by: string | null;
  granted_at: string;
}

/** Target of a grant (`admin_grant_set | remove`). */
export interface GrantKey {
  space: string;
  scope: Scope;
  path_prefix?: string;
  doc_id?: string;
  subject: Subject;
}

export type AccessLevel = 'disabled' | 'archived' | 'superadmin' | 'doc' | 'path' | 'space' | 'none' | 'mail';

/** Harnesses of `admin_connect_guide`. */
export const CONNECT_HARNESSES = ['claude-code', 'codex', 'connectome', 'hermes', 'letta', 'generic', 'script'] as const;
export type ConnectHarness = (typeof CONNECT_HARNESSES)[number];

/** Output of `admin_connect_guide`: it never contains a token (`admin_token_issue` issues that). */
/** `admin_settings_get` / `admin_settings_update`. */
export interface AdminSettings {
  guide_text: string;
  guide_text_is_default: boolean;
  guide_text_default: string;
  guide_text_max: number;
}

export interface ConnectGuideOut {
  harness: ConnectHarness;
  transport: 'http' | 'stdio';
  mcp_url: string;
  server_url: string;
  principal?: { name: string; kind: 'human' | 'agent' | 'system'; trust: Trust; disabled: boolean; spaces: { slug: string; role: string }[] };
  config: string;
  text: string;
  docs: string;
}

/** `admin_agent_connect`: the bundle is shown once and is never put in a query cache. */
export interface ConnectBundle {
  harness: ConnectHarness;
  transport: 'http' | 'stdio';
  server_url: string;
  mcp_url: string;
  where: string;
  config: string;
  sentence: string;
  text: string;
  filename: string;
}

export interface AgentConnectOut {
  principal: AdminPrincipal;
  token: string;
  info: AdminToken;
  spaces: { slug: string; role: Role }[];
  bundle: ConnectBundle;
}

/** `admin_agent_connection`: the live check. No token in it. */
export interface AgentConnectionOut {
  principal: string;
  token: { id: string; prefix: string; revoked: boolean; expired: boolean };
  connected: boolean;
  last_contact_at: string | null;
  sees: { space: string; name: string; role: Ladder; messages_only: boolean; via: string[] }[];
  not_sees: {
    count: number;
    probes: { space: string; name: string; canary: boolean; list: string; read: string; confirmed: boolean }[];
    all_confirmed: boolean;
  } | null;
}

export interface AccessExplainOut {
  principal: AdminPrincipal;
  groups: string[];
  spaces: {
    space: string;
    archived: boolean;
    visible: boolean;
    role: Role;
    target?: { path?: string; doc_id?: string; role: Role; level: AccessLevel; decided_by: AdminGrant[] };
    grants: AdminGrant[];
    member?: MemberAccess;
  }[];
}

// ---------------------------------------------------------------- feed, proposals, export, audit

/** An `activity` and `changes` item: a revision with the document's address. */
export type ChangeItem = RevInfo & { doc: { id: string; space: string; path: string; title: string } };

export interface ActivityOut {
  items: ChangeItem[];
  next_cursor?: string;
}

export interface ProposalListOut {
  proposals: Proposal[];
  next_cursor?: string;
}

/** `proposal_get`: full text, diff from the current head (or from empty) and `stale`. */
export interface ProposalGetOut {
  proposal: Proposal;
  content: string;
  diff: string;
  /** Diff not computed: more than 1000 lines of differences; `diff` is empty then. */
  diff_truncated?: boolean;
  stale: boolean;
}

export interface ExportOut {
  export_id: string;
  download_path: string;
  size: number;
  sha256: string;
  expires_at: string;
}

export interface AuditEntry {
  id: number;
  ts: string;
  principal: string | null;
  token_id: string | null;
  via: string;
  op: string;
  outcome: string;
  space: string | null;
  doc_id: string | null;
  rev: number | null;
  request_id: string | null;
  ip: string | null;
  detail: Record<string, unknown> | null;
}

export interface AuditFilter {
  principal?: string;
  op?: string;
  outcome?: string;
  space?: string;
  doc_id?: string;
  since?: string;
  until?: string;
}

/** `handoff_recipients`: whom the caller can message, and in which of its inbox spaces. */
export interface HandoffRecipient {
  name: string;
  display_name: string;
  external: boolean;
  /** The managing person in Brain. */
  manager: string | null;
  /** The outside person of an external agent. */
  owner_label: string | null;
  spaces: string[];
  /** The recipient's profile line. */
  what_i_do?: string | null;
}

/** Handoff message: status derived on the server. */
export type HandoffStatus = 'new' | 'updated' | 'received' | 'done' | 'declined';
export interface HandoffMessage {
  id: string;
  space: string;
  /** The canonical space (old inbox slugs are aliases). */
  canonical_space?: string;
  path: string;
  title: string;
  from: string;
  to: string;
  /** Sender / recipient is an external agent. */
  from_external?: boolean;
  to_external?: boolean;
  status: HandoffStatus;
  rev: number;
  content_rev: number;
  thread_id: string;
  reply_to: string | null;
  created_at: string;
  changed_at: string;
  age: string;
  received_rev: number | null;
  received_at: string | null;
  resolution: 'done' | 'declined' | null;
  resolved_at: string | null;
  resolved_by: string | null;
  note: string | null;
  /** Start of the body, one line (thread list). */
  snippet?: string;
}
export interface HandoffInboxOut {
  box: 'in' | 'out' | 'all';
  principal: string;
  counts: Record<HandoffStatus, number>;
  messages: HandoffMessage[];
  more: boolean;
}
