// admin_agent_connect | admin_agent_connection. One step: the agent, its explicit space memberships
// and a token, atomically; the
// answer carries — once — a ready config for its harness with the real URL and the Brain token filled in.
// The bundle is never stored: not in the idempotency table (a repeated request_id answers conflict), not in
// the audit (its detail lists names and roles only), not in any cache (REST answers no-store). Then the
// screen waits for the first *authenticated* call with that token, and shows what the agent sees and a
// negative probe: for every other active space, a canary read made as the agent must be not_found.
import { z } from 'zod';
import { agentConnect, connectionFacts, type ConnectionFacts, type HiddenSpace } from '../../core/connect.js';
import { OpError } from '../../core/errors.js';
import { contextForRow } from '../../core/guard.js';
import { toAuthenticated } from '../../core/tokens.js';
import type { Core } from '../../core/context.js';
import { defineOp, type OpContext } from '../define.js';
import { listOp } from '../agent/list.js';
import { readOp } from '../agent/read.js';
import { RoleSchema, TrustSchema, toIso } from '../types.js';
import { ADMIN, ADMIN_ISOLATION, LadderSchema, NameSchema, PrincipalViewSchema, RequestId, TokenViewSchema, principalOut, tokenOut } from './common.js';
import { checkTransport, connectBundle, defaultTransport, HARNESSES, urlsOf } from './connect.js';

type PrincipalRow = ConnectionFacts['principal'];

const SpaceRole = RoleSchema.exclude(['none']);

const BundleSchema = z.object({
  harness: z.enum(HARNESSES),
  transport: z.enum(['http', 'stdio']),
  server_url: z.string(),
  mcp_url: z.string(),
  where: z.string(),
  config: z.string(),
  sentence: z.string(),
  text: z.string(),
  filename: z.string(),
});

export const adminAgentConnectOp = defineOp({
  name: 'admin_agent_connect',
  summary: 'Connect agent: create it, its space memberships and a token at once; the ready config is returned once (admin).',
  description:
    'Creates an agent (name, display_name, manager: owner = a person in Brain, or outside = the name of someone ' +
    'outside Brain, which makes it external), gives it exactly the listed space memberships (role per space; ' +
    'nothing else, no automatic General, never the all-agents group) and issues a token — all in one transaction: ' +
    'if any step is refused nothing is created. The result carries the token and a ready config for the harness ' +
    'with the real URL and the token filled in, plus the sentence to paste to the agent. It is shown once and never ' +
    'stored: repeating the same request_id answers conflict (token_already_issued); issue a new token instead. ' +
    'Then poll admin_agent_connection with the token id.',
  input: z
    .object({
      name: NameSchema,
      display_name: z.string().min(1).max(200).optional(),
      owner: NameSchema.optional(),
      outside: z.string().trim().min(1).max(100).optional(),
      harness: z.enum(HARNESSES),
      transport: z.enum(['http', 'stdio']).optional(),
      trust: TrustSchema.optional(),
      spaces: z.array(z.object({ space: z.string().min(1).max(63), role: SpaceRole }).strict()).max(100),
      days: z.number().int().min(1).max(3650).nullable().optional(),
      ...RequestId,
    })
    .strict(),
  output: z.object({
    principal: PrincipalViewSchema,
    token: z.string(),
    info: TokenViewSchema,
    spaces: z.array(z.object({ slug: z.string(), role: RoleSchema })),
    bundle: BundleSchema,
  }),
  ...ADMIN,
  idempotent: true,
  withholdReplay: 'token_already_issued',
  handler: (ctx, i) => {
    const transport = i.transport ?? defaultTransport(i.harness);
    checkTransport(i.harness, transport);
    const r = agentConnect(ctx, {
      name: i.name,
      display_name: i.display_name,
      owner: i.owner,
      outside: i.outside,
      harness: i.harness,
      trust: i.trust,
      spaces: i.spaces,
      days: i.days,
    });
    return {
      principal: principalOut(r.principal),
      token: r.token,
      info: tokenOut(r.token_view),
      spaces: r.target.spaces,
      bundle: connectBundle(i.harness, transport, urlsOf(ctx.core.config.origin), r.target, r.token),
    };
  },
  // Who was connected where, never the token or the bundle.
  auditDetail: (i, o) => ({
    name: i.name,
    harness: i.harness,
    external: i.outside !== undefined,
    spaces: i.spaces.map((s) => `${s.space}:${s.role}`).slice(0, 20),
    token_id: o.info.id,
  }),
  render: (o) => `Connected ${o.principal.name}: token ${o.info.prefix}… (shown once in the structured result). Then call admin_agent_connection.`,
  isolation: ADMIN_ISOLATION,
});

