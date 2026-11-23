// MCP SDK client for scenarios with real transports (a10, stdio): streamable HTTP at /mcp/v1
// or stdio via a brain-mcp process, the way a harness launches it.
import path from 'node:path';
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const TSX = path.join(ROOT, 'node_modules/.bin/tsx');
const BIN = path.join(ROOT, 'src/adapters/stdio/bin.ts');

export type AgentTransport = 'http' | 'stdio';

/** brain-mcp processes write to stderr: collected to check that the token did not leak there. */
export interface Connected {
  client: SdkClient;
  stderr: () => string;
}

export async function connectAgent(h: { url: string }, token: string, transport: AgentTransport): Promise<Connected> {
  const client = new SdkClient({ name: 'a10-agent', version: '0.0.0' });
  let err = '';
  if (transport === 'http') {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${h.url}/mcp/v1`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
    );
  } else {
    const t = new StdioClientTransport({
      command: TSX,
      args: [BIN],
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', BRAIN_URL: h.url, BRAIN_TOKEN: token },
      stderr: 'pipe',
    });
    t.stderr?.on('data', (d: Buffer) => {
      err += d.toString('utf8');
    });
    await client.connect(t, { timeout: 60_000 });
  }
  return { client, stderr: () => err };
}

/** tools/call; result as is (not validated against outputSchema). */
export async function tool(c: SdkClient, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await c.request({ method: 'tools/call', params: { name, arguments: args } }, CallToolResultSchema, { timeout: 60_000 })) as CallToolResult;
}

export async function ok<T>(c: SdkClient, name: string, args: Record<string, unknown> = {}): Promise<{ out: T; text: string }> {
  const r = await tool(c, name, args);
  const text = r.content.map((x) => (x.type === 'text' ? x.text : '')).join('\n');
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return { out: r.structuredContent as T, text };
}

export const textOf = (r: CallToolResult): string => r.content.map((x) => (x.type === 'text' ? x.text : '')).join('\n');
