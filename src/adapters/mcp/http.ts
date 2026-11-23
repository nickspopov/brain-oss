// MCP streamable HTTP: POST /mcp/v1, stateless mode, JSON response without SSE.
// Each HTTP request gets its own SDK Server and a transport with sessionIdGenerator: undefined.
// The token is checked on every request: missing or invalid → HTTP 401 with `WWW-Authenticate: Bearer`.
// tools/list comes from the registry, tools/call → execute. No permission logic and no SQL here.
import type { Server as SdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport as SdkTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolRequestSchema as CallSchema, ListToolsRequestSchema as ListSchema } from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Caller, Executor } from '../../ops/execute.js';
import { SERVER_VERSION } from '../../version.js';
import { bearerToken, type AuthDeps } from '../http/auth.js';
import { sendCode } from '../http/envelope.js';
import { MCP_INSTRUCTIONS, toolResult, toolsFor } from './tools.js';

export const MCP_PATH = '/mcp/v1';

/** The SDK is loaded on the first MCP request: the CLI and processes without MCP clients never load it. */
let sdkPromise: Promise<{
  Server: typeof SdkServer;
  StreamableHTTPServerTransport: typeof SdkTransport;
  CallToolRequestSchema: typeof CallSchema;
  ListToolsRequestSchema: typeof ListSchema;
}> | undefined;

function loadSdk(): NonNullable<typeof sdkPromise> {
  sdkPromise ??= Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]).then(([server, http, types]) => ({
    Server: server.Server,
    StreamableHTTPServerTransport: http.StreamableHTTPServerTransport,
    CallToolRequestSchema: types.CallToolRequestSchema,
    ListToolsRequestSchema: types.ListToolsRequestSchema,
  }));
  return sdkPromise;
}

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const METHOD_RE = /^[a-zA-Z/_]{1,48}$/;

/** What kind of call arrived (for the audit row of a failed authentication): the tool name or `mcp_<method>`. */
function auditName(body: unknown): string {
  const msg = body;
  if (!msg || typeof msg !== 'object') return 'mcp_request';
  const { method, params } = msg as { method?: unknown; params?: { name?: unknown } };
  if (method === 'tools/call' && typeof params?.name === 'string' && TOOL_NAME_RE.test(params.name)) return params.name;
  return typeof method === 'string' && METHOD_RE.test(method) ? `mcp_${method.replace(/\//g, '_')}` : 'mcp_request';
}

function requestIdOf(args: unknown): string | undefined {
  const v = args && typeof args === 'object' ? (args as { request_id?: unknown }).request_id : undefined;
  return typeof v === 'string' ? v.slice(0, 128) : undefined;
}

export interface McpDeps extends Pick<AuthDeps, 'authenticate' | 'authFailed'> {
  executor: Executor;
  /** `read`-class limit for requests other than tools/call; a refusal is ms until the next attempt. */
  limitRequest: (principalId: string) => number;
}

export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  app.post(MCP_PATH, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    // JSON-RPC batches (an array of messages) were removed in MCP 2025-06-18: one request with
    // dozens of tools/call bypassed the limits and built a response of hundreds of megabytes in memory.
    if (Array.isArray(req.body)) {
      return reply
        .code(400)
        .send({ jsonrpc: '2.0', error: { code: -32600, message: 'Batch requests are not supported: send one JSON-RPC message per request.' }, id: null });
    }
    // Bearer only: the UI session cookie is not accepted here, a token in the query string is refused.
    const token = bearerToken(req);
    const auth = typeof token === 'string' ? deps.authenticate(token, req.ip ?? null) : null;
    if (!auth) {
      const wait = deps.authFailed(req.ip ?? null, auditName(req.body), token !== undefined, 'mcp');
      return wait > 0 ? sendCode(reply, 'rate_limited', { retry_after_ms: wait }) : sendCode(reply, 'unauthenticated');
    }
    const base: Omit<Caller, 'requestId'> = { principal: auth.principal, tokenId: auth.tokenId, via: 'mcp', ip: req.ip ?? null };
    // tools/call consumes the limit in execute; initialize, tools/list and the rest are counted here, as read.
    if ((req.body as { method?: unknown } | null)?.method !== 'tools/call') {
      const wait = deps.limitRequest(auth.principal.id);
      if (wait > 0) return sendCode(reply, 'rate_limited', { retry_after_ms: wait });
    }
    await handle(req, reply, base, deps.executor);
  });

  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(405)
      .header('Allow', 'POST')
      .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless, use POST.' }, id: null });
  app.get(MCP_PATH, notAllowed);
  app.delete(MCP_PATH, notAllowed);
}

async function handle(req: FastifyRequest, reply: FastifyReply, base: Omit<Caller, 'requestId'>, executor: Executor): Promise<void> {
  const { Server, StreamableHTTPServerTransport, CallToolRequestSchema, ListToolsRequestSchema } = await loadSdk();
  const server = new Server({ name: 'brain', version: SERVER_VERSION }, { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolsFor(executor.advertisedOps(base)) }));
  // The client going away (or cancelling) releases a parked handoff_wait at once.
  const gone = new AbortController();
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments ?? {};
    const signal = AbortSignal.any([gone.signal, extra.signal]);
    const res = await executor.execute(request.params.name, args, { ...base, requestId: requestIdOf(args), signal });
    return toolResult(res);
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  reply.raw.on('close', () => {
    gone.abort();
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  // The SDK transport writes the response to the raw res; Fastify does not touch it.
  reply.hijack();
  await transport.handleRequest(req.raw, reply.raw, req.body);
}
