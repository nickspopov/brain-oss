// Document content: text normalisation, hash, MIME by signature, size limits.
import { createHash } from 'node:crypto';
import { invalidInput, OpError } from './errors.js';

export function sha256(data: string | Uint8Array): string {
  const h = createHash('sha256');
  if (typeof data === 'string') h.update(data, 'utf8');
  else h.update(data);
  return h.digest('hex');
}

/**
 * Text: UTF-8 without NUL; `\r\n` and `\r` → `\n`. The server changes nothing else: the body is
 * stored and returned byte for byte, and the hash is stable.
 */
export function normalizeText(raw: string, field = 'content'): string {
  if (raw.includes('\u0000')) throw invalidInput(field, 'Text must not contain NUL characters.');
  // Lone surrogates cannot be encoded in UTF-8 losslessly: such text is not stored.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(raw)) throw invalidInput(field, 'Text must be valid Unicode.');
  return raw.replace(/\r\n?/g, '\n');
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function checkSize(actual: number, limit: number): void {
  if (actual > limit) throw new OpError('too_large', { limit, actual });
}

/** Strict base64 (RFC 4648, with or without padding); otherwise invalid_input. */
export function decodeBase64(raw: string, field = 'content_base64'): Buffer {
  const s = raw.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 === 1) throw invalidInput(field, 'Expected base64.');
  return Buffer.from(s, 'base64');
}

const SIGNATURES: { mime: string; bytes: number[]; offset?: number }[] = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'application/gzip', bytes: [0x1f, 0x8b] },
];

/** File MIME by signature: not by extension and not by what the client claims. */
export function sniffMime(bytes: Uint8Array): string {
  for (const s of SIGNATURES) {
    const off = s.offset ?? 0;
    if (bytes.length >= off + s.bytes.length && s.bytes.every((b, i) => bytes[off + i] === b)) return s.mime;
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

/** MIME of a text document: `.md` is markdown, everything else is plain. */
export function textMime(path: string): string {
  return /\.(md|markdown)$/i.test(path) ? 'text/markdown' : 'text/plain';
}

/**
 * A UTF-8 slice by bytes without splitting a character: the end moves back to a character boundary.
 * Returns the text and the offset of the next chunk (if the text is not finished).
 */
export function sliceUtf8(text: string, offset: number, maxBytes: number): { text: string; next?: number } {
  const buf = Buffer.from(text, 'utf8');
  let start = Math.min(offset, buf.length);
  while (start < buf.length && start > 0 && (buf[start]! & 0xc0) === 0x80) start++;
  let end = Math.min(start + maxBytes, buf.length);
  while (end < buf.length && end > start && (buf[end]! & 0xc0) === 0x80) end--;
  const out = buf.subarray(start, end).toString('utf8');
  return end < buf.length ? { text: out, next: end } : { text: out };
}
