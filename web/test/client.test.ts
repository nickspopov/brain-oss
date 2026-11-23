import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, rawUrl, setFetch, setUnauthenticatedHandler } from '../src/api/client';

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

afterEach(() => setUnauthenticatedHandler(() => {}));

describe('REST client', () => {
  it('posts the operation with X-Brain-Client, same-origin credentials and JSON body', async () => {
    const f = respond(200, { ok: true, result: { spaces: [] } });
    setFetch(f as unknown as typeof fetch);
    await expect(api.spaces()).resolves.toEqual({ spaces: [] });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/ops/spaces');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['X-Brain-Client']).toBe('brain-web');
    expect(init.body).toBe('{}');
  });

  it('turns the error envelope into ApiError with code, status and details', async () => {
    setFetch(respond(404, { ok: false, error: { code: 'not_found', message: 'Not found.', retryable: false } }) as unknown as typeof fetch);
    const err = await api.read({ space: 's', path: 'x.md' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('a 401 on an operation signals the app to show the login screen; a failed login does not', async () => {
    const lost = vi.fn();
    setUnauthenticatedHandler(lost);
    setFetch(respond(401, { ok: false, error: { code: 'unauthenticated', message: 'x', retryable: false } }) as unknown as typeof fetch);
    await expect(api.whoami()).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(lost).toHaveBeenCalledTimes(1);
    await expect(api.login('alice', 'bad')).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(api.session()).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('network failure and non-JSON answers are ApiError too', async () => {
    setFetch((async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    await expect(api.spaces()).rejects.toMatchObject({ code: 'network', status: 0 });
    setFetch((async () => new Response('<html>bad gateway</html>', { status: 502 })) as unknown as typeof fetch);
    await expect(api.spaces()).rejects.toMatchObject({ code: 'internal', status: 502 });
  });

  it('raw download URL', () => {
    expect(rawUrl('01ABC')).toBe('/api/v1/docs/01ABC/raw');
    expect(rawUrl('01ABC', 4)).toBe('/api/v1/docs/01ABC/raw?rev=4');
  });
});
