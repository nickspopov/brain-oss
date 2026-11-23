// The UI's REST client: POST /api/v1/ops/{name}, session in a cookie. Every request carries
// `X-Brain-Client`: without it the server rejects mutating requests with a cookie (CSRF).
import type {
  AccessExplainOut,
  AgentConnectionOut,
  AgentConnectOut,
  AdminSettings,
  ConnectGuideOut,
  ConnectHarness,
  ActivityOut,
  AuditEntry,
  AuditFilter,
  ExportOut,
  ProposalGetOut,
  ProposalListOut,
  Proposal,
  AdminGrant,
  AdminGroup,
  AdminPrincipal,
  ExternalLimits,
  AdminProfileOut,
  AdminSpace,
  AdminToken,
  ApiErrorBody,
  DiffOut,
  DocInfo,
  GrantKey,
  HandoffInboxOut,
  HandoffMessage,
  HandoffRecipient,
  HistoryOut,
  ListOut,
  ReadOut,
  SearchOut,
  SessionPrincipal,
  SpaceInfo,
  SpaceMembersOut,
  SpaceSettingsInput,
  Role,
  Trust,
  WhoamiOut,
  WriteOut,
} from './types';
import { tx } from '../i18n';

export const CLIENT_HEADER = 'X-Brain-Client';
const CLIENT_NAME = 'brain-web';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.status = status;
    this.details = body.details;
  }
}

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** For tests. */
export function setFetch(f: Fetch): void {
  fetchImpl = f;
}

/** Session-loss handler (401): the app redirects to login. */
let onUnauthenticated: () => void = () => {};
export function setUnauthenticatedHandler(fn: () => void): void {
  onUnauthenticated = fn;
}

async function request<T>(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { [CLIENT_HEADER]: CLIENT_NAME, Accept: 'application/json' };
  // Bytes (file upload) are sent as is; everything else as JSON.
  const raw = body instanceof Blob;
  if (body !== undefined) headers['Content-Type'] = raw ? 'application/octet-stream' : 'application/json';
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, { code: 'network', message: tx.errors.networkMessage, retryable: true });
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(res.status, { code: 'internal', message: `HTTP ${res.status}`, retryable: res.status >= 500 });
  }
  const env = json as { ok?: boolean; result?: unknown; error?: ApiErrorBody };
  if (env && env.ok === true) return env.result as T;
  const error = env?.error ?? { code: 'internal', message: `HTTP ${res.status}`, retryable: false };
  const err = new ApiError(res.status, error);
  if (err.code === 'unauthenticated' && !url.startsWith('/api/v1/auth/')) onUnauthenticated();
  throw err;
}

/** Calls a registry operation. */
export function call<T>(op: string, input: object = {}): Promise<T> {
  return request<T>('POST', `/api/v1/ops/${encodeURIComponent(op)}`, input);
}

