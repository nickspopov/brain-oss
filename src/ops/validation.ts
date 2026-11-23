// Validation errors that name the field and the rule: "space: required",
// "depth: must be 1–5". Built from the schema and the zod issue; never from the input value.
import { z } from 'zod';

export interface Issue {
  path: string;
  message: string;
}

const MAX_ISSUES = 20;
const MAX_ENUM = 10;
/** Unknown keys are named only when they look like a field name (they come from the caller). */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

type ZIssue = z.core.$ZodIssue;

export function validationIssues(schema: z.ZodType, error: z.ZodError, rawInput: unknown): Issue[] {
  const out: Issue[] = [];
  for (const i of error.issues) {
    const path = i.path.map(String).join('.');
    if (i.code === 'unrecognized_keys') {
      for (const k of i.keys) out.push({ path: joinPath(path, KEY_RE.test(k) ? k : '(unnamed)'), message: 'unknown field' });
    } else {
      out.push({ path, message: describe(i, fieldSchema(schema, i.path), valueAt(rawInput, i.path)) });
    }
    if (out.length >= MAX_ISSUES) break;
  }
  return out.slice(0, MAX_ISSUES);
}

function joinPath(base: string, key: string): string {
  return base === '' ? key : `${base}.${key}`;
}

function describe(i: ZIssue, field: z.ZodType | undefined, value: unknown): string {
  switch (i.code) {
    case 'invalid_type':
      if (value === undefined) return 'required';
      return `must be ${article(i.expected)}`;
    case 'too_small':
    case 'too_big':
      return sizeRule(i, field);
    case 'invalid_value':
      return oneOf(i.values);
    case 'invalid_format':
      return 'has an invalid format';
    case 'invalid_union':
      return 'has an invalid value';
    case 'not_multiple_of':
      return `must be a multiple of ${String(i.divisor)}`;
    case 'custom':
      // Messages of our own refinements are written for the caller and carry no input.
      return i.message.replace(/\.$/, '');
    default:
      return 'is invalid';
  }
}

function article(expected: string): string {
  switch (expected) {
    case 'int':
      return 'an integer';
    case 'boolean':
      return 'true or false';
    case 'object':
    case 'array':
      return `an ${expected}`;
    default:
      return `a ${expected}`;
  }
}

function oneOf(values: readonly unknown[]): string {
  const shown = values.slice(0, MAX_ENUM).map((v) => JSON.stringify(v));
  return `must be one of ${shown.join(', ')}${values.length > MAX_ENUM ? ', …' : ''}`;
}

function sizeRule(i: Extract<ZIssue, { code: 'too_small' | 'too_big' }>, field: z.ZodType | undefined): string {
  const small = i.code === 'too_small';
  const n = Number(small ? (i as { minimum: unknown }).minimum : (i as { maximum: unknown }).maximum);
  switch (i.origin) {
    case 'number':
    case 'int': {
      const num = field instanceof z.ZodNumber ? field : undefined;
      const min = num?.minValue;
      const max = num?.maxValue;
      if (min !== undefined && min !== null && max !== undefined && max !== null && Number.isFinite(min) && Number.isFinite(max) && Math.abs(max) < Number.MAX_SAFE_INTEGER) {
        return `must be ${min}–${max}`;
      }
      return small ? `must be at least ${n}` : `must be at most ${n}`;
    }
    case 'string':
      if (small && n === 1) return 'must not be empty';
      return small ? `must be at least ${n} characters` : `must be at most ${n} characters`;
    case 'array':
    case 'set':
      if (small && n === 1) return 'must not be empty';
      return small ? `must have at least ${n} items` : `must have at most ${n} items`;
    default:
      return small ? 'is too small' : 'is too large';
  }
}

/** The schema of the field at `path` (objects only; optional/nullable/default unwrapped). */
function fieldSchema(schema: z.ZodType, path: readonly PropertyKey[]): z.ZodType | undefined {
  let s: z.ZodType | undefined = unwrap(schema);
  for (const key of path) {
    if (s instanceof z.ZodObject && typeof key === 'string') s = unwrap((s.shape as Record<string, z.ZodType>)[key]);
    else if (s instanceof z.ZodArray && typeof key === 'number') s = unwrap(s.element as z.ZodType);
    else return undefined;
  }
  return s;
}

function unwrap(s: z.ZodType | undefined): z.ZodType | undefined {
  let cur = s;
  for (let n = 0; n < 8 && cur; n++) {
    if (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable) cur = cur.unwrap() as z.ZodType;
    else if (cur instanceof z.ZodDefault) cur = cur.unwrap() as z.ZodType;
    else break;
  }
  return cur;
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = input;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}
