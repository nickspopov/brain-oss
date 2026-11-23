// Scenarios written before the code. While the operation is missing, the scenario is an "expected failure":
// the test is green only if the scenario failed precisely because of a missing operation, route or
// adapter. Any other reason makes the test red. If the scenario starts passing, the test is red too:
// the change that implements the operation must remove the marker (replace `pending(...)` with `it(...)`).
import { it } from 'vitest';
import { hasOp } from '../../src/ops/registry.js';
import { ApiError } from './clients/types.js';

/** Explicit "not there yet" signal: route, adapter, CLI command. */
export class Unimplemented extends Error {
  constructor(what: string) {
    super(`not implemented yet: ${what}`);
    this.name = 'Unimplemented';
  }
}

/** Whether the scenario failed because the called operation is not in the registry. */
export function isUnimplemented(err: unknown): boolean {
  if (err instanceof Unimplemented) return true;
  return err instanceof ApiError && err.code === 'not_found' && err.op !== undefined && !hasOp(err.op);
}

/** An operation without which the scenario makes no sense (e.g. checking `render`). */
export function requireOp(name: string): void {
  if (!hasOp(name)) throw new Unimplemented(`operation ${name}`);
}

/**
 * Core capabilities without an operation of their own (secret scanner, limits): the scenario checks them
 * through existing operations (`write`), so "no operation" does not distinguish them. The change that
 * implements a capability adds its name here and removes the `pending` marker from the scenarios.
 */
export const IMPLEMENTED_FEATURES: ReadonlySet<string> = new Set<string>(['secret-scanner']);

export function requireFeature(name: 'secret-scanner'): void {
  if (!IMPLEMENTED_FEATURES.has(name)) throw new Unimplemented(`feature ${name}`);
}

export function pending(pr: string, name: string, fn: () => Promise<void> | void, timeout?: number): void {
  it(
    `[expected to fail until ${pr}] ${name}`,
    async () => {
      try {
        await fn();
      } catch (err) {
        if (isUnimplemented(err)) return;
        throw new Error(`scenario failed for an unexpected reason (expected a missing operation or route): ${String(err)}`, {
          cause: err,
        });
      }
      throw new Error(`scenario passes now: remove the pending marker (${pr}) and turn it into a regular test`);
    },
    timeout,
  );
}
