// Common interface of the test clients: rest, mcp; mcpl is deferred.
export type AdapterName = 'rest' | 'mcp' | 'mcpl';

export interface ErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

export type Envelope<T = unknown> = { ok: true; result: T } | { ok: false; error: ErrorPayload };

export interface RawResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  /** Body as is: the isolation test searches it for canaries. */
  text: string;
  body: Envelope<T>;
}

export class ApiError extends Error {
  readonly op: string | undefined;
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  readonly raw: RawResponse;

  constructor(op: string | undefined, raw: RawResponse, error: ErrorPayload) {
    super(`${op ?? 'request'} failed: ${error.code}: ${error.message}`);
    this.name = 'ApiError';
    this.op = op;
    this.status = raw.status;
    this.code = error.code;
    this.details = error.details;
    this.raw = raw;
  }
}

/** Raw HTTP request for an operation call (for scenarios with a dropped connection, a04). */
export interface RawRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface Client {
  readonly adapter: AdapterName;
  /** How this adapter would send the call: URL, headers, body. */
  request(op: string, input?: unknown): RawRequest;
  /** Success returns `result`; an error throws ApiError. */
  call<T = unknown>(op: string, input?: unknown): Promise<T>;
  /** The whole response, without throwing. */
  raw<T = unknown>(op: string, input?: unknown): Promise<RawResponse<T>>;
}
