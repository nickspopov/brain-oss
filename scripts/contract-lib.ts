// v1 contract snapshot and compatibility check.
import { z } from 'zod';
import { listOps } from '../src/ops/registry.js';
import { CONTRACT_VERSION } from '../src/ops/types.js';

export type JsonSchema = { [k: string]: unknown };

export interface OpSnapshot {
  effect: string;
  requires: string;
  expose: string[];
  idempotent: boolean;
  input: JsonSchema;
  output: JsonSchema;
}

export interface ContractSnapshot {
  contract_version: string;
  operations: Record<string, OpSnapshot>;
}

export function buildSnapshot(): ContractSnapshot {
  const operations: Record<string, OpSnapshot> = {};
  for (const op of listOps()) {
    operations[op.name] = {
      effect: op.effect,
      requires: op.requires,
      expose: [...op.expose].sort(),
      idempotent: op.idempotent,
      input: z.toJSONSchema(op.input, { io: 'input' }) as JsonSchema,
      output: z.toJSONSchema(op.output, { io: 'output' }) as JsonSchema,
    };
  }
  return { contract_version: CONTRACT_VERSION, operations };
}

type Mode = 'input' | 'output';

const asObj = (v: unknown): JsonSchema | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonSchema) : undefined;
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const typesOf = (s: JsonSchema): string => JSON.stringify(s.type ?? null);

/**
  * Incompatible schema changes. Allowed: new operations, new optional input fields,
  * new output fields. Forbidden: removal and renaming, changing a type or whether a field is required.
 */
export function schemaBreaks(before: JsonSchema, after: JsonSchema, mode: Mode, at: string): string[] {
  const out: string[] = [];
  if (typesOf(before) !== typesOf(after)) out.push(`${at}: type changed ${typesOf(before)} → ${typesOf(after)}`);
  if ('const' in before && JSON.stringify(before.const) !== JSON.stringify(after.const)) out.push(`${at}: const changed`);
  if (Array.isArray(before.enum)) {
    const now = new Set(asArr(after.enum).map((v) => JSON.stringify(v)));
    const removed = before.enum.filter((v) => !now.has(JSON.stringify(v)));
    if (!Array.isArray(after.enum)) out.push(`${at}: enum removed`);
    else if (removed.length) out.push(`${at}: enum values removed ${JSON.stringify(removed)}`);
    else if (mode === 'output' && after.enum.length > before.enum.length) {
      // New values in the output are allowed only as an extension (new reason codes and the like).
    }
  }
  const bp = asObj(before.properties) ?? {};
  const ap = asObj(after.properties) ?? {};
  for (const [k, v] of Object.entries(bp)) {
    const next = asObj(ap[k]);
    if (!next) {
      out.push(`${at}.${k}: field removed`);
      continue;
    }
    out.push(...schemaBreaks(v as JsonSchema, next, mode, `${at}.${k}`));
  }
  const breq = new Set(asArr(before.required) as string[]);
  const areq = new Set(asArr(after.required) as string[]);
  if (mode === 'input') {
    for (const k of areq) if (!breq.has(k)) out.push(`${at}.${k}: input field became required`);
  } else {
    for (const k of breq) if (!areq.has(k) && k in ap) out.push(`${at}.${k}: output field became optional`);
  }
  const bi = asObj(before.items);
  const ai = asObj(after.items);
  if (bi && ai) out.push(...schemaBreaks(bi, ai, mode, `${at}[]`));
  else if (bi && !ai) out.push(`${at}[]: items schema removed`);
  for (const key of ['anyOf', 'oneOf'] as const) {
    const b = asArr(before[key]);
    const a = asArr(after[key]);
    if (b.length === 0) continue;
    if (a.length < b.length) out.push(`${at}: ${key} variants removed`);
    b.forEach((v, i) => {
      const n = asObj(a[i]);
      if (n) out.push(...schemaBreaks(v as JsonSchema, n, mode, `${at}.${key}[${i}]`));
    });
  }
  return out;
}

export function contractBreaks(before: ContractSnapshot, after: ContractSnapshot): string[] {
  const out: string[] = [];
  for (const [name, op] of Object.entries(before.operations)) {
    const next = after.operations[name];
    if (!next) {
      out.push(`${name}: operation removed`);
      continue;
    }
    if (op.effect !== next.effect) out.push(`${name}: effect changed`);
    for (const a of op.expose) if (!next.expose.includes(a)) out.push(`${name}: no longer exposed in ${a}`);
    if (op.idempotent && !next.idempotent) out.push(`${name}: no longer accepts request_id`);
    out.push(...schemaBreaks(op.input, next.input, 'input', `${name}.input`));
    out.push(...schemaBreaks(op.output, next.output, 'output', `${name}.output`));
  }
  return out;
}
