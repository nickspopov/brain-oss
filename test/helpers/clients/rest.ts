import { hasOp } from '../../../src/ops/registry.js';
import { Unimplemented } from '../pending.js';
import { ApiError, type Client, type Envelope, type RawRequest, type RawResponse } from './types.js';

export class RestClient implements Client {
  readonly adapter = 'rest' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null,
  ) {}

  request(op: string, input: unknown = {}): RawRequest {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token !== null) headers.authorization = `Bearer ${this.token}`;
    return { url: `${this.baseUrl}/api/v1/ops/${op}`, headers, body: JSON.stringify(input) };
  }

  async raw<T = unknown>(op: string, input: unknown = {}): Promise<RawResponse<T>> {
    // A scenario written before the code fails "for the expected reason", not on comparing two 404s.
    // Deliberately nonexistent operations used in checks are named no_such_*.
    if (!hasOp(op) && !op.startsWith('no_such')) throw new Unimplemented(`operation ${op}`);
    const req = this.request(op, input);
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
    const text = await res.text();
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      out[k] = v;
    });
    return { status: res.status, headers: out, text, body: JSON.parse(text) as Envelope<T> };
  }

  async call<T = unknown>(op: string, input: unknown = {}): Promise<T> {
    const r = await this.raw<T>(op, input);
    if (r.body.ok) return r.body.result;
    throw new ApiError(op, r, r.body.error);
  }
}
