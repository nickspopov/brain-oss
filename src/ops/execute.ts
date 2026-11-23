// The execute pipeline: one for all adapters.
// visibility → limit → validation → ctx → handler → output check → audit → errors.
import { recordAudit, recordDenial } from '../core/audit.js';
import type { Core } from '../core/context.js';
import { contextFor, type AccessContext } from '../core/guard.js';
import { newId } from '../core/ids.js';
import { withIdempotency } from '../core/idempotency.js';
import { pollInbox } from '../core/inbox.js';
import { waitForEvents, waitForMail } from '../core/watch.js';
import { headCursor, levelMatches, pollSince, type EventsFilter } from '../core/mailevents.js';
import { findSpace } from '../core/spaces.js';
import type { RateClass } from '../core/ratelimit.js';
import type { AnyOp, Caller, OpContext } from './define.js';
import { errorBody, ERROR_HTTP, invalidFields, OpError, type ErrorBody } from './errors.js';
import { handoffNotes, handoffSummary, inboxNotes, type HandoffSummary } from './handoff.js';
import { orientNotes, usableBy } from './orient.js';
import { getOp, isVisibleTo, visibleOps } from './registry.js';
import { getRouteOp } from './routes.js';
import { validationIssues } from './validation.js';

export type { AnyOp, Caller } from './define.js';
export { EVENTS_FILTERS, type EventsFilter } from '../core/mailevents.js';
export type { Core } from '../core/context.js';

export type ExecResult =
  | { ok: true; status: 200; result: unknown; op: string; notes?: string[]; handoff?: HandoffSummary }
  | { ok: false; status: number; error: ErrorBody; op: string | null };

export interface InboxPollOptions {
  since?: string | undefined;
  events?: EventsFilter | undefined;
}

export interface Executor {
  execute(name: string, rawInput: unknown, caller: Caller): Promise<ExecResult>;
  /** Byte routes: the same pipeline steps, with the operation from ops/routes rather than the registry. */
  executeRoute(name: string, rawInput: unknown, caller: Caller): Promise<ExecResult>;
  /**
    * Operations to advertise to the caller (MCP tools/list): visible ones minus write
   * operations for callers with no propose/write role anywhere. Not authorization: execute checks
   * every call.
   */
  advertisedOps(caller: Caller): AnyOp[];
  /**
    * GET /api/v1/inbox: waiting and answered counts for a cron job or a watcher.
   * `waitMs` > 0 parks until mail or timeout (shared waiter map). An answer at once uses the poll rate
   * limit, a parked one the read limit; a successful poll writes no audit row (refusals are audited,
   * thinned).
    * Every answer carries `next_cursor`; with `since` it also carries the events after
   * that cursor (or `resync: true` with the level snapshot), and a wait parks until such an event.
   * `events` selects inbox mail, answers or both (default, as before).
   */
  inboxPoll(caller: Caller, waitMs?: number, opts?: InboxPollOptions): Promise<ExecResult>;
}

