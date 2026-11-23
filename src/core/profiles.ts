// Profiles: one profile per agent or person, a read
// model over principal fields (display name, "what I do", how to reach it, manager, external). Optional
// `_agents/<name>.md` agent cards are ordinary documents (a profile file format); their
// fields are only *extracted* here as suggestions for a human to accept, never copied into a profile on
// their own. Others see a minimal profile only, and only while they share a space membership.
import type { PrincipalRow, SpaceRow } from '../store/types.js';
import { getPrincipalById } from '../store/principals.js';
import { aclSnapshot } from './access/snapshot.js';
import { atLeast } from './access/resolve.js';
import { readTextBlob } from './blobs.js';
import type { Core } from './context.js';
import { invalidInput, notFound } from './errors.js';
import { utcDayStart } from './external.js';
import { parseText } from './frontmatter.js';
import { type AccessContext, contextForRow, explainRole, isMessageOnly } from './guard.js';
import { AGENTS_DIR, isInboxSpace } from './handoff.js';
import { lastSeen } from './inbox.js';
import { normalizePath, pathKey } from './paths.js';
import { findPrincipal, patchPrincipal } from './principals.js';
import { scanText, secretDetected } from './secrets/scan.js';

export const WHAT_I_DO_MAX = 200;
export const CONTACT_MAX = 1000;
export const DISPLAY_NAME_MAX = 200;

/** What a co-member sees: no other spaces, no harness, no credentials, no activity beyond "active today". */
export interface MinimalProfile {
  name: string;
  display_name: string;
  kind: 'human' | 'agent';
  what_i_do: string | null;
  contact: string | null;
  /** Who manages it: the managing person's display name, or the outside person of an external agent. */
  manager: string | null;
  external: boolean;
  active_today: boolean;
}

/** The principal's own profile, and what a Brain administrator sees. */
export interface FullProfile extends MinimalProfile {
  harness: string | null;
  last_seen: number | null;
  updated_at: number | null;
  disabled: boolean;
}

function managerName(core: Core, row: PrincipalRow): string | null {
  if (row.external === 1) return row.owner_label ?? null;
  if (!row.owner_id) return null;
  const m = getPrincipalById(core.db, row.owner_id);
  return m ? m.display_name || m.name : null;
}

export function minimalProfile(core: Core, row: PrincipalRow): MinimalProfile {
  const seen = lastSeen(core.db, row.id);
  return {
    name: row.name,
    display_name: row.display_name,
    kind: row.kind === 'human' ? 'human' : 'agent',
    what_i_do: row.what_i_do ?? null,
    contact: row.contact_notes ?? null,
    manager: managerName(core, row),
    external: row.external === 1,
    active_today: seen !== null && seen >= utcDayStart(core.now()),
  };
}

export function fullProfile(core: Core, row: PrincipalRow): FullProfile {
  return {
    ...minimalProfile(core, row),
    harness: row.harness,
    last_seen: lastSeen(core.db, row.id),
    updated_at: row.profile_updated_at ?? null,
    disabled: row.disabled_at !== null,
  };
}

// --- membership -----------------------------------------------------------------------------------------

/**
 * Spaces where this principal is an explicit member: a space-level grant ≥ guest, personal or through a
 * named group — never the computed all-agents group (no ambient discovery) —
 * that is in effect (not overridden by a personal deny). Active, canonical spaces only.
 */
export function memberSpaceIds(core: Core, row: PrincipalRow): Set<string> {
  const out = new Set<string>();
  if (row.disabled_at !== null || row.kind === 'system') return out;
  const view = contextForRow(core, row);
  const snap = view.snapshot;
  const named = view.groupIds.filter((g) => g !== snap.allAgentsGroupId);
  for (const s of snap.spaces) {
    if (s.archived_at !== null) continue;
    const explicit = (snap.grantsBySpace.get(s.id) ?? []).some(
      (g) => g.scope === 'space' && atLeast(g.role, 'guest') && (g.subject_type === 'principal' ? g.subject_id === row.id : named.includes(g.subject_id)),
    );
    if (!explicit) continue;
    if (isMessageOnly(view, s) || atLeast(explainRole(view, s).role, 'guest')) out.add(s.id);
  }
  return out;
}

