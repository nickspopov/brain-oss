// brain backup → unpack with plain tar → brain doctor is clean;
// brain vacuum; brain export and brain import (archive and --plain).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WriteResult } from '../helpers/api.js';
import { buildWorld } from '../helpers/fixtures.js';
import { startHarness } from '../helpers/harness.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TSX = path.join(ROOT, 'node_modules/.bin/tsx');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

let dataDir: string;
let work: string;

function brain(args: string[], dir = dataDir) {
  const r = spawnSync(TSX, [path.join(ROOT, 'src/cli.ts'), ...args], {
    env: { ...process.env, BRAIN_DATA_DIR: dir, BRAIN_DEV: '1', BRAIN_LOG_LEVEL: 'silent' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function counts(dir: string): Record<string, number> {
  const db = new Database(path.join(dir, 'brain.db'), { readonly: true });
  try {
    const n = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    return { spaces: n('spaces'), documents: n('documents'), revisions: n('revisions'), blobs: n('blobs') };
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  const h = await startHarness({ keepData: true });
  const w = buildWorld(h, 'rest');
  const claude = w.client('alice-assistant');
  const a = await claude.call<WriteResult>('write', { space: 'shared', path: 'guide.md', content: '# Guide\n\nv1\n', message: 'v1' });
  await claude.call('write', { space: 'shared', path: 'guide.md', content: '# Guide\n\nv2\n', expected_rev: 1, message: 'v2' });
  await claude.call('write', { space: 'shared', path: 'img/pixel.png', content_base64: PNG.toString('base64'), message: 'file' });
  await claude.call('delete', { id: a.doc!.id });
  dataDir = h.dataDir;
  await h.close();
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-backup-'));
});
afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

describe('brain backup, vacuum, export, import', () => {
  it('backup → tar -xf into an empty directory → doctor is clean and the data is the same', () => {
    const out = path.join(work, 'brain-backup.tar');
    const r = brain(['backup', '--out', out]);
    expect(r.code, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(dataDir, 'backup.lock'))).toBe(false);
    const restore = path.join(work, 'restore');
    fs.mkdirSync(restore);
    const tar = spawnSync('tar', ['-xf', out, '-C', restore], { encoding: 'utf8' });
    expect(tar.status, tar.stderr).toBe(0);
    expect(fs.existsSync(path.join(restore, 'brain.db-wal'))).toBe(false);
    expect(fs.readFileSync(path.join(restore, 'secret.key'))).toEqual(fs.readFileSync(path.join(dataDir, 'secret.key')));
    const blobFiles = fs.readdirSync(path.join(restore, 'blobs'), { recursive: true }).filter((f) => /[0-9a-f]{64}$/.test(String(f)));
    expect(blobFiles).toHaveLength(1);
    const doctor = brain(['doctor'], restore);
    expect(doctor.stdout, doctor.stderr).toBe('doctor: ok\n');
    expect(counts(restore)).toEqual(counts(dataDir));
  });

  it('vacuum keeps the database clean', () => {
    const r = brain(['vacuum']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^vacuum: \d+ → \d+ bytes\n$/);
    expect(brain(['doctor']).stdout).toBe('doctor: ok\n');
  });

  it('export full → import as-new; import --plain of a markdown tree', () => {
    const archive = path.join(work, 'shared.tar.gz');
    const e = brain(['export', '--space', 'shared', '--mode', 'full', '--out', archive]);
    expect(e.code, e.stderr).toBe(0);
    const i = brain(['import', archive, '--space', 'shared-copy', '--mode', 'as-new']);
    expect(i.code, i.stderr).toBe(0);
    expect(i.stdout).toMatch(/import: 2 document\(s\), 4 revision\(s\) into shared-copy/);
    expect(brain(['import', archive, '--space', 'shared', '--mode', 'restore']).code).toBe(2);

    const tree = path.join(work, 'tree');
    fs.mkdirSync(path.join(tree, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(tree, '.git'));
    fs.writeFileSync(path.join(tree, 'notes', 'a.md'), '# A\n\nfirst\n');
    fs.writeFileSync(path.join(tree, 'b.md'), '# B\n');
    fs.writeFileSync(path.join(tree, 'pic.png'), PNG);
    fs.writeFileSync(path.join(tree, '.git', 'config'), 'x');
    const p = brain(['import', '--plain', tree, '--space', 'notes']);
    expect(p.code, p.stderr).toBe(0);
    expect(p.stdout).toBe('import: 3 document(s) into notes\n');
    expect(brain(['doctor']).stdout).toBe('doctor: ok\n');
    const db = new Database(path.join(dataDir, 'brain.db'), { readonly: true });
    try {
      const rows = db
        .prepare("SELECT d.path, d.kind, r.rev, r.via FROM documents d JOIN spaces s ON s.id = d.space_id JOIN revisions r ON r.doc_id = d.id WHERE s.slug = 'notes' ORDER BY d.path")
        .all();
      expect(rows).toEqual([
        { path: 'b.md', kind: 'text', rev: 1, via: 'cli' },
        { path: 'notes/a.md', kind: 'text', rev: 1, via: 'cli' },
        { path: 'pic.png', kind: 'file', rev: 1, via: 'cli' },
      ]);
    } finally {
      db.close();
    }
  });
});
