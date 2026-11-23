// Registry operation definition.
import type { z } from 'zod';
import type { AccessContext } from '../core/guard.js';
import type { AuthenticatedPrincipal } from '../core/tokens.js';

export type Effect = 'read' | 'write' | 'admin';
/** `admin` — the admin capability: a superadmin or a principal explicitly granted the capability. */
export type Requires = 'any' | 'human' | 'admin' | 'superadmin';
export type Adapter = 'mcp' | 'mcpl' | 'rest';
export type FeatureSet = 'brain.read' | 'brain.write' | 'brain.review' | 'brain.admin';
export type Via = 'mcp' | 'mcpl' | 'rest' | 'ui' | 'cli' | 'import' | 'system';

/** Who is calling: built by the adapter after transport authentication. */
export interface Caller {
  principal: AuthenticatedPrincipal;
  tokenId?: string | undefined;
  sessionId?: string | undefined;
  via: Via;
  ip: string | null;
  requestId?: string | undefined;
  /** Aborts when the client goes away (a parked wait for mail is released at once). */
  signal?: AbortSignal | undefined;
}

/** Handler context: the guard access context plus the caller. */
export interface OpContext extends AccessContext {
  caller: Caller;
}

/**
  * What the isolation test knows about a hidden space. The operation factory builds from it
  * addressed inputs (targeting hidden things) and broad inputs ("everything I can access").
 */
export interface IsolationTarget {
  space: string;
  paths: string[];
  docIds: string[];
  proposalIds: string[];
  queries: string[];
}

export interface IsolationInputs {
  /** Inputs targeting hidden objects; the answer must match the answer for `missing`. */
  addressed: { input: unknown; missing: unknown }[];
  /** Inputs without an address: the answer must contain neither canaries nor the hidden id. */
  broad: unknown[];
}

export type IsolationSpec =
  | { kind: 'inputs'; build: (hidden: IsolationTarget) => IsolationInputs }
  | { kind: 'not_applicable'; reason: string };

export interface OpDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  summary: string;
  description: string;
  input: I;
  output: O;
  effect: Effect;
  requires: Requires;
  expose: readonly Adapter[];
  featureSet: FeatureSet;
  idempotent: boolean;
  handler: (ctx: OpContext, input: z.output<I>) => z.input<O> | Promise<z.input<O>>;
  render?: (output: z.output<O>) => string;
  isolation: IsolationSpec;
  /**
    * The response contains a secret (plaintext token) and is not saved for idempotency: a replay with the same
    * request_id gets `conflict` with this `reason`.
   */
  withholdReplay?: string;
  /**
    * Before returning a saved response (a `request_id` replay), re-check current access;
    * throws `not_found` if the object in the response is no longer visible.
   */
  replayCheck?: (ctx: OpContext, output: unknown) => void;
  /** `detail` field of the audit row of a successful call (e.g. the search query string). */
  auditDetail?: (input: z.output<I>, output: z.output<O>) => Record<string, unknown>;
  /** Document and revision of a successful read for the audit row (who read the document). */
  auditTarget?: (output: z.output<O>) => { doc_id: string; rev?: number };
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;

export function defineOp<I extends z.ZodType, O extends z.ZodType>(def: OpDef<I, O>): OpDef<I, O> {
  if (!NAME_RE.test(def.name)) throw new Error(`operation name must be snake_case: ${def.name}`);
  if (def.name.startsWith('admin_') && def.requires !== 'admin' && def.requires !== 'superadmin') {
    throw new Error(`admin operations require the admin capability: ${def.name}`);
  }
  if (def.effect === 'write' && !def.idempotent) {
    throw new Error(`write operations accept request_id: ${def.name}`);
  }
  return def;
}

/** A registry operation not bound to specific schema types. */
export type AnyOp = OpDef<z.ZodType, z.ZodType>;