const OP_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function createExecutor(core: Core): Executor {
  async function execute(name: string, rawInput: unknown, caller: Caller): Promise<ExecResult> {
    return run(getOp(name), name, rawInput, caller);
  }

  async function executeRoute(name: string, rawInput: unknown, caller: Caller): Promise<ExecResult> {
    return run(getRouteOp(name), name, rawInput, caller);
  }

  async function run(op: AnyOp | undefined, name: string, rawInput: unknown, caller: Caller): Promise<ExecResult> {
    // 1. An unknown or invisible operation is indistinguishable from a non-existent one.
    if (!op || !isVisibleTo(op, caller)) {
      // A stream of calls to non-existent operations consumes the read-class limit (as do
      // invisible ones: the answers are indistinguishable); beyond it — `rate_limited` with thinned audit.
      // A name outside the pattern is recorded as `unknown` (MCP lets any string through).
      const auditName = op ? op.name : OP_NAME_RE.test(name) ? name : 'unknown';
      try {
        core.limiter.take('read', caller.principal.id);
      } catch (err) {
        if (!(err instanceof OpError)) throw err;
        audit(caller, auditName, err.code, undefined, undefined, undefined, true);
        return fail(null, err);
      }
      audit(caller, auditName, 'not_found');
      return fail(null, new OpError('not_found'));
    }
    // 2. Request limit by effect: a bucket per principal and operation class.
    try {
      core.limiter.take(rateClassOf(op), caller.principal.id);
    } catch (err) {
      if (!(err instanceof OpError)) throw err;
      audit(caller, op.name, err.code, undefined, undefined, undefined, true);
      return fail(op.name, err);
    }
    // 3. Input validation.
    const parsed = op.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      const err = new OpError('invalid_input', { issues: validationIssues(op.input, parsed.error, rawInput ?? {}) });
      audit(caller, op.name, 'invalid_input', { fields: invalidFields(err.details) });
      return fail(op.name, err);
    }
    // 4. Access context.
    const ctx: OpContext = { ...contextFor(core, caller.principal), caller };
    try {
      // 5. Handler. Mutating operations with request_id: the replay lookup comes first (before permissions
      // and routing), then the handler and saving the response in one transaction.
      // Before returning a saved response, access is checked again.
      const requestId = requestIdOf(parsed.data);
      let replayed = false;
      const raw =
        op.effect !== 'read' && op.idempotent && requestId !== undefined
          ? withIdempotency(
              core,
              {
                principalId: caller.principal.id,
                requestId,
                op: op.name,
                input: parsed.data,
                storeResponse: op.withholdReplay === undefined,
                ...(op.withholdReplay !== undefined ? { withheldReason: op.withholdReplay } : {}),
                onReplay: (response) => {
                  op.replayCheck?.(ctx, response);
                  replayed = true;
                },
              },
              () => op.handler(ctx, parsed.data),
            )
          : await op.handler(ctx, parsed.data);
      // 6. In dev and tests the output is checked against the schema.
      let result: unknown = raw;
      if (core.config.dev) {
        const out = op.output.safeParse(raw);
        if (!out.success) {
          throw new Error(`output of ${op.name} does not match its schema: ${out.error.message}`);
        }
        result = out.data;
      }
      // 7. Audit. For writes the row was already inserted inside commit;
      // a request_id replay does not call commit, so it is written here.
      if (op.effect !== 'write' || replayed) {
        const admin = !replayed && isAdminChange(op) ? adminAudit(parsed.data, result) : undefined;
        const detail = replayed ? { replay: true } : (op.auditDetail?.(parsed.data, result) ?? admin?.detail);
        audit(caller, op.name, 'ok', detail, replayed ? undefined : op.auditTarget?.(result), admin?.spaceId);
      }
      // The write is committed: wake event delivery (webhooks).
      if (op.effect === 'write' && !replayed) core.events.notifyCommitted();
      // Orientation nudges: never fail the call because of them.
      let notes: string[] = [];
      try {
        notes = orientNotes(ctx, op, parsed.data, result);
      } catch (err) {
        core.log.warn({ err, op: op.name }, 'orientation notes failed');
      }
      try {
        if (!replayed) notes.push(...handoffNotes(ctx, op, parsed.data, result));
      } catch (err) {
        core.log.warn({ err, op: op.name }, 'handoff notes failed');
      }
      let handoff: HandoffSummary | undefined;
      try {
        notes.push(...inboxNotes(ctx, op));
        handoff = handoffSummary(ctx, op);
      } catch (err) {
        core.log.warn({ err, op: op.name }, 'inbox hint failed');
      }
      return { ok: true, status: 200, result, op: op.name, ...(notes.length ? { notes } : {}), ...(handoff ? { handoff } : {}) };
    } catch (err) {
      // 8. OpError as is; anything else becomes internal without details.
      if (err instanceof OpError) {
        const detail = err.code === 'invalid_input' ? { fields: invalidFields(err.details) } : undefined;
        audit(caller, op.name, err.code, detail, undefined, undefined, err.code === 'rate_limited');
        return fail(op.name, err);
      }
      const incident = newId(core.now());
      core.log.error({ err, incident_id: incident, op: op.name }, 'operation failed');
      audit(caller, op.name, 'internal');
      return fail(op.name, new OpError('internal', { incident_id: incident }));
    }
  }

  /**
    * Audit row of a mutating admin_* operation: input and result without secrets —
    * to whom, what and where was issued or revoked — and the space in `space_id`.
   */
  function adminAudit(input: unknown, output: unknown): { detail: Record<string, unknown>; spaceId?: string } {
    const i = (input ?? {}) as Record<string, unknown>;
    const o = (output ?? {}) as Record<string, unknown>;
    const { request_id: _r, ...rest } = i;
    const space = o.space as { id?: unknown } | undefined;
    const grant = o.grant as { space?: unknown } | undefined;
    let spaceId = typeof space?.id === 'string' ? space.id : undefined;
    if (spaceId === undefined) {
      const slug = [grant?.space, i.space, i.slug].find((v): v is string => typeof v === 'string');
      if (slug !== undefined) spaceId = findSpace(core, slug)?.id;
    }
    return { detail: { input: redact(rest), result: redact(o) }, ...(spaceId !== undefined ? { spaceId } : {}) };
  }

  function audit(
    caller: Caller,
    op: string,
    outcome: string,
    detail?: Record<string, unknown>,
    target?: { doc_id: string; rev?: number },
    spaceId?: string,
    /** A streaming refusal: rows are thinned per principal. */
    throttled = false,
  ): void {
    try {
      const entry = {
        ...(target ? { doc_id: target.doc_id, rev: target.rev ?? null } : {}),
        ...(spaceId !== undefined ? { space_id: spaceId } : {}),
        principal_id: caller.principal.id,
        token_id: caller.tokenId ?? null,
        via: caller.via,
        op,
        outcome,
        request_id: caller.requestId ?? null,
        ip: caller.ip,
        ...(detail ? { detail } : {}),
      };
      if (throttled) recordDenial(core, `${outcome}:${caller.principal.id}`, entry);
      else recordAudit(core, entry);
    } catch (err) {
      core.log.error({ err }, 'audit insert failed');
    }
  }

  function advertisedOps(caller: Caller): AnyOp[] {
    const ctx: OpContext = { ...contextFor(core, caller.principal), caller };
    return usableBy(ctx, visibleOps(caller));
  }

  async function inboxPoll(caller: Caller, waitMs = 0, opts: InboxPollOptions = {}): Promise<ExecResult> {
    try {
      const filter = opts.events ?? 'both';
      const since = opts.since;
      // Level fields and the cursor come from one synchronous read: a consistent snapshot.
      const answer = (ctx: AccessContext) => {
        const level = pollInbox(ctx);
        if (since === undefined) return { ready: levelMatches(level.waiting, level.answered, filter), result: { ...level, next_cursor: headCursor(ctx, filter) } };
        const page = pollSince(ctx, filter, since);
        return { ready: page.events.length > 0 || page.resync === true, result: { ...level, ...page } };
      };
      let out = answer(contextFor(core, caller.principal));
      const now = out.ready || waitMs <= 0;
      core.limiter.take(now ? 'poll' : 'read', caller.principal.id);
      if (!now) {
        if (since === undefined) await waitForMail(core, caller.principal, caller.tokenId, waitMs, caller.signal, filter);
        else await waitForEvents(core, caller.principal, caller.tokenId, waitMs, filter, since, caller.signal);
        out = answer(contextFor(core, caller.principal));
      }
      return { ok: true, status: 200, result: out.result, op: 'inbox_poll' };
    } catch (err) {
      if (err instanceof OpError) {
        audit(caller, 'inbox_poll', err.code, undefined, undefined, undefined, true);
        return fail('inbox_poll', err);
      }
      const incident = newId(core.now());
      core.log.error({ err, incident_id: incident, op: 'inbox_poll' }, 'operation failed');
      audit(caller, 'inbox_poll', 'internal');
      return fail('inbox_poll', new OpError('internal', { incident_id: incident }));
    }
  }

  return { execute, executeRoute, advertisedOps, inboxPoll };
}

