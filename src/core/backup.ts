// Backup: a consistent DB snapshot via the SQLite online backup API
// plus data/blobs/ and data/secret.key in one tar. The live WAL database file is never copied.
// While the snapshot is taken, data/backup.lock exists: the janitor does not delete body files
// (otherwise the DB snapshot would reference files that are no longer in the archive).
import fs from 'node:fs';
import path from 'node:path';
import { backupLockPath } from './blobs.js';
import type { Core } from './context.js';
import { entryHeader, tarEnd } from './export/tar.js';

export interface BackupResult {
  file: string;
  bytes: number;
  blobs: number;
}

const BLOCK = 512;
const COPY_CHUNK = 1024 * 1024;

/** Body files in ascending path order: hash names only (temporary `.tmp` files are excluded). */
function blobFiles(dataDir: string): string[] {
  const root = path.join(dataDir, 'blobs');
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const dir of fs.readdirSync(root).sort()) {
    if (!/^[0-9a-f]{2}$/.test(dir)) continue;
    const sub = path.join(root, dir);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const name of fs.readdirSync(sub).sort()) {
      if (/^[0-9a-f]{64}$/.test(name) && fs.statSync(path.join(sub, name)).isFile()) out.push(`blobs/${dir}/${name}`);
    }
  }
  return out;
}

/** Appends a file from disk to the tar in chunks (a large DB is not read into memory whole). */
function appendFile(fd: number, name: string, source: string, mtime: number): number {
  const size = fs.statSync(source).size;
  let written = 0;
  for (const h of entryHeader(name, size, mtime)) written += fs.writeSync(fd, h);
  const src = fs.openSync(source, 'r');
  try {
    const buf = Buffer.alloc(COPY_CHUNK);
    let left = size;
    let pos = 0;
    while (left > 0) {
      const n = fs.readSync(src, buf, 0, Math.min(COPY_CHUNK, left), pos);
      if (n <= 0) throw new Error(`file changed while copying: ${name}`);
      written += fs.writeSync(fd, buf, 0, n);
      left -= n;
      pos += n;
    }
  } finally {
    fs.closeSync(src);
  }
  const rest = size % BLOCK;
  if (rest !== 0) written += fs.writeSync(fd, Buffer.alloc(BLOCK - rest));
  return written;
}

/**
 * `brain backup --out <file>`: tar with `brain.db` (snapshot), `secret.key` and `blobs/…`. Unpacks
 * with a plain `tar -xf` into the data directory; `brain doctor` on it must be clean.
 */
export async function backup(core: Core, outFile: string): Promise<BackupResult> {
  const dataDir = core.config.dataDir;
  const lock = backupLockPath(core);
  const tmpDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const snapshot = path.join(tmpDir, `backup-${process.pid}-${Date.now()}.db`);
  const out = path.resolve(outFile);
  const partial = `${out}.partial`;
  fs.writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
  try {
    await core.db.backup(snapshot);
    const mtime = Math.floor(core.now() / 1000);
    const blobs = blobFiles(dataDir);
    const fd = fs.openSync(partial, 'w', 0o600);
    let bytes = 0;
    try {
      bytes += appendFile(fd, 'brain.db', snapshot, mtime);
      bytes += appendFile(fd, 'secret.key', path.join(dataDir, 'secret.key'), mtime);
      for (const b of blobs) bytes += appendFile(fd, b, path.join(dataDir, b), mtime);
      bytes += fs.writeSync(fd, tarEnd());
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(partial, out);
    return { file: out, bytes, blobs: blobs.length };
  } finally {
    fs.rmSync(snapshot, { force: true });
    fs.rmSync(partial, { force: true });
    fs.rmSync(lock, { force: true });
  }
}

/** `brain vacuum`: rewrite the DB file without free pages; the WAL is checkpointed. */
export function vacuum(core: Core): { before: number; after: number } {
  const file = path.join(core.config.dataDir, 'brain.db');
  const before = fs.statSync(file).size;
  core.db.pragma('wal_checkpoint(TRUNCATE)');
  core.db.exec('VACUUM');
  core.db.pragma('wal_checkpoint(TRUNCATE)');
  return { before, after: fs.statSync(file).size };
}