export const api = {
  session: () => request<{ principal: SessionPrincipal }>('GET', '/api/v1/auth/session'),
  login: (name: string, password: string) => request<{ principal: SessionPrincipal }>('POST', '/api/v1/auth/login', { name, password }),
  logout: () => request<{ logged_out: true }>('POST', '/api/v1/auth/logout', {}),
  /** Own password (account_password_change): other sessions are signed out, this one continues. */
  changePassword: (current_password: string, new_password: string) =>
    request<{ changed: true; revoked_sessions: number }>('POST', '/api/v1/auth/password', { current_password, new_password }),
  whoami: () => call<WhoamiOut>('whoami'),
  spaces: () => call<{ spaces: SpaceInfo[] }>('spaces'),
  list: (input: { space: string; path?: string; depth?: number; include_deleted?: boolean; include_messages?: boolean; cursor?: string; limit?: number }) => call<ListOut>('list', input),
  read: (input: DocRef & { rev?: number; format?: 'full' | 'meta'; max_bytes?: number }) => call<ReadOut>('read', input),
  search: (input: { query: string; spaces?: string[]; cursor?: string; limit?: number }) => call<SearchOut>('search', input),

  // Editing and history. `request_id` makes a retry after a network failure safe.
  write: (input: { space: string; path: string; content: string; expected_rev: number; message: string; request_id?: string; allow_secret?: boolean }) =>
    call<WriteOut>('write', input),
  move: (input: DocRef & { to_path: string; expected_rev?: number; message?: string; request_id?: string }) => call<{ doc: DocInfo }>('move', input),
  delete: (input: DocRef & { expected_rev?: number; message?: string; request_id?: string }) => call<{ doc: DocInfo }>('delete', input),
  restore: (input: { id: string; path?: string; message?: string; request_id?: string }) => call<{ doc: DocInfo }>('restore', input),
  history: (input: DocRef & { cursor?: string; limit?: number }) => call<HistoryOut>('history', input),
  diff: (input: DocRef & { from: number; to?: number | 'head' }) => call<DiffOut>('diff', input),
  revert: (input: DocRef & { to_rev: number; expected_rev?: number; message: string; request_id?: string }) => call<WriteOut>('revert', input),

  // Feed, proposals, export.
  activity: (input: { space?: string; author?: string; before?: string; limit?: number }) => call<ActivityOut>('activity', input),
  proposalList: (input: { space?: string; status?: Proposal['status']; mine?: boolean; cursor?: string; limit?: number }) =>
    call<ProposalListOut>('proposal_list', input),
  proposalGet: (id: string) => call<ProposalGetOut>('proposal_get', { id }),
  /** Accepting a stale proposal only with the `expected_rev` the human saw. */
  proposalDecide: (input: { id: string; decision: 'accept' | 'reject'; note?: string; expected_rev?: number; request_id?: string }) =>
    call<{ proposal: Proposal; doc?: DocInfo }>('proposal_decide', input),
  proposalWithdraw: (input: { id: string; request_id?: string }) => call<{ proposal: Proposal }>('proposal_withdraw', input),
  export: (input: { space: string; mode?: 'head' | 'full' }) => call<ExportOut>('export', input),

  // Handoff messages: the UI acts as the signed-in human.
  handoffInbox: (input: { box?: 'in' | 'out' | 'all'; include_done?: boolean; space?: string }) => call<HandoffInboxOut>('handoff_inbox', input),
  handoffRecipients: () => call<{ recipients: HandoffRecipient[] }>('handoff_recipients'),
  handoffSend: (input: { to: string; title: string; body: string; reply_to?: string; space?: string; request_id?: string }) =>
    call<{ message: HandoffMessage; doc: DocInfo }>('handoff_send', input),
  handoffAck: (input: { id: string; expected_rev: number; status: 'received' | 'done' | 'declined'; note?: string; request_id?: string }) =>
    call<{ message: HandoffMessage; already: boolean }>('handoff_ack', input),

  /** `PUT /api/v1/files/{space}/{path…}`: the body is the file's bytes, then a normal commit. */
  upload: (input: { space: string; path: string; file: Blob; expected_rev?: number; message?: string; request_id?: string }) => {
    const qs = new URLSearchParams();
    if (input.expected_rev !== undefined) qs.set('expected_rev', String(input.expected_rev));
    if (input.message) qs.set('message', input.message);
    if (input.request_id) qs.set('request_id', input.request_id);
    const q = qs.toString();
    return request<WriteOut>('PUT', `${filesUrl(input.space, input.path)}${q ? `?${q}` : ''}`, input.file);
  },
};

/** `request_id` makes a retry of a mutating admin operation after a network failure safe. */
type Rid = { request_id?: string };