/** Spaces where both principals are explicit members right now. */
export function sharedSpaceIds(core: Core, a: PrincipalRow, b: PrincipalRow): string[] {
  const mine = memberSpaceIds(core, a);
  if (mine.size === 0) return [];
  return [...memberSpaceIds(core, b)].filter((id) => mine.has(id));
}

/** Do the two principals share at least one explicit membership right now? */
export function shareMembership(core: Core, a: PrincipalRow, b: PrincipalRow): boolean {
  return sharedSpaceIds(core, a, b).length > 0;
}

// --- reads ------------------------------------------------------------------------------------------------

function selfRow(ctx: AccessContext): PrincipalRow {
  const row = getPrincipalById(ctx.core.db, ctx.principal.id);
  if (!row) throw notFound();
  return row;
}

/**
 * `profile_get`: the caller's own profile (full), or a co-member's minimal profile. Anyone else — unknown,
 * disabled, or sharing no space — is `not_found`, the same answer as for a name that does not exist.
 */
export function profileGet(ctx: AccessContext, name?: string): { profile: MinimalProfile | FullProfile; self: boolean } {
  const me = selfRow(ctx);
  if (name === undefined || name.toLowerCase() === me.name.toLowerCase()) return { profile: fullProfile(ctx.core, me), self: true };
  const target = findPrincipal(ctx.core, name);
  const shared = target && target.disabled_at === null ? sharedSpaceIds(ctx.core, me, target) : [];
  if (!target || shared.length === 0) throw notFound();
  const profile = minimalProfile(ctx.core, target);
  // A caller that is only a message-only member (Guest, external) where they meet sees the same minimal
  // identity as in handoff_recipients: no manager.
  const onlyAsGuest = shared.every((id) => {
    const s = ctx.snapshot.spaceById.get(id);
    return s !== undefined && isMessageOnly(ctx, s);
  });
  return { profile: onlyAsGuest ? { ...profile, manager: null } : profile, self: false };
}

/** The reviewed "what I do" of a principal, for lists the caller may already see it in (To picker, Members). */
export function whatIDoOf(core: Core, principalId: string): string | null {
  return getPrincipalById(core.db, principalId)?.what_i_do ?? null;
}

// --- writes -----------------------------------------------------------------------------------------------

export interface ProfilePatch {
  display_name?: string | undefined;
  what_i_do?: string | null | undefined;
  contact?: string | null | undefined;
}

function clean(field: string, value: string | null | undefined, max: number, oneLine: boolean): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const v = value.replace(/\r\n?/g, '\n').trim();
  if (v === '') return null;
  if (oneLine && /\n/.test(v)) throw invalidInput(field, 'One line.');
  if (v.length > max) throw invalidInput(field, `At most ${max} characters.`);
  // Profiles are shown to co-members: no secrets (the same scanner as document writes).
  const found = scanText(v, 'content');
  if (found.length > 0) throw secretDetected(found);
  return v;
}

/** Validated patch of profile fields; `{}` when nothing is given. */
export function profileFields(patch: ProfilePatch): { display_name?: string; what_i_do?: string | null; contact_notes?: string | null } {
  const out: { display_name?: string; what_i_do?: string | null; contact_notes?: string | null } = {};
  if (patch.display_name !== undefined) {
    const d = clean('display_name', patch.display_name, DISPLAY_NAME_MAX, true);
    if (!d) throw invalidInput('display_name', 'A display name cannot be empty.');
    out.display_name = d;
  }
  const w = clean('what_i_do', patch.what_i_do, WHAT_I_DO_MAX, true);
  if (w !== undefined) out.what_i_do = w;
  const c = clean('contact', patch.contact, CONTACT_MAX, false);
  if (c !== undefined) out.contact_notes = c;
  return out;
}

export function applyProfile(core: Core, id: string, fields: ReturnType<typeof profileFields>): void {
  if (Object.keys(fields).length === 0) return;
  patchPrincipal(core, id, { ...fields, profile_updated_at: core.now() });
}

/** `profile_update`: the caller edits its own profile (display name, what it does, how to reach it). */
export function profileUpdate(ctx: AccessContext, patch: ProfilePatch): FullProfile {
  const me = selfRow(ctx);
  const fields = profileFields(patch);
  if (Object.keys(fields).length === 0) throw invalidInput('what_i_do', 'Give display_name, what_i_do or contact.');
  applyProfile(ctx.core, me.id, fields);
  return fullProfile(ctx.core, selfRow(ctx));
}

