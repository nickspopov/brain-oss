// MCP client of the test matrix: the same call/raw interface as REST, on top of
// JSON-RPC `tools/call` at POST /mcp/v1. The server is sessionless, so each call is a single HTTP request
// without initialize (the protocol allows this in stateless mode; the full cycle with initialize is
// checked by test/server/mcp.test.ts using the SDK client).
//
// The response is normalised to the standard `{ok, ...}` envelope so acceptance tests run unchanged:
// - HTTP other than 200 (401, 429, 413, 503): the body is already the adapter's envelope;
// - `isError: true`: `{ok: false, error: structuredContent.error}`, status is the HTTP code for that `code`;
// - success: `{ok: true, result: structuredContent}`.
// `text` is this envelope plus a `rendered` field (the `content` text the LLM sees): the isolation test
// looks for canaries there too. Encrypted cursors in `rendered` are replaced with `<cursor>`: tests don't compare them.
import { hasOp } from '../../../src/ops/registry.js';
import { ERROR_HTTP, type ErrorCode } from '../../../src/ops/errors.js';
import { Unimplemented } from '../pending.js';
import { ApiError, type Client, type Envelope, type ErrorPayload, type RawResponse, type RawRequest } from './types.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export class McpClient implements Client {
  readonly adapter = 'mcp' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null,
  ) {}

  request(op: string, input: unknown = {}): RawRequest {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    };
    if (this.token !== null) headers.authorization = `Bearer ${this.token}`;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: op, arguments: input } });
    return { url: `${this.baseUrl}/mcp/v1`, headers, body };
  }

  async raw<T = unknown>(op: string, input: unknown = {}): Promise<RawResponse<T>> {
    if (!hasOp(op) && !op.startsWith('no_such')) throw new Unimplemented(`operation ${op}`);
    const req = this.request(op, input);
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    if (res.status !== 200) {
      // Rejected before the protocol (authentication, rate limit, body size): adapter envelope as is.
      return { status: res.status, headers, text, body: JSON.parse(text) as Envelope<T> };
    }
    const msg = JSON.parse(text) as { result?: ToolResult; error?: { code: number; message: string } };
    if (msg.error || !msg.result) throw new Error(`MCP protocol error for ${op}: ${JSON.stringify(msg.error)}`);
    const r = msg.result;
    const rendered = (r.content ?? []).map((c) => c.text ?? '').join('\n');
    let status = 200;
    let body: Envelope<T>;
    if (r.isError) {
      const error = (r.structuredContent as { error: ErrorPayload } | undefined)?.error;
      if (!error) throw new Error(`MCP error result without structuredContent.error for ${op}`);
      if (!rendered.startsWith(`ERROR ${error.code}: ${error.message}`)) throw new Error(`MCP error text does not name the code for ${op}`);
      status = ERROR_HTTP[error.code as ErrorCode];
      body = { ok: false, error };
    } else {
      if (!r.structuredContent) throw new Error(`MCP result without structuredContent for ${op}`);
      body = { ok: true, result: r.structuredContent as T };
    }
    const normalized = body.ok ? hideCursors(rendered, body.result) : rendered;
    return { status, headers, text: JSON.stringify({ ...body, rendered: normalized }), body };
  }

  async call<T = unknown>(op: string, input: unknown = {}): Promise<T> {
    const r = await this.raw<T>(op, input);
    if (r.body.ok) return r.body.result;
    throw new ApiError(op, r, r.body.error);
  }
}

function hideCursors(text: string, result: unknown): string {
  if (!result || typeof result !== 'object') return text;
  let out = text;
  for (const key of ['cursor', 'next_cursor']) {
    const v = (result as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.length > 0) out = out.split(v).join('<cursor>');
  }
  return out;
}
