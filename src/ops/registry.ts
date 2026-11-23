// Operation registry: a single list for REST, MCP, MCPL, OpenAPI and tests.
import { z } from 'zod';
import type { Adapter, AnyOp, Caller } from './define.js';
import { activityOp } from './agent/activity.js';
import { changesOp } from './agent/changes.js';
import { deleteOp } from './agent/delete.js';
import { editOp } from './agent/edit.js';
import { exportOp } from './agent/export.js';
import { diffOp } from './agent/diff.js';
import { historyOp } from './agent/history.js';
import { listOp } from './agent/list.js';
import { moveOp } from './agent/move.js';
import { proposalDecideOp, proposalGetOp, proposalListOp, proposalWithdrawOp, proposeOp } from './agent/proposals.js';
import { readOp } from './agent/read.js';
import { restoreOp } from './agent/restore.js';
import { searchOp } from './agent/search.js';
import { revertOp } from './agent/revert.js';
import { spaces } from './agent/spaces.js';
import { writeOp } from './agent/write.js';
import { whoami } from './agent/whoami.js';
import { startHereOp } from './agent/start_here.js';
import { handoffAckOp, handoffInboxOp, handoffRecipientsOp, handoffSendOp } from './agent/handoff.js';
import { handoffWaitOp } from './agent/handoff_wait.js';
import { profileGetOp, profileUpdateOp } from './agent/profile.js';
import { adminProfileGetOp, adminSpaceMembersOp } from './admin/members.js';
import { adminSettingsGetOp, adminSettingsUpdateOp } from './admin/settings.js';
import { adminAuditQueryOp } from './admin/audit.js';
import { adminConnectGuideOp } from './admin/connect.js';
import { adminAgentConnectionOp, adminAgentConnectOp } from './admin/agentconnect.js';
import { adminPurgeOp } from './admin/purge.js';
import { adminAccessExplainOp, adminGrantListOp, adminGrantRemoveOp, adminGrantSetOp, adminSpacesPreviewOp } from './admin/grants.js';
import {
  adminGroupCreateOp,
  adminGroupDeleteOp,
  adminGroupListOp,
  adminGroupMembersSetOp,
  adminGroupUpdateOp,
} from './admin/groups.js';
import {
  adminPrincipalCreateOp,
  adminPrincipalDisableOp,
  adminPrincipalEnableOp,
  adminPrincipalListOp,
  adminPrincipalUpdateOp,
} from './admin/principals.js';
import {
  adminSpaceArchiveOp,
  adminSpaceCreateOp,
  adminSpaceListOp,
  adminSpaceUnarchiveOp,
  adminSpaceUpdateOp,
} from './admin/spaces.js';
import { adminTokenIssueOp, adminTokenListOp, adminTokenRevokeOp } from './admin/tokens.js';
import {
  adminWebhookCreateOp,
  adminWebhookDeleteOp,
  adminWebhookListOp,
  adminWebhookTestOp,
  adminWebhookUpdateOp,
} from './admin/webhooks.js';

