import { monotonicFactory } from 'ulid';

const next = monotonicFactory();

/** Permanent sortable id (ULID). */
export function newId(now: number = Date.now()): string {
  return next(now);
}
