// Error model of contract v1. Codes are not changed or removed within v1.
// Lives in core/ so the core (guard, services) throws the same errors; ops/errors.ts re-exports them.
export const ERROR_HTTP = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  conflict: 409,
  idempotency_mismatch: 409,
  edit_failed: 422,
  secret_detected: 422,
  too_large: 413,
  quota_exceeded: 413,
  rate_limited: 429,
  purged: 410,
  unsupported: 400,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_HTTP;
export const ERROR_CODES = Object.keys(ERROR_HTTP) as ErrorCode[];

/** Messages do not echo the input (slug, path, id) and are the same for "no such thing" and "no permission". */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  unauthenticated: 'Authentication required.',
  forbidden: 'Your role is not sufficient for this action.',
  not_found: 'Not found.',
  invalid_input: 'Input is invalid.',
  conflict: 'Conflict with the current state.',
  idempotency_mismatch: 'This request_id was already used with a different input.',
  edit_failed: 'Edit could not be applied.',
  secret_detected: 'Content looks like it contains a secret.',
  too_large: 'Too large.',
  quota_exceeded: 'Space quota exceeded.',
  rate_limited: 'Too many requests.',
  purged: 'This revision body was permanently erased.',
  unsupported: 'Operation is not applicable here.',
  internal: 'Internal error.',
};

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

export class OpError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, details?: Record<string, unknown>, message?: string) {
    super(message ?? defaultMessage(code, details));
    this.name = 'OpError';
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return ERROR_HTTP[this.code];
  }

  toBody(): ErrorBody {
    return errorBody(this.code, this.details, this.message);
  }
}

export function isRetryable(code: ErrorCode): boolean {
  return code === 'rate_limited' || code === 'internal';
}

export function errorBody(code: ErrorCode, details?: Record<string, unknown>, message?: string): ErrorBody {
  const body: ErrorBody = { code, message: message ?? defaultMessage(code, details), retryable: isRetryable(code) };
  if (details !== undefined) body.details = details;
  return body;
}

const MAX_LISTED_ISSUES = 5;

/**
 * Message of an error: for `invalid_input` with issues, the fields and rules that failed
 * ("Input is invalid: space: required; depth: must be 1–5."), never the values.
 */
export function defaultMessage(code: ErrorCode, details?: Record<string, unknown>): string {
  if (code !== 'invalid_input') return ERROR_MESSAGES[code];
  const issues = details?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return ERROR_MESSAGES[code];
  const parts = issues.slice(0, MAX_LISTED_ISSUES).map((i: { path?: unknown; message?: unknown }) => {
    const path = typeof i.path === 'string' && i.path !== '' ? i.path : 'input';
    const msg = typeof i.message === 'string' ? i.message.replace(/\.$/, '') : 'invalid';
    return `${path}: ${msg}`;
  });
  const more = issues.length > MAX_LISTED_ISSUES ? `; and ${issues.length - MAX_LISTED_ISSUES} more` : '';
  return `Input is invalid: ${parts.join('; ')}${more}.`;
}

/** Field names of an `invalid_input` error, for the audit row (names only, no values). */
export function invalidFields(details?: Record<string, unknown>): string[] {
  const issues = details?.issues;
  if (!Array.isArray(issues)) return [];
  const out = new Set<string>();
  for (const i of issues as { path?: unknown }[]) out.add(typeof i.path === 'string' && i.path !== '' ? i.path : 'input');
  return [...out].slice(0, 20);
}

export const notFound = (): OpError => new OpError('not_found');
export const forbidden = (requiredRole: string): OpError => new OpError('forbidden', { required_role: requiredRole });

/** Input error in the core: field path and rule text, without the entered value. */
export const invalidInput = (path: string, message: string): OpError =>
  new OpError('invalid_input', { issues: [{ path, message }] });

export const conflict = (reason: string, extra: Record<string, unknown> = {}): OpError =>
  new OpError('conflict', { reason, ...extra });
