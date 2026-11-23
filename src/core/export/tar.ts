// tar format (POSIX ustar + PAX for long paths) without external dependencies: export, import and
// backup archives. Writing is deterministic: the same entries → the same bytes.
// Reading rejects everything except regular files and directories: absolute paths, `..`, links, devices.
import { createHash } from 'node:crypto';

const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);

export interface TarEntry {
  name: string;
  data: Uint8Array;
  /** Unix seconds. */
  mtime: number;
}

function octal(value: number, width: number): string {
  // width includes the trailing NUL.
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number, mtime: number, type: '0' | 'x', prefix = ''): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(type === 'x' ? 0o644 : 0o644, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(Math.max(0, Math.floor(mtime)), 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 'ascii');
  return h;
}

/** PAX record: "<len> path=<value>\n", where len counts itself. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body, 'utf8') + 1;
  while (String(len).length + Buffer.byteLength(body, 'utf8') !== len) len++;
  return Buffer.from(`${len}${body}`, 'utf8');
}

function pad(size: number): Buffer {
  const rest = size % BLOCK;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rest);
}

/** Entry headers (with PAX if the path does not fit in ustar). */
export function entryHeader(name: string, size: number, mtime: number): Buffer[] {
  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes <= 100 && /^[\x20-\x7e]*$/.test(name)) return [header(name, size, mtime, '0')];
  const pax = paxRecord('path', name);
  const short = `PaxHeaders/${createHash('sha256').update(name).digest('hex').slice(0, 32)}`;
  return [header(short, pax.length, mtime, 'x'), pax, pad(pax.length), header(short, size, mtime, '0')];
}

/** Archive parts for one entry: headers, data, padding. */
export function entryChunks(e: TarEntry): Buffer[] {
  const data = Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength);
  return [...entryHeader(e.name, data.length, e.mtime), data, pad(data.length)];
}

/** End of archive: two zero blocks. */
export function tarEnd(): Buffer {
  return Buffer.concat([ZERO_BLOCK, ZERO_BLOCK]);
}

export function tarPack(entries: readonly TarEntry[]): Buffer {
  return Buffer.concat([...entries.flatMap(entryChunks), tarEnd()]);
}

// --- Reading -----------------------------------------------------------------------------------

export class TarError extends Error {}

export interface TarLimits {
  maxEntries: number;
  maxTotalBytes: number;
}

function readString(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

function readOctal(buf: Buffer, start: number, len: number): number {
  const s = readString(buf, start, len).trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError('bad number in a tar header');
  return parseInt(s, 8);
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) throw new TarError('bad pax header');
    const len = Number(data.subarray(i, sp).toString('ascii'));
    if (!Number.isInteger(len) || len <= 0 || i + len > data.length) throw new TarError('bad pax header');
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq === -1) throw new TarError('bad pax header');
    out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Entry path: relative, with no `..` or inner `.` segments, backslashes or control characters. */
export function checkEntryName(name: string): string {
  const n = name.replace(/^\.\//, '');
  const control = [...n].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
  if (n === '' || n.startsWith('/') || n.includes('\\') || control) throw new TarError('unsafe path in archive');
  const parts = n.replace(/\/$/, '').split('/');
  if (parts.some((p) => p === '..' || p === '.' || p === '')) throw new TarError('unsafe path in archive');
  return n;
}

/**
 * Regular files of the archive by path. Directories are skipped; links, devices and other types are an
 * error. Limits on entry count and total size are checked before data is copied.
 */
export function tarUnpack(buf: Buffer, limits: TarLimits): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let off = 0;
  let total = 0;
  let count = 0;
  let paxPath: string | undefined;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.equals(ZERO_BLOCK)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (sum !== readOctal(h, 148, 8)) throw new TarError('bad tar header checksum');
    const size = readOctal(h, 124, 12);
    const type = String.fromCharCode(h[156]!);
    const dataStart = off + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new TarError('truncated tar archive');
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (++count > limits.maxEntries) throw new TarError('too many entries in archive');
    if (type === 'x') {
      paxPath = parsePax(buf.subarray(dataStart, dataEnd)).path;
      continue;
    }
    if (type === 'g') continue;
    const prefix = readString(h, 345, 155);
    const raw = paxPath ?? (prefix ? `${prefix}/${readString(h, 0, 100)}` : readString(h, 0, 100));
    paxPath = undefined;
    if (type === '5') {
      checkEntryName(raw);
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '7') throw new TarError('links and special files are not allowed in archive');
    const name = checkEntryName(raw);
    total += size;
    if (total > limits.maxTotalBytes) throw new TarError('archive is too large when unpacked');
    if (files.has(name)) throw new TarError('duplicate path in archive');
    files.set(name, Buffer.from(buf.subarray(dataStart, dataEnd)));
  }
  return files;
}