/** Administrative operations: only with the `admin` capability, otherwise the server answers `not_found`. */
export const admin = {
  spaceList: (include_archived = true) => call<{ spaces: AdminSpace[] }>('admin_space_list', { include_archived }),
  spaceCreate: (input: { slug: string } & SpaceSettingsInput & Rid) => call<{ space: AdminSpace }>('admin_space_create', input),
  spaceUpdate: (input: { slug: string; new_slug?: string } & SpaceSettingsInput & Rid) => call<{ space: AdminSpace }>('admin_space_update', input),
  spaceArchive: (input: { slug: string } & Rid) => call<{ space: AdminSpace }>('admin_space_archive', input),
  spaceUnarchive: (input: { slug: string } & Rid) => call<{ space: AdminSpace }>('admin_space_unarchive', input),

  principalList: (include_disabled = true) => call<{ principals: AdminPrincipal[] }>('admin_principal_list', { include_disabled }),
  principalCreate: (
    input: {
      name: string;
      kind: 'agent' | 'human';
      trust: Trust;
      display_name?: string;
      owner?: string;
      harness?: string;
      password?: string;
      admin?: boolean;
      external?: boolean;
      owner_label?: string;
      limits?: Partial<ExternalLimits>;
    } & Rid,
  ) => call<{ principal: AdminPrincipal }>('admin_principal_create', input),
  principalUpdate: (
    input: {
      name: string;
      display_name?: string;
      trust?: Trust;
      owner?: string | null;
      harness?: string | null;
      password?: string;
      admin?: boolean;
      owner_label?: string | null;
      limits?: Partial<ExternalLimits>;
      /** Set by a human only (the server refuses agents). */
      external?: boolean;
      what_i_do?: string | null;
      contact?: string | null;
    } & Rid,
  ) => call<{ principal: AdminPrincipal }>('admin_principal_update', input),
  /** The full profile and the fields found in its agent cards. */
  profileGet: (name: string) => call<AdminProfileOut>('admin_profile_get', { name }),
  /** Members of a space with their role on the ladder. */
  spaceMembers: (space: string) => call<SpaceMembersOut>('admin_space_members', { space }),
  principalDisable: (input: { name: string } & Rid) => call<{ principal: AdminPrincipal }>('admin_principal_disable', input),
  principalEnable: (input: { name: string } & Rid) => call<{ principal: AdminPrincipal }>('admin_principal_enable', input),

  tokenList: (principal?: string) => call<{ tokens: AdminToken[] }>('admin_token_list', { ...(principal ? { principal } : {}), include_revoked: true }),
  /** The full token arrives once; a repeat of the same `request_id` won't return it. */
  tokenIssue: (input: { principal: string; label?: string; days?: number | null } & Rid) => call<{ token: string; info: AdminToken }>('admin_token_issue', input),
  tokenRevoke: (input: { id: string } & Rid) => call<{ token: AdminToken }>('admin_token_revoke', input),

  groupList: () => call<{ groups: AdminGroup[] }>('admin_group_list'),
  groupCreate: (input: { name: string; description?: string } & Rid) => call<{ group: AdminGroup }>('admin_group_create', input),
  groupUpdate: (input: { name: string; new_name?: string; description?: string } & Rid) => call<{ group: AdminGroup }>('admin_group_update', input),
  groupDelete: (input: { name: string } & Rid) => call<{ deleted: true }>('admin_group_delete', input),
  groupMembersSet: (input: { name: string; members: string[] } & Rid) => call<{ group: AdminGroup }>('admin_group_members_set', input),

  grantList: (input: { space?: string; subject?: GrantKey['subject'] } = {}) => call<{ grants: AdminGrant[] }>('admin_grant_list', input),
  grantSet: (input: GrantKey & { role: AdminGrant['role'] } & Rid) => call<{ grant: AdminGrant }>('admin_grant_set', input),
  grantRemove: (input: GrantKey & Rid) => call<{ removed: true }>('admin_grant_remove', input),
  accessExplain: (input: { principal: string; space?: string; path?: string; doc_id?: string }) => call<AccessExplainOut>('admin_access_explain', input),

  /** Audit log: newest first, cursor pagination. */
  auditQuery: (input: AuditFilter & { cursor?: string; limit?: number }) => call<{ entries: AuditEntry[]; next_cursor?: string }>('admin_audit_query', input),

  /** `admin_connect_guide`: without `harness` the server takes the one recorded for the agent (or generic). */
  /** Tenant settings: the start_here guide text; null restores the default. */
  settingsGet: () => call<{ settings: AdminSettings }>('admin_settings_get'),
  settingsUpdate: (input: { guide_text: string | null } & Rid) => call<{ settings: AdminSettings }>('admin_settings_update', input),

  agentConnect: (
    input: {
      name: string;
      display_name?: string;
      owner?: string;
      outside?: string;
      harness: ConnectHarness;
      transport?: 'http' | 'stdio';
      trust?: Trust;
      spaces: { space: string; role: Exclude<Role, 'none'> }[];
    } & Rid,
  ) => call<AgentConnectOut>('admin_agent_connect', input),
  agentConnection: (input: { name: string; token_id: string }) => call<AgentConnectionOut>('admin_agent_connection', input),
  connectGuide: (input: { principal?: string; harness?: ConnectHarness; transport?: 'http' | 'stdio' }) => call<ConnectGuideOut>('admin_connect_guide', input),
};

/** A document reference: `{ id }` (including a deleted one) or `{ space, path }`. */
export type DocRef = { id: string } | { space: string; path: string };

export function filesUrl(space: string, path: string): string {
  return `/api/v1/files/${encodeURIComponent(space)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Download link for the body: `attachment` + `nosniff`, nothing is served inline. */
export function rawUrl(id: string, rev?: number): string {
  return `/api/v1/docs/${encodeURIComponent(id)}/raw${rev !== undefined ? `?rev=${rev}` : ''}`;
}
