// Byte routes, export and import.
import http from 'node:http';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tarPack } from '../../src/core/export/tar.js';
import type { ExportResult, HistoryResult, ReadResult, WriteResult } from '../helpers/api.js';
import { makeClient, type Client } from '../helpers/clients/index.js';
import { plainArchive, untar, untarBytes } from '../helpers/archive.js';
import { assertNoMarkers, buildWorld, RANDOM_ID, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

describe('byte routes, export and import', () => {
  let h: Harness;
  let w: World;
  let claude: Client;
  let alice: Client;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h, 'rest');
    claude = w.client('alice-assistant');
    alice = w.client('alice');
  });
  afterEach(async () => {
    expect(h.auditedCalls()).toBe(h.opCalls());
    expect(h.doctor()).toEqual({ ok: true, problems: [] });
    await h.close();
  });

  const req = (token: string, method: string, url: string, body?: Uint8Array, headers: Record<string, string> = {}) =>
    fetch(`${h.url}${url}`, { method, headers: { authorization: `Bearer ${token}`, ...headers }, ...(body ? { body } : {}) });

  async function json(res: Response): Promise<{ status: number; body: { ok: boolean; result?: never; error?: { code: string; details?: Record<string, unknown> } } }> {
    return { status: res.status, body: (await res.json()) as never };
  }

  describe('authentication before the body is read', () => {
    /**
     * A request declaring a body of `declared` bytes, of which only the start is sent; the response must
     * arrive without waiting for (or reading) the rest. Previously the whole body was read before the 401.
     */
    function partial(method: string, url: string, declared: number, headers: Record<string, string> = {}): Promise<{ status: number; body: string; ms: number }> {
      const started = performance.now();
      return new Promise((resolve, reject) => {
        const r = http.request(`${h.url}${url}`, { method, headers: { 'content-type': 'application/octet-stream', 'content-length': String(declared), ...headers } }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () => {
            r.destroy();
            resolve({ status: res.statusCode ?? 0, body, ms: performance.now() - started });
          });
        });
        r.on('error', reject);
        r.setTimeout(30_000, () => r.destroy(new Error('no response before the body was sent: the server waits for the body')));
        r.write(Buffer.alloc(64 * 1024));
      });
    }

    it('no token: import (200 MB declared) and upload (19 MB declared) answer 401 without the body', async () => {
      const imp = await partial('POST', '/api/v1/import?space=shared', 200 * 1024 * 1024);
      expect(imp.status).toBe(401);
      expect(JSON.parse(imp.body)).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
      const up = await partial('PUT', '/api/v1/files/shared/a.bin', 19 * 1024 * 1024);
      expect(up.status).toBe(401);
      const bad = await partial('PUT', '/api/v1/files/shared/a.bin', 19 * 1024 * 1024, { authorization: 'Bearer brn_wrong' });
      expect(bad.status).toBe(401);
    });

    it('import by anyone but a superadmin is refused before the archive is read, same answer as a missing route op', async () => {
      const r = await partial('POST', '/api/v1/import?space=shared', 200 * 1024 * 1024, { authorization: `Bearer ${w.tokens['alice-assistant']}` });
      expect(r.status).toBe(404);
      expect(JSON.parse(r.body)).toMatchObject({ ok: false, error: { code: 'not_found' } });
    });
  });

  describe('PUT /api/v1/files', () => {
    it('uploads a file through commit; update needs expected_rev; request_id replays', async () => {
      const r1 = await json(await req(w.tokens['alice-helper'], 'PUT', '/api/v1/files/shared/assets/My%20Pixel.png?message=pixel', PNG));
      expect(r1.status).toBe(200);
      const doc = (r1.body.result as unknown as WriteResult).doc!;
      expect(doc).toMatchObject({ path: 'assets/My Pixel.png', kind: 'file', mime: 'image/png', rev: 1, size: PNG.length });
      const again = await json(await req(w.tokens['alice-helper'], 'PUT', '/api/v1/files/shared/assets/My%20Pixel.png', Buffer.from('other')));
      expect(again.status).toBe(409);
      expect(again.body.error?.details?.reason).toBe('expected_rev_required');
      const url = '/api/v1/files/shared/assets/My%20Pixel.png?expected_rev=1&request_id=upload-0001';
      const v2 = await json(await req(w.tokens['alice-helper'], 'PUT', url, Buffer.from('GIF89a-ish bytes')));
      expect(v2.status).toBe(200);
      const replay = await json(await req(w.tokens['alice-helper'], 'PUT', url, Buffer.from('GIF89a-ish bytes')));
      expect(replay.body).toEqual(v2.body);
      const mismatch = await json(await req(w.tokens['alice-helper'], 'PUT', url, Buffer.from('different')));
      expect(mismatch.body.error?.code).toBe('idempotency_mismatch');
      const hist = await w.client('alice-helper').call<HistoryResult>('history', { id: doc.id });
      expect(hist.revisions.map((r) => r.rev)).toEqual([2, 1]);
    });

    it('reader gets forbidden, hidden space is identical to a missing one, size limit holds', async () => {
      const alphabot = w.tokens.alphabot;
      expect((await json(await req(alphabot, 'PUT', '/api/v1/files/shared/x.bin', PNG))).body.error?.code).toBe('forbidden');
      const hidden = await req(alphabot, 'PUT', '/api/v1/files/proj-beta/x.bin', PNG);
      const missing = await req(alphabot, 'PUT', '/api/v1/files/no-such-space/x.bin', PNG);
      expect({ s: hidden.status, t: await hidden.text() }).toEqual({ s: missing.status, t: await missing.text() });
      expect((await req('brn_bad', 'PUT', '/api/v1/files/shared/x.bin', PNG)).status).toBe(401);
      const big = Buffer.alloc(h.config.limits.maxFileBytes + 1);
      const tooLarge = await json(await req(w.tokens['alice-helper'], 'PUT', '/api/v1/files/shared/big.bin', big));
      expect(tooLarge.status).toBe(413);
      expect(tooLarge.body.error?.code).toBe('too_large');
    });
  });

  describe('GET /api/v1/docs/{id}/raw', () => {
    it('returns the body as an attachment with nosniff, any revision', async () => {
      const a = await claude.call<WriteResult>('write', { space: 'shared', path: 'notes/page.html', content: '<script>alert(1)</script>\n', message: 'html' });
      await claude.call('write', { space: 'shared', path: 'notes/page.html', content: '<b>v2</b>\n', expected_rev: 1, message: 'v2' });
      const head = await req(w.tokens.alphabot, 'GET', `/api/v1/docs/${a.doc!.id}/raw`);
      expect(head.status).toBe(200);
      expect(head.headers.get('content-disposition')).toMatch(/^attachment; filename="page.html"/);
      expect(head.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await head.text()).toBe('<b>v2</b>\n');
      const v1 = await req(w.tokens.alphabot, 'GET', `/api/v1/docs/${a.doc!.id}/raw?rev=1`);
      expect(await v1.text()).toBe('<script>alert(1)</script>\n');
      expect((await req(w.tokens.alphabot, 'GET', `/api/v1/docs/${a.doc!.id}/raw?rev=x`)).status).toBe(400);
      const f = await w.client('alice-helper').call<WriteResult>('write', { space: 'shared', path: 'p.png', content_base64: PNG.toString('base64'), message: 'png' });
      const png = await req(w.tokens.alphabot, 'GET', `/api/v1/docs/${f.doc!.id}/raw`);
      expect(png.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await png.arrayBuffer()).equals(PNG)).toBe(true);
      const missing = await req(w.tokens.alphabot, 'GET', `/api/v1/docs/${RANDOM_ID}/raw`);
      expect(missing.status).toBe(404);
    });
  });

  describe('export', () => {
    async function populate(): Promise<void> {
      await claude.call('write', { space: 'shared', path: 'a.md', content: '# A\n', message: 'a' });
      await claude.call('write', { space: 'shared', path: 'private/p.md', content: '# Private canary-zz\n', message: 'p' });
    }

    it('head needs read, full needs admin; only the creator downloads; the link expires', async () => {
      await populate();
      const head = await w.client('alphabot').call<ExportResult>('export', { space: 'shared' });
      expect(head.download_path).toBe(`/api/v1/exports/${head.export_id}`);
      const full = await w.client('alphabot').raw('export', { space: 'shared', mode: 'full' });
      expect(full.status).toBe(403);
      const own = await req(w.tokens.alphabot, 'GET', head.download_path);
      expect(own.status).toBe(200);
      expect(own.headers.get('content-type')).toBe('application/gzip');
      const files = await untar(new Uint8Array(await own.arrayBuffer()));
      expect(Object.keys(files).sort()).toEqual(['brain-export/manifest.json', 'brain-export/tree/a.md', 'brain-export/tree/private/p.md']);
      expect((await req(w.tokens['alice-helper'], 'GET', head.download_path)).status).toBe(404);
      h.clock.advance(61 * 60 * 1000);
      expect((await req(w.tokens.alphabot, 'GET', head.download_path)).status).toBe(404);
    });

    it('narrow none applies to a space admin too; narrowing after export makes the link not_found', async () => {
      await populate();
      w.grant('shared', { principal: 'alice-assistant' }, 'none', { path: 'private/' });
      const exp = await claude.call<ExportResult>('export', { space: 'shared', mode: 'full' });
      const files = untarBytes(new Uint8Array(await (await req(w.tokens['alice-assistant'], 'GET', exp.download_path)).arrayBuffer()));
      const all = [...files.keys()].join('\n') + [...files.values()].map((b) => b.toString('utf8')).join('\n');
      assertNoMarkers(all, ['canary-zz', 'private/p.md'], 'full export with narrow none');

      const before = await w.client('alphabot').call<ExportResult>('export', { space: 'shared' });
      w.grant('shared', { principal: 'alphabot' }, 'none', { path: 'private/' });
      const after = await req(w.tokens.alphabot, 'GET', before.download_path);
      expect(after.status).toBe(404);
      assertNoMarkers(await after.text(), ['canary-zz'], 'download after narrowing');
      // A new export no longer contains the hidden document.
      const again = await w.client('alphabot').call<ExportResult>('export', { space: 'shared' });
      const files2 = await untar(new Uint8Array(await (await req(w.tokens.alphabot, 'GET', again.download_path)).arrayBuffer()));
      expect(Object.keys(files2).sort()).toEqual(['brain-export/manifest.json', 'brain-export/tree/a.md']);
    });

    it('exports of a past moment are not supported', async () => {
      await populate();
      const r = await claude.raw('export', { space: 'shared', at: '2020-01-01T00:00:00.000Z' });
      expect(r.status).toBe(400);
      expect(JSON.parse(r.text).error.details.reason).toBe('export_at_past');
    });
  });

  describe('import', () => {
    async function importArchive(token: string, archive: Uint8Array, query: string) {
      return json(await req(token, 'POST', `/api/v1/import?${query}`, archive, { 'content-type': 'application/gzip' }));
    }

    it('only the superadmin; agents (even with the admin capability) get not_found', async () => {
      const archive = await plainArchive({ 'n.md': '# N\n' });
      const agent = await importArchive(w.tokens['alice-assistant'], archive, 'space=imp&mode=restore');
      expect(agent.status).toBe(404);
      const ok = await importArchive(w.tokens.alice, archive, 'space=imp&mode=restore');
      expect(ok.status).toBe(200);
      expect(ok.body.result).toMatchObject({ space: 'imp', documents: 1, revisions: 1 });
      const read = await alice.call<ReadResult>('read', { space: 'imp', path: 'n.md' });
      expect(read.content).toBe('# N\n');
      expect(read.revision).toMatchObject({ rev: 1, kind: 'import', author: { name: 'alice' }, created_at: '2026-11-01T10:00:00.000Z' });
      const taken = await importArchive(w.tokens.alice, archive, 'space=imp&mode=restore');
      expect(taken.body.error?.details?.reason).toBe('slug_taken');
      const ids = await importArchive(w.tokens.alice, archive, 'space=imp2&mode=restore');
      expect(ids.body.error?.details?.reason).toBe('ids_taken');
      const asNew = await importArchive(w.tokens.alice, archive, 'space=imp2&mode=as-new');
      expect(asNew.status).toBe(200);
      const copy = await alice.call<ReadResult>('read', { space: 'imp2', path: 'n.md' });
      expect(copy.doc.id).not.toBe(read.doc.id);
    });

    it('rejects unsafe archives: traversal, absolute paths, links, bad hashes, garbage', async () => {
      const gz = (entries: { name: string; data: Buffer }[]) => zlib.gzipSync(tarPack(entries.map((e) => ({ ...e, mtime: 0 }))));
      const bad = async (archive: Uint8Array) => (await importArchive(w.tokens.alice, archive, 'space=bad&mode=restore')).body.error?.code;
      expect(await bad(gz([{ name: 'brain-export/../../etc/x', data: Buffer.from('x') }]))).toBe('invalid_input');
      expect(await bad(gz([{ name: '/etc/passwd', data: Buffer.from('x') }]))).toBe('invalid_input');
      const link = tarPack([{ name: 'brain-export/l', data: Buffer.alloc(0), mtime: 0 }]);
      link[156] = '2'.charCodeAt(0);
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : link[i]!;
      link.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
      expect(await bad(zlib.gzipSync(link))).toBe('invalid_input');
      expect(await bad(Buffer.from('not a gzip'))).toBe('invalid_input');
      // Tampered body: the hash does not match.
      const good = untarBytes(await plainArchive({ 'n.md': '# N\n' }));
      good.set('brain-export/tree/n.md', Buffer.from('# M\n'));
      expect(await bad(gz([...good].map(([name, data]) => ({ name, data }))))).toBe('invalid_input');
      // Nothing was created.
      expect((await alice.raw('list', { space: 'bad' })).status).toBe(404);
    });

    it('secrets stop the import unless the superadmin confirms them', async () => {
      const key = ['AKIA', 'Z7QXRM3PLKWN5TBV'].join('');
      const archive = await plainArchive({ 'k.md': `# K\n\naws ${key}\n` });
      const stopped = await importArchive(w.tokens.alice, archive, 'space=keys&mode=restore');
      expect(stopped.status).toBe(422);
      const ok = await importArchive(w.tokens.alice, archive, 'space=keys&mode=restore&confirm_secrets=1');
      expect(ok.status).toBe(200);
      expect(ok.body.result).toMatchObject({ secrets_confirmed: 1 });
    });

    it('round trip keeps a deleted document and a purged revision', async () => {
      const a = await claude.call<WriteResult>('write', { space: 'shared', path: 'x.md', content: '# X\n\nsecret-ish v1\n', message: 'v1' });
      await claude.call('write', { space: 'shared', path: 'x.md', content: '# X\n\nv2\n', expected_rev: 1, message: 'v2' });
      await claude.call('write', { space: 'shared', path: 'x.md', content: '# X\n\nv3\n', expected_rev: 2, message: 'v3' });
      await alice.call('admin_purge', { id: a.doc!.id, revs: [1], reason: 'test' });
      const d = await claude.call<WriteResult>('write', { space: 'shared', path: 'gone.md', content: '# Gone\n', message: 'gone' });
      await claude.call('delete', { id: d.doc!.id });
      const exp = await claude.call<ExportResult>('export', { space: 'shared', mode: 'full' });
      const archive = new Uint8Array(await (await req(w.tokens['alice-assistant'], 'GET', exp.download_path)).arrayBuffer());
      const files = untarBytes(archive);
      expect([...files.values()].some((b) => b.includes('secret-ish'))).toBe(false);

      const t = await startHarness();
      try {
        const tw = buildWorld(t, 'rest');
        const res = await fetch(`${t.url}/api/v1/import?space=copy&mode=restore`, {
          method: 'POST',
          headers: { authorization: `Bearer ${tw.tokens.alice}` },
          body: archive,
        });
        expect(res.status).toBe(200);
        const c = makeClient('rest', t, tw.tokens.alice);
        const hist = await c.call<HistoryResult>('history', { id: a.doc!.id });
        expect(hist.revisions.map((r) => [r.rev, r.purged])).toEqual([
          [3, false],
          [2, false],
          [1, true],
        ]);
        expect((await c.raw('read', { id: a.doc!.id, rev: 1 })).status).toBe(410);
        expect((await c.call<ReadResult>('read', { id: a.doc!.id })).content).toBe('# X\n\nv3\n');
        const gone = await c.call<HistoryResult>('history', { id: d.doc!.id });
        expect(gone.revisions.map((r) => r.kind)).toEqual(['delete', 'create']);
        expect((await c.raw('read', { space: 'copy', path: 'gone.md' })).status).toBe(404);
        expect(t.doctor()).toEqual({ ok: true, problems: [] });
      } finally {
        await t.close();
      }
    });
  });
});
