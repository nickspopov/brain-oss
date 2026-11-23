// Vocabulary lock: Space, Document, Message, People, Agents, Manager,
// Guest/Viewer/Editor/Admin, External, Review. Banned in the UI: principal, grant, capability, trust
// (outside Advanced and approvals), executable, inbox (as a setting), kind, owner, handoff. Every UI
// string lives in i18n/en.ts, so the lock is checked there: every string, every template called with
// sample arguments.
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';

const BANNED = /\b(principals?|grants?|granted|capabilit(?:y|ies)|executable|kinds?|owners?|handoff\w*)\b/i;
const TRUST = /\btrust/i;
/** Where trust is allowed: Advanced fields, approvals (proposals), the document's Details. */
const TRUST_OK = [/^principalPage\.trust$/, /^principals\.trustHint$/, /^doc\.trustFloor/, /^ui\.trustTitle$/, /^proposalsPage\./];
/** Space settings: "Messages: on/off", never "inbox". */
const SETTINGS = [/^adminUi\.spaceForm\./, /^spaceSettings\./, /^newSpace\./];

function* leaves(node: unknown, path: string[] = []): Generator<[string, string]> {
  if (typeof node === 'string') yield [path.join('.'), node];
  else if (typeof node === 'function') {
    const fn = node as (...a: unknown[]) => unknown;
    for (const sample of ['Xx', 2]) {
      try {
        const out = fn(...Array.from({ length: Math.max(fn.length, 1) }, () => sample));
        if (typeof out === 'string') yield [path.join('.'), out];
      } catch {
        // a template that needs another argument type; the other sample covers it
      }
    }
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) yield* leaves(v, [...path, k]);
  }
}

describe('vocabulary lock', () => {
  const all = [...leaves(en)].filter(([p]) => p !== 'locale');

  it('walks every UI string', () => {
    expect(all.length).toBeGreaterThan(500);
  });

  it('no banned word anywhere in the UI', () => {
    const hits = all.filter(([, v]) => BANNED.test(v)).map(([p, v]) => `${p}: ${v}`);
    expect(hits).toEqual([]);
  });

  it('trust only under Advanced and on approvals', () => {
    const hits = all.filter(([p, v]) => TRUST.test(v) && !TRUST_OK.some((re) => re.test(p))).map(([p, v]) => `${p}: ${v}`);
    expect(hits).toEqual([]);
  });

  it('inbox is never a setting: space settings say Messages', () => {
    const hits = all.filter(([p, v]) => SETTINGS.some((re) => re.test(p)) && /\binbox\b/i.test(v)).map(([p, v]) => `${p}: ${v}`);
    expect(hits).toEqual([]);
    expect(en.adminUi.spaceForm.messagesState(true)).toBe('Messages: on');
  });

  it('roles are the ladder Guest · Viewer · Editor · Admin (Proposer kept), not engine words', () => {
    expect(Object.values(en.roles.ladder)).toEqual(['No access', 'Guest', 'Viewer', 'Proposer', 'Editor', 'Admin']);
    expect(Object.values(en.grants.roleLabel).join(' ')).not.toMatch(/\b(read|write|propose)\b/);
  });
});
