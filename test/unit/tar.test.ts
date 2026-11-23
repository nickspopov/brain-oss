// The tar format for export, import and backup: writing is deterministic, reading rejects
// anything unsafe, long and non-ASCII paths go through PAX.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEntryName, tarPack, tarUnpack, TarError } from '../../src/core/export/tar.js';

const LIMITS = { maxEntries: 100, maxTotalBytes: 1 << 20 };

describe('tar', () => {
  it('round trip, deterministic, long and unicode names', () => {
    const long = `${'φάκελ/'.repeat(30)}αρχείο.md`;
    const entries = [
      { name: 'a.md', data: Buffer.from('# A\n'), mtime: 1 },
      { name: long, data: Buffer.from('μακρύ μονοπάτι\n'), mtime: 2 },
      { name: 'empty', data: Buffer.alloc(0), mtime: 3 },
    ];
    const a = tarPack(entries);
    expect(a.equals(tarPack(entries))).toBe(true);
    const files = tarUnpack(a, LIMITS);
    expect([...files.keys()]).toEqual(['a.md', long, 'empty']);
    expect(files.get(long)!.toString()).toBe('μακρύ μονοπάτι\n');
  });

  it('is readable by the system tar', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-tar-'));
    try {
      const long = `${'x'.repeat(120)}/ονα.md`;
      fs.writeFileSync(path.join(dir, 'a.tar'), tarPack([{ name: long, data: Buffer.from('ok\n'), mtime: 0 }]));
      const r = spawnSync('tar', ['-xf', 'a.tar'], { cwd: dir, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(fs.readFileSync(path.join(dir, long), 'utf8')).toBe('ok\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsafe names and enforces limits', () => {
    for (const bad of ['/abs', '../up', 'a/../b', 'a/./b', 'a\\b', 'nul\u0000', '']) {
      expect(() => checkEntryName(bad), JSON.stringify(bad)).toThrow(TarError);
    }
    expect(checkEntryName('./ok/x.md')).toBe('ok/x.md');
    const many = tarPack(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x'), mtime: 0 })));
    expect(() => tarUnpack(many, { maxEntries: 4, maxTotalBytes: 100 })).toThrow(/too many/);
    expect(() => tarUnpack(many, { maxEntries: 10, maxTotalBytes: 3 })).toThrow(/too large/);
    const dup = tarPack([{ name: 'a', data: Buffer.from('1'), mtime: 0 }, { name: 'a', data: Buffer.from('2'), mtime: 0 }]);
    expect(() => tarUnpack(dup, LIMITS)).toThrow(/duplicate/);
    const corrupt = Buffer.from(tarPack([{ name: 'a', data: Buffer.from('1'), mtime: 0 }]));
    corrupt[0] = 'b'.charCodeAt(0);
    expect(() => tarUnpack(corrupt, LIMITS)).toThrow(/checksum/);
  });
});