/** Does the principal still need to fill in its profile (start_here onboarding)? */
export function profileMissing(core: Core, principalId: string): boolean {
  const row = getPrincipalById(core.db, principalId);
  return !row?.what_i_do;
}

// --- agent cards -------------------------------------------------------------------------------------------

export interface CardFields {
  what_i_do: string | null;
  contact: string | null;
  response_times: string | null;
}

export interface LegacyCard extends CardFields {
  space: string;
  path: string;
  doc_id: string;
  rev: number;
}

const firstLine = (s: string): string => s.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
const short = (s: string, max: number): string | null => {
  const v = s.replace(/\s+/g, ' ').trim().replace(/^[-*]\s+/, '');
  if (!v) return null;
  return v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v;
};
const metaText = (meta: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
};

/** Text of the section under the first heading (or "Label:" line) matching `re`. */
function section(body: string, re: RegExp): string | null {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h && re.test(h[1]!)) {
      const out: string[] = [];
      for (let j = i + 1; j < lines.length && !/^\s{0,3}#{1,6}\s/.test(lines[j]!); j++) out.push(lines[j]!);
      const text = out.join('\n').trim();
      if (text) return text;
    }
    const label = /^\s*(?:[-*]\s*)?\*{0,2}([^:*]{2,40})\*{0,2}\s*:\s*(.+)$/.exec(line);
    if (label && re.test(label[1]!)) return label[2]!.trim();
  }
  return null;
}

/**
 * Fields of a legacy card (best effort; a human reviews them before they become a profile): frontmatter
 * keys, a "What I do" / "Role" section or label, "How to reach" / "Contact", "Response time".
 */
export function extractCard(text: string, path: string): CardFields {
  const p = parseText(text, path);
  const body = p.body;
  const what =
    metaText(p.meta, ['what_i_do', 'summary', 'description', 'role']) ??
    section(body, /^(what (i|it|we) do|role|purpose|about|who i am)\b/i) ??
    // The first paragraph line that is neither a heading nor a label.
    (body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '' && !l.startsWith('#') && !/^[^:]{2,40}:\s/.test(l) && !l.startsWith('---')) ??
      null);
  const contact = metaText(p.meta, ['contact', 'how_to_reach', 'reach']) ?? section(body, /^(how to reach|contact|reach me|how to contact)/i);
  const response = metaText(p.meta, ['response_time', 'response_times']) ?? section(body, /^response( time| times)?/i);
  return {
    what_i_do: what === null ? null : short(firstLine(what), WHAT_I_DO_MAX),
    contact: contact === null ? null : short(contact, CONTACT_MAX),
    response_times: response === null ? null : short(response, CONTACT_MAX),
  };
}

/** Live legacy cards `_agents/<name>.md` of this principal in spaces with messages. */
export function legacyCards(core: Core, row: PrincipalRow): LegacyCard[] {
  let key: string;
  try {
    key = pathKey(normalizePath(`${AGENTS_DIR}/${row.name}.md`));
  } catch {
    return [];
  }
  const snap = aclSnapshot(core);
  const rows = core.db
    .prepare("SELECT id, space_id, path, head_rev, content_hash FROM documents WHERE tenant_id = ? AND path_key = ? AND deleted_at IS NULL AND kind = 'text'")
    .all(core.tenantId, key) as { id: string; space_id: string; path: string; head_rev: number; content_hash: string }[];
  const out: LegacyCard[] = [];
  for (const r of rows) {
    const space: SpaceRow | undefined = snap.spaceById.get(r.space_id);
    if (!space || !isInboxSpace(space)) continue;
    const text = readTextBlob(core, r.content_hash);
    if (text === undefined) continue;
    out.push({ space: space.slug, path: r.path, doc_id: r.id, rev: r.head_rev, ...extractCard(text, r.path) });
  }
  return out.sort((a, b) => a.space.localeCompare(b.space));
}

/** Several cards that disagree on "what I do": an operator chooses. */
export function cardsConflict(cards: readonly LegacyCard[]): boolean {
  return new Set(cards.map((c) => c.what_i_do).filter((x) => x !== null)).size > 1;
}
