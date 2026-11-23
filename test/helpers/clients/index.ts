// Adapters the acceptance tests run against: rest and mcp.
// MCPL is deferred.
import type { Harness } from '../harness.js';
import { Unimplemented } from '../pending.js';
import { McpClient } from './mcp.js';
import { RestClient } from './rest.js';
import type { AdapterName, Client } from './types.js';

export const ADAPTERS: readonly AdapterName[] = ['rest', 'mcp'];

export function makeClient(adapter: AdapterName, h: Harness, token: string | null): Client {
  switch (adapter) {
    case 'rest':
      return new RestClient(h.url, token);
    case 'mcp':
      return new McpClient(h.url, token);
    default:
      throw new Unimplemented(`${adapter} test client`);
  }
}

export * from './types.js';