const ProbeCode = z.string();

/** Runs one agent operation as `row`, as a request would, and returns its error code (`ok` if it succeeded). */
async function asAgent(core: Core, row: PrincipalRow, run: (ctx: OpContext) => unknown, secrets: readonly string[]): Promise<{ code: string; leak: boolean }> {
  const ctx: OpContext = { ...contextForRow(core, row), caller: { principal: toAuthenticated(row), via: 'system', ip: null } };
  try {
    await run(ctx);
    return { code: 'ok', leak: true };
  } catch (err) {
    if (!(err instanceof OpError)) throw err;
    // What the agent would get back must not name the hidden space or its documents.
    const said = `${err.message} ${JSON.stringify(err.details ?? null)}`.toLowerCase();
    return { code: err.code, leak: secrets.some((s) => s.length > 0 && said.includes(s.toLowerCase())) };
  }
}

async function probe(core: Core, row: PrincipalRow, h: HiddenSpace) {
  const secrets = [h.space.slug, h.space.name, ...(h.canary ? [h.canary.path, h.canary.id] : [])];
  const list = await asAgent(core, row, (c) => listOp.handler(c, { space: h.space.slug }), secrets);
  const read = await asAgent(
    core,
    row,
    (c) => readOp.handler(c, h.canary ? { space: h.space.slug, path: h.canary.path, format: 'meta' } : { space: h.space.slug, path: 'AGENTS.md', format: 'meta' }),
    secrets,
  );
  return {
    space: h.space.slug,
    name: h.space.name,
    canary: h.canary !== null,
    list: list.code,
    read: read.code,
    confirmed: list.code === 'not_found' && read.code === 'not_found' && !list.leak && !read.leak,
  };
}

export const adminAgentConnectionOp = defineOp({
  name: 'admin_agent_connection',
  summary: 'Connect agent, live check: has the agent called Brain with this token yet, what it sees and what it does not (admin).',
  description:
    'Connection state of one token of an agent. connected is true only after an authenticated request with that ' +
    'token (issuing it, downloading the config or calling this does not count). When connected: sees lists its ' +
    'spaces with their role on the ladder; not_sees counts every other active space and, for each, a negative probe ' +
    'made as the agent — list of the space and a read of a canary document there — that must answer not_found ' +
    '(confirmed) without naming the space. Changes nothing.',
  input: z.object({ name: NameSchema, token_id: z.string().min(1).max(64) }).strict(),
  output: z.object({
    principal: z.string(),
    token: z.object({ id: z.string(), prefix: z.string(), revoked: z.boolean(), expired: z.boolean() }),
    connected: z.boolean(),
    last_contact_at: z.string().nullable(),
    /** via: the groups it is a member through, when it has no personal membership (e.g. all-agents). */
    sees: z.array(z.object({ space: z.string(), name: z.string(), role: LadderSchema, messages_only: z.boolean(), via: z.array(z.string()) })),
    not_sees: z
      .object({
        count: z.number().int(),
        probes: z.array(
          z.object({ space: z.string(), name: z.string(), canary: z.boolean(), list: ProbeCode, read: ProbeCode, confirmed: z.boolean() }),
        ),
        all_confirmed: z.boolean(),
      })
      .nullable(),
  }),
  ...ADMIN,
  idempotent: false,
  handler: async (ctx, i) => {
    const f = connectionFacts(ctx.core, i.name, i.token_id);
    let notSees = null;
    if (f.connected) {
      const probes = [];
      for (const h of f.hidden) probes.push(await probe(ctx.core, f.principal, h));
      notSees = { count: f.hidden.length, probes, all_confirmed: probes.every((p) => p.confirmed) };
    }
    const now = ctx.core.now();
    return {
      principal: f.principal.name,
      token: {
        id: f.token.id,
        prefix: f.token.prefix,
        revoked: f.token.revoked_at !== null,
        expired: f.token.expires_at !== null && f.token.expires_at <= now,
      },
      connected: f.connected,
      last_contact_at: f.token.last_used_at === null ? null : toIso(f.token.last_used_at),
      sees: f.sees.map((s) => ({
        space: s.space.slug,
        name: s.space.name,
        role: s.access.role,
        messages_only: s.access.messages_only,
        via: s.access.personal !== null ? [] : s.access.groups.map((g) => g.name),
      })),
      not_sees: notSees,
    };
  },
  auditDetail: (i, o) => ({ name: i.name, token_id: i.token_id, connected: o.connected }),
  isolation: ADMIN_ISOLATION,
});