const ALL = [
  startHereOp,
  whoami,
  spaces,
  listOp,
  readOp,
  writeOp,
  editOp,
  moveOp,
  deleteOp,
  restoreOp,
  historyOp,
  diffOp,
  revertOp,
  searchOp,
  changesOp,
  activityOp,
  proposeOp,
  proposalListOp,
  proposalGetOp,
  proposalDecideOp,
  proposalWithdrawOp,
  exportOp,
  handoffSendOp,
  handoffInboxOp,
  handoffRecipientsOp,
  handoffAckOp,
  handoffWaitOp,
  profileGetOp,
  profileUpdateOp,
  adminSpaceCreateOp,
  adminSpaceUpdateOp,
  adminSpaceArchiveOp,
  adminSpaceUnarchiveOp,
  adminSpaceListOp,
  adminPrincipalCreateOp,
  adminPrincipalUpdateOp,
  adminPrincipalDisableOp,
  adminPrincipalEnableOp,
  adminPrincipalListOp,
  adminTokenIssueOp,
  adminTokenRevokeOp,
  adminTokenListOp,
  adminGroupCreateOp,
  adminGroupUpdateOp,
  adminGroupDeleteOp,
  adminGroupMembersSetOp,
  adminGroupListOp,
  adminGrantSetOp,
  adminGrantRemoveOp,
  adminGrantListOp,
  adminAccessExplainOp,
  adminSpaceMembersOp,
  adminProfileGetOp,
  adminSpacesPreviewOp,
  adminAuditQueryOp,
  adminPurgeOp,
  adminWebhookCreateOp,
  adminWebhookUpdateOp,
  adminWebhookDeleteOp,
  adminWebhookListOp,
  adminWebhookTestOp,
  adminConnectGuideOp,
  adminAgentConnectOp,
  adminAgentConnectionOp,
  adminSettingsGetOp,
  adminSettingsUpdateOp,
] as unknown as AnyOp[];

const byName = new Map<string, AnyOp>();
for (const op of ALL) {
  if (byName.has(op.name)) throw new Error(`duplicate operation: ${op.name}`);
  byName.set(op.name, op);
}

export function listOps(): AnyOp[] {
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getOp(name: string): AnyOp | undefined {
  return byName.get(name);
}

export function hasOp(name: string): boolean {
  return byName.has(name);
}

export function adapterOf(via: Caller['via']): Adapter | null {
  switch (via) {
    case 'mcp':
      return 'mcp';
    case 'mcpl':
      return 'mcpl';
    case 'rest':
    case 'ui':
    case 'cli':
      return 'rest';
    default:
      return null;
  }
}

/** Whether the operation is visible to this caller through this adapter (`requires` and `expose`). */
export function isVisibleTo(op: AnyOp, caller: Caller): boolean {
  const adapter = adapterOf(caller.via);
  if (adapter === null || !op.expose.includes(adapter)) return false;
  const p = caller.principal;
  switch (op.requires) {
    case 'any':
      return true;
    case 'human':
      return p.kind === 'human';
    case 'admin':
      return (p.kind === 'human' && p.role === 'superadmin') || p.admin === true;
    case 'superadmin':
      return p.kind === 'human' && p.role === 'superadmin';
  }
}

export function visibleOps(caller: Caller): AnyOp[] {
  return listOps().filter((op) => isVisibleTo(op, caller));
}

const inputSchemas = new Map<string, Record<string, unknown>>();

/**
  * Input JSON Schema of an operation (from zod) for MCP `tools/list` and OpenAPI. Without `$schema`:
  * MCP assumes JSON Schema 2020-12 by default, and some clients do not understand the `$schema` field.
 */
export function inputJsonSchema(op: AnyOp): Record<string, unknown> {
  let schema = inputSchemas.get(op.name);
  if (!schema) {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(op.input, { io: 'input' }) as Record<string, unknown>;
    schema = rest;
    inputSchemas.set(op.name, schema);
  }
  return schema;
}

/**
  * Result text for the LLM (MCP `content`): the operation's `render(output)`, JSON by default.
  * The output is coerced through the `output` schema (in production execute returns the handler output as is).
 */
export function renderOutput(op: AnyOp, result: unknown): string {
  if (op.render) {
    const parsed = op.output.safeParse(result);
    if (parsed.success) return op.render(parsed.data);
  }
  return JSON.stringify(result, null, 2);
}

const outputSchemas = new Map<string, Record<string, unknown>>();

/** Output JSON Schema of an operation (from zod) for OpenAPI. Without `$schema`, cached. */
export function outputJsonSchema(op: AnyOp): Record<string, unknown> {
  let schema = outputSchemas.get(op.name);
  if (!schema) {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(op.output, { io: 'output' }) as Record<string, unknown>;
    schema = rest;
    outputSchemas.set(op.name, schema);
  }
  return schema;
}
