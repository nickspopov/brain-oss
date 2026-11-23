// The "expected to fail" marker only accepts a failure caused by a missing operation or route.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../helpers/clients/types.js';
import { isUnimplemented, Unimplemented } from '../helpers/pending.js';

const raw = { status: 404, headers: {}, text: '', body: { ok: false as const, error: { code: 'not_found', message: 'Not found.', retryable: false } } };

describe('pending marker', () => {
  it('accepts a missing operation or an explicit Unimplemented', () => {
    expect(isUnimplemented(new Unimplemented('route'))).toBe(true);
    expect(isUnimplemented(new ApiError('no_such_operation', raw, raw.body.error))).toBe(true);
  });

  it('rejects not_found of an existing operation and any other error', () => {
    expect(isUnimplemented(new ApiError('whoami', raw, raw.body.error))).toBe(false);
    expect(isUnimplemented(new ApiError('write', { ...raw, status: 409 }, { code: 'conflict', message: '', retryable: false }))).toBe(false);
    expect(isUnimplemented(new Error('assertion'))).toBe(false);
  });
});
