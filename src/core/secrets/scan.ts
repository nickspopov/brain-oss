// Secret scanner: the body (added lines only), path and message of a write.
// A finding names the rule and the position; the value itself is never returned, audited or logged.
import { OpError } from '../errors.js';
import { SECRET_RULES, shannonEntropy, type SecretRule } from './rules.js';

export type SecretField = 'content' | 'path' | 'message';

export interface SecretFinding {
  rule: string;
  field: SecretField;
  /** 1-based. */
  line: number;
  /** 1-based, in characters of the line. */
  column: number;
}

/** At most this many findings per response: enough to find and remove them, and the response stays bounded. */
const MAX_FINDINGS = 20;

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** Line number (0-based) for an offset: binary search over line starts. */
function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface RuleMatch {
  index: number;
  length: number;
  /** Value for the entropy check (the rule's group or the whole match). */
  value: string | undefined;
}

/** Matches of a rule; the pass is linear in text length (see SecretRule.maxLen). */
export function* matchesOf(rule: SecretRule, text: string): Iterable<RuleMatch> {
  if (rule.find) {
    for (const f of rule.find(text)) yield { index: f.index, length: f.value.length, value: f.value };
    return;
  }
  const re = new RegExp(rule.re.source, rule.re.flags);
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (rule.maxLen !== undefined && m[0].length > rule.maxLen) {
      // A suitable start can only be closer to the end of the word (see SecretRule.maxLen).
      re.lastIndex = m.index + m[0].length - rule.maxLen;
      continue;
    }
    yield { index: m.index, length: m[0].length, value: rule.group ? m[rule.group] : m[0] };
  }
}

/**
 * Findings in a text. `added` holds the line numbers (0-based) that appeared in this write; a finding
 * counts if it touches at least one of them. Without `added` the whole text is checked.
 */
export function scanText(text: string, field: SecretField, added?: ReadonlySet<number>): SecretFinding[] {
  const starts = lineStarts(text);
  const out: SecretFinding[] = [];
  const seen = new Set<number>();
  for (const rule of SECRET_RULES) {
    for (const m of matchesOf(rule, text)) {
      const value = m.value;
      if (value === undefined) continue;
      if (rule.minEntropy !== undefined && shannonEntropy(value) < rule.minEntropy) continue;
      if (rule.mixed && !(/[0-9]/.test(value) && /[A-Za-z]/.test(value))) continue;
      const first = lineAt(starts, m.index);
      if (added) {
        const last = lineAt(starts, m.index + m.length - 1);
        let touches = false;
        for (let l = first; l <= last && !touches; l++) touches = added.has(l);
        if (!touches) continue;
      }
      // One finding per position: several rules matching one key are not duplicated.
      if (seen.has(m.index)) continue;
      seen.add(m.index);
      out.push({ rule: rule.id, field, line: first + 1, column: m.index - starts[first]! + 1 });
    }
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Lines of the new text (0-based) that were not in the old one. No old text: all of them. */
export function addedLines(before: string | undefined, after: string): Set<number> {
  const lines = after.split('\n');
  const old = new Set(before === undefined ? [] : before.split('\n'));
  const out = new Set<number>();
  lines.forEach((l, i) => {
    if (!old.has(l)) out.add(i);
  });
  return out;
}

export interface ScanInput {
  /** New body (text). */
  content?: string | undefined;
  /** Body before the write: only added lines are checked. */
  previous?: string | undefined;
  path?: string | undefined;
  message?: string | undefined;
}

/** All findings of a write. */
export function scanWrite(input: ScanInput): SecretFinding[] {
  const findings: SecretFinding[] = [];
  if (input.path !== undefined) findings.push(...scanText(input.path, 'path'));
  if (input.message !== undefined) findings.push(...scanText(input.message, 'message'));
  if (input.content !== undefined) {
    const added = input.previous === undefined ? undefined : addedLines(input.previous, input.content);
    if (added === undefined || added.size > 0) findings.push(...scanText(input.content, 'content', added));
  }
  return findings;
}

/** `secret_detected` with rules and positions, without values. */
export function secretDetected(findings: readonly SecretFinding[]): OpError {
  return new OpError('secret_detected', { findings: findings.slice(0, MAX_FINDINGS) });
}

const FILE_SCAN_MAX = 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** File bytes as text for the scanner: only valid UTF-8 without NUL and up to 1 MB. */
export function fileAsText(bytes: Uint8Array): string | undefined {
  if (bytes.length > FILE_SCAN_MAX || bytes.includes(0)) return undefined;
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}
