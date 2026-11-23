#!/usr/bin/env node
// brain-mcp: an MCP server on stdio for harnesses that launch MCP servers as processes.
// Environment: BRAIN_URL (default http://127.0.0.1:7460), BRAIN_TOKEN (required),
// BRAIN_HEADERS (JSON object of extra headers your network requires; values are never printed).
// stdout carries the protocol: all messages go to stderr, the token is never printed.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_BRAIN_URL, extraHeaders, ProxyConfigError, startProxy } from './proxy.js';

const log = (line: string) => process.stderr.write(`${line}\n`);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  const proxy = await startProxy(
    { url: process.env.BRAIN_URL || DEFAULT_BRAIN_URL, token: process.env.BRAIN_TOKEN ?? '', headers: extraHeaders(process.env), log },
    transport,
  );
  const stop = () => {
    void proxy.close().finally(() => process.exit(0));
  };
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err: unknown) => {
  log(`brain-mcp: ${err instanceof ProxyConfigError ? err.message : err instanceof Error ? err.message : String(err)}`);
  process.exit(err instanceof ProxyConfigError ? 2 : 1);
});
