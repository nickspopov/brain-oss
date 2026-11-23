// Cursors: an opaque string encrypted with the server key (AES-256-GCM).
// A cursor is bound to the caller, the listing kind and the parameter hash: someone else's or a forged
// cursor is `invalid_input` with no details. The nonce is random and the value has a fixed width:
// a cursor does not reveal whether the server state changed (a deterministic `changes` cursor
// changed on a write in an invisible space) or the order of magnitude of `seq` (the cursor length
// grew with the number of digits). Isolation tests compare responses without cursors.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type { Core } from './context.js';
import { invalidInput } from './errors.js';

interface Keys {
  enc: Buffer;
}

const keyCache = new WeakMap<Buffer, Keys>();

function keysOf(core: Core): Keys {
  const cached = keyCache.get(core.secretKey);
  if (cached) return cached;
  const material = Buffer.from(hkdfSync('sha256', core.secretKey, Buffer.alloc(0), 'brain cursor v1', 64));
  const keys = { enc: material.subarray(0, 32) };
  keyCache.set(core.secretKey, keys);
  return keys;
}

/** Hash of the listing parameters: a cursor is valid only for the same parameters. */
export function paramsHash(params: unknown): string {
  return createHash('sha256').update(JSON.stringify(params ?? null)).digest('base64url').slice(0, 16);
}

interface Payload {
  /** Listing kind: list, hist, search, changes, activity. */
  k: string;
  /** principal. */
  p: string;
  /** Parameter hash. */
  h: string;
  /** Value: offset, revision number or seq, as a 16-digit decimal string (fixed width). */
  v: string;
}

/** Value width: Number.MAX_SAFE_INTEGER has 16 digits. */
const VALUE_WIDTH = 16;

export interface CursorOwner {
  core: Core;
  principal: { id: string };
}

export function sealCursor(ctx: CursorOwner, kind: string, value: number, params: unknown = null): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`cursor value out of range: ${value}`);
  const { enc } = keysOf(ctx.core);
  const v = String(value).padStart(VALUE_WIDTH, '0');
  const plain = Buffer.from(JSON.stringify({ k: kind, p: ctx.principal.id, h: paramsHash(params), v } satisfies Payload), 'utf8');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', enc, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64url');
}

const bad = () => invalidInput('cursor', 'Cursor is invalid.');

export function openCursor(ctx: CursorOwner, kind: string, cursor: string, params: unknown = null): number {
  const raw = Buffer.from(cursor, 'base64url');
  if (raw.length < 12 + 16 + 1 || raw.toString('base64url') !== cursor) throw bad();
  const { enc } = keysOf(ctx.core);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', enc, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    plain = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
  } catch {
    throw bad();
  }
  let p: Payload;
  try {
    p = JSON.parse(plain.toString('utf8')) as Payload;
  } catch {
    throw bad();
  }
  if (p.k !== kind || p.p !== ctx.principal.id || p.h !== paramsHash(params)) throw bad();
  if (typeof p.v !== 'string' || !/^\d{16}$/.test(p.v)) throw bad();
  const v = Number(p.v);
  if (!Number.isSafeInteger(v)) throw bad();
  return v;
}
