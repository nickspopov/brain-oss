// scripts/inbox-poll.sh must parse and run under every /bin/sh an agent may have. macOS /bin/sh is
// bash 3.2 in POSIX mode, which mis-scans a backquote or a heredoc inside $(...); it is not on CI machines, so a
// static lint guards those constructs, and the script is parsed and run (--help, a mocked level poll, a mocked
// cursor poll, BRAIN_HEADERS validation) under dash, bash --posix, bash, and busybox sh / zsh when installed.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/inbox-poll.sh');
const TEXT = fs.readFileSync(SCRIPT, 'utf8');

function has(cmd: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
}

const SHELLS: { name: string; argv: string[]; required: boolean }[] = [
  { name: 'dash', argv: ['dash'], required: true },
  { name: 'bash --posix', argv: ['bash', '--posix'], required: true },
  { name: 'bash', argv: ['bash'], required: true },
  { name: 'busybox sh', argv: ['busybox', 'sh'], required: false },
  { name: 'zsh (sh emulation)', argv: ['zsh', '--emulate', 'sh'], required: false },
];

describe('static lint: no construct bash 3.2 mis-parses', () => {
  it('no backquote anywhere in the file (code or comments)', () => {
    const lines = TEXT.split('\n').flatMap((l, i) => (l.includes('`') ? [i + 1] : []));
    expect(lines).toEqual([]);
  });

  it('no heredoc inside $(...) — and no heredoc at all, so none can drift into one', () => {
    expect(TEXT).not.toMatch(/\$\([^)]*<</);
    // `<<` outside arithmetic $((...)) is a heredoc operator.
    const lines = TEXT.split('\n').flatMap((l, i) => (l.replace(/\$\(\([^)]*\)\)/g, '').includes('<<') ? [i + 1] : []));
    expect(lines).toEqual([]);
  });
});

type Seen = { url: string; headers: http.IncomingHttpHeaders };
let server: http.Server;
let base = '';
const seen: Seen[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: { ...req.headers } });
    if (req.headers.authorization !== 'Bearer brn_test') {
      res.writeHead(401).end('{}');
      return;
    }
    const since = new URL(req.url ?? '/', 'http://x').searchParams.get('since');
    const body = since
      ? { waiting: 1, answered: 0, events: [{ kind: 'inbound' }, { kind: 'answered' }], more: false, next_cursor: 'cur_2' }
      : { waiting: 2, answered: 1, next_cursor: 'cur_1' };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Async: the mock server runs in this process, so a synchronous spawn would block it.
function run(argv: string[], args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(argv[0]!, [...argv.slice(1), SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', BRAIN_URL: base, BRAIN_TOKEN: 'brn_test', ...env },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

for (const sh of SHELLS) {
  const present = has(sh.argv[0]!);
  describe.skipIf(!present && !sh.required)(`under ${sh.name}`, () => {
    it('is installed (required shells)', () => {
      expect(present).toBe(true);
    });

    it('parses (-n)', () => {
      const r = spawnSync(sh.argv[0]!, [...sh.argv.slice(1), '-n', SCRIPT], { encoding: 'utf8' });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    });

    it('--help prints the usage and exits 2', async () => {
      const r = await run(sh.argv, ['--help']);
      expect(r.code).toBe(2);
      expect(r.out).toBe('');
      expect(r.err).toContain('Brain inbox poll');
      expect(r.err).toContain('BRAIN_HEADERS');
      expect(r.err).toContain('3  this run ended');
    });

    it('a level poll: token and BRAIN_HEADERS (a backquote in a header name is a valid token) reach the server', async () => {
      seen.length = 0;
      const r = await run(sh.argv, [], { BRAIN_HEADERS: '{"X-Odd`Name|~":"v1","Authorization":"no"}' });
      expect(r.err).toContain('extra Authorization header is ignored');
      expect(r.out).toBe('Brain inbox: 2 waiting, 1 answered\n');
      expect(r.code).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe('/api/v1/inbox');
      expect(seen[0]!.headers.authorization).toBe('Bearer brn_test');
      expect(seen[0]!.headers['x-odd`name|~']).toBe('v1');
    });

    it('a cursor poll prints the events line and cursor=<next>', async () => {
      seen.length = 0;
      const r = await run(sh.argv, ['--since', 'cur_0', '--events', 'both']);
      expect(r.out).toBe('Brain inbox: 2 new events (inbound 1, updated 0, answered 1); 1 waiting, 0 answered\ncursor=cur_2\n');
      expect(r.code).toBe(0);
      expect(seen[0]!.url).toBe('/api/v1/inbox?since=cur_0&events=both');
    });

    it('rejects an invalid header name without sending a request', async () => {
      seen.length = 0;
      const r = await run(sh.argv, [], { BRAIN_HEADERS: '{"Bad Name":"secret-v"}' });
      expect(r.code).toBe(2);
      expect(r.err).toBe('inbox-poll: BRAIN_HEADERS has an invalid header name\n');
      expect(seen).toHaveLength(0);
    });
  });
}