/** Limit class: search separately, other reads, writes and admin actions. */
function rateClassOf(op: AnyOp): RateClass {
  if (op.name === 'search') return 'search';
  return op.effect === 'read' ? 'read' : 'write';
}

function requestIdOf(input: unknown): string | undefined {
  if (input && typeof input === 'object' && 'request_id' in input) {
    const v = (input as { request_id?: unknown }).request_id;
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function fail(op: string | null, err: OpError): ExecResult {
  return { ok: false, status: ERROR_HTTP[err.code], error: errorBody(err.code, err.details, err.message), op };
}

/** A mutating admin_* operation (reads — list, query, explain, guide — are audited without detail). */
function isAdminChange(op: AnyOp): boolean {
  return op.effect === 'admin' && !/_(list|query|explain|guide|get|preview|members)$/.test(op.name);
}

/** Fields with secrets: plaintext token, webhook secret, password. They never reach the audit. */
const SECRET_KEYS = new Set(['password', 'secret', 'token', 'new_password']);
const MAX_ITEMS = 50;
const MAX_STRING = 300;

/** A copy of the value without secrets, with long strings and lists truncated. */
function redact(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
  if (v === null || typeof v !== 'object' || depth > 4) return typeof v === 'object' && v !== null ? '…' : v;
  if (Array.isArray(v)) {
    const items = v.slice(0, MAX_ITEMS).map((x) => redact(x, depth + 1));
    return v.length > MAX_ITEMS ? [...items, `… ${v.length - MAX_ITEMS} more`] : items;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (SECRET_KEYS.has(k) && typeof x === 'string') continue;
    out[k] = redact(x, depth + 1);
  }
  return out;
}
