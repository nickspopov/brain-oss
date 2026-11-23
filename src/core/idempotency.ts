// Idempotency: lookup by (principal, request_id) comes first;
// a match is checked by (op, input_hash); check, execution and saving the response are one transaction.
import { createHash } from 'node:crypto';
import { getIdempotency, insertIdempotency } from '../store/idempotency.js';
import { bumpAcl } from './access/snapshot.js';
import type { Core } from './context.js';
import { conflict, OpError } from './errors.js';

/** Canonical JSON: object keys sorted alphabetically, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  // Bytes (file upload) are compared by hash, not element by element.
  if (value instanceof Uint8Array) return JSON.stringify(`sha256:${createHash('sha256').update(value).digest('hex')}`);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** sha256 of the canonical JSON of the input without `request_id`. */
export function inputHash(input: unknown): string {
  const copy = input && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : input;
  if (copy && typeof copy === 'object' && !Array.isArray(copy)) delete (copy as Record<string, unknown>).request_id;
  return createHash('sha256').update(canonicalJson(copy), 'utf8').digest('hex');
}

const WITHHELD = '{"withheld":true}';

export interface IdempotentCall {
  principalId: string;
  requestId: string;
  op: string;
  input: unknown;
  /**
   * `false`: the response is not saved (it contains a secret, e.g. a plaintext token):
   * a repeat gets `conflict` with a `reason` instead of the response.
   */
  storeResponse: boolean;
  withheldReason?: string;
  /** Called inside the transaction before returning the saved response; may throw. */
  onReplay?: (response: unknown) => void;
}

/**
 * Runs `fn` at most once per (principal, request_id). `fn` is synchronous and runs
 * inside the same transaction as the idempotency write: on error nothing is saved.
 */
export function withIdempotency<T>(core: Core, call: IdempotentCall, fn: () => T): T {
  const hash = inputHash(call.input);
  try {
    return core.db
      .transaction((): T => {
        const prev = getIdempotency(core.db, call.principalId, call.requestId);
        if (prev) {
          if (prev.op !== call.op || prev.input_hash !== hash) throw new OpError('idempotency_mismatch');
          if (prev.response === WITHHELD) throw conflict(call.withheldReason ?? 'already_done');
          const response = JSON.parse(prev.response) as T;
          call.onReplay?.(response);
          return response;
        }
        const result = fn();
        if (result instanceof Promise) throw new Error('idempotent handlers must be synchronous');
        insertIdempotency(core.db, {
          principal_id: call.principalId,
          request_id: call.requestId,
          op: call.op,
          input_hash: hash,
          response: call.storeResponse ? JSON.stringify(result) : WITHHELD,
          created_at: core.now(),
        });
        return result;
      })
      .immediate();
  } catch (err) {
    // The rollback may have undone grant changes already counted: the snapshot will be rebuilt.
    bumpAcl(core);
    throw err;
  }
}
