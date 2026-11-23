// Revocation, expiry and disabling take effect from the very next request.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueToken } from '../../src/core/tokens.js';
import { ADAPTERS, makeClient, type AdapterName, type Client } from '../helpers/clients/index.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';
import { pending, Unimplemented } from '../helpers/pending.js';

const UNAUTHENTICATED = { ok: false, error: { code: 'unauthenticated', message: 'Authentication required.', retryable: false } };

describe.each(ADAPTERS)('a02 revocation via %s', (adapter: AdapterName) => {
  let h: Harness;
  let w: World;
  let hermes: Client;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h, adapter);
    hermes = w.client('alice-helper');
  });
  afterEach(async () => {
    // One audit line per operation call made by the scenario.
    expect(h.auditedCalls()).toBe(h.opCalls());
    await h.close();
  });

  it('admin_token_revoke → the very next request is unauthenticated', async () => {
    expect((await hermes.call<{ principal: { name: string } }>('whoami')).principal.name).toBe('alice-helper');
    await w.client('alice').call('admin_token_revoke', { id: w.tokenIds['alice-helper'] });
    const r = await hermes.raw('whoami');
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTHENTICATED);
    // Other tokens and principals are unaffected.
    expect((await w.client('alphabot').call<{ principal: { name: string } }>('whoami')).principal.name).toBe('alphabot');
  });

  it('an expired token is refused from the first request after expiry (clock)', async () => {
    const t = issueToken(h.core, w.principals['alice-helper'].id, { days: 1 });
    const c = makeClient(adapter, h, t.token);
    expect((await c.raw('whoami')).status).toBe(200);
    h.clock.advance(24 * 60 * 60 * 1000 - 60_000);
    expect((await c.raw('whoami')).status).toBe(200);
    h.clock.advance(60_000);
    const r = await c.raw('whoami');
    expect(r.status).toBe(401);
    expect(r.body).toEqual(UNAUTHENTICATED);
  });

  it('admin_principal_disable → all tokens of the principal stop working at once; enable restores', async () => {
    const second = issueToken(h.core, w.principals['alice-helper'].id).token;
    expect((await hermes.raw('whoami')).status).toBe(200);
    await w.client('alice').call('admin_principal_disable', { name: 'alice-helper' });
    expect((await hermes.raw('whoami')).body).toEqual(UNAUTHENTICATED);
    expect((await makeClient(adapter, h, second).raw('whoami')).body).toEqual(UNAUTHENTICATED);
    await w.client('alice').call('admin_principal_enable', { name: 'alice-helper' });
    expect((await hermes.raw('whoami')).status).toBe(200);
  });

  it('refusal reasons are indistinguishable: unknown, revoked by core, expired', async () => {
    const expired = issueToken(h.core, w.principals.alphabot.id, { days: 1 });
    h.clock.advanceDays(2);
    const bodies = new Set<string>();
    for (const token of ['brn_' + 'x'.repeat(43), expired.token, 'garbage']) {
      const r = await makeClient(adapter, h, token).raw('whoami');
      expect(r.status).toBe(401);
      bodies.add(JSON.stringify(r.body));
    }
    expect(bodies.size).toBe(1);
  });

  pending('MCPL (deferred from v1)', 'an open MCPL socket is closed with 4001 when its token is revoked', async () => {
    if (!ADAPTERS.includes('mcpl')) throw new Unimplemented('mcpl adapter');
    const socket = await openMcpl(h.url, w.tokens['alice-helper']);
    await w.client('alice').call('admin_token_revoke', { id: w.tokenIds['alice-helper'] });
    await socket.callTool('whoami', {}).catch(() => undefined);
    expect(await socket.closed).toBe(4001);
  });
});

/** There is no MCPL client: the adapter is deferred. */
async function openMcpl(_url: string, _token: string): Promise<{ callTool(name: string, args: unknown): Promise<unknown>; closed: Promise<number> }> {
  throw new Unimplemented('mcpl test client');
}
