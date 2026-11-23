// `brain migrate-spaces`: an inbox space becomes the
// Messages of its project space. A maintenance path, not a cross-space move (those are forbidden):
// the documents of the inbox space — messages, their backing documents, agent cards, trash — are
// re-homed into the project space in one transaction with the same ids, revisions, authors, timestamps,
// paths, envelopes (thread links, receipts, resolutions), TTLs and request-id rows. Nothing is
// re-sent, no envelope or revision is written, no cursor moves. The old row stays as an alias of the
// project space (old slug, id and paths resolve to the canonical records; authorization is the
// destination's), archived and hidden.
//
// Pairs are declared by the operator (`--pair proj-alpha=proj-alpha-inbox`), never guessed. The preview
// computes effective permissions before/after per principal; inbox-only members become Guests of the
// project (never Editors); a project Admin gaining oversight of historic mail is listed and needs
// explicit acceptance; anything ambiguous blocks that pair (and an apply of several pairs is all or
// nothing).
import type { GrantRow, PrincipalRow, Role, SpaceRow } from '../store/types.js';
import { getSpaceRowBySlug } from '../store/spaces.js';
import { upsertGrant } from '../store/grants.js';
import { atLeast } from './access/resolve.js';
import { aclSnapshot, bumpAcl, noAmbientGrants } from './access/snapshot.js';
import { recordAudit } from './audit.js';
import { ALL_AGENTS_GROUP } from './bootstrap.js';
import type { Core } from './context.js';
import { invalidInput, OpError } from './errors.js';
import { contextForRow, isMessageOnly, isSpaceAdmin, isSuperadmin, roleAt, type AccessContext } from './guard.js';
import { AGENTS_DIR, isInboxSpace } from './handoff.js';
import { newId } from './ids.js';
import { isValidName } from './names.js';

/** A role as named on the ladder Guest · Viewer · Proposer · Editor · Admin. */
export type LadderRole = 'guest' | 'viewer' | 'proposer' | 'editor' | 'admin' | 'none';

export interface SpacePair {
  /** Canonical (project) space slug: the messages end up here. */
  project: string;
  /** Inbox space slug: becomes an alias of `project`. */
  inbox: string;
}

/** `proj-alpha=proj-alpha-inbox` → { project, inbox }. */
export function parsePair(raw: string): SpacePair {
  const m = /^([^=\s]+)=([^=\s]+)$/.exec(raw.trim());
  if (!m || !isValidName(m[1]!) || !isValidName(m[2]!)) throw invalidInput('pair', `Expected <project>=<inbox>, got "${raw.slice(0, 80)}".`);
  return { project: m[1]!, inbox: m[2]! };
}

export type MemberFlag =
  /** Instance superadmin (admin everywhere: the global exception). */
  | 'superadmin'
  /** External principal: message-only in a space with messages on. */
  | 'external'
  /** Becomes Guest of the project: messages only, no documents (an inbox-only member). */
  | 'becomes_guest'
  /** Keeps its project role; a personal membership is added at that role so it stays a recipient (its role came from a group). */
  | 'membership_made_explicit'
  /** A project Admin who will read other people's historic mail of the inbox space (needs --accept-oversight). */
  | 'gains_oversight'
  /** An inbox Admin who is not a project Admin: no longer reads other people's mail of this inbox (never promoted). */
  | 'loses_oversight'
  /** Project member without a personal membership: cannot receive messages in the project (as before in the inbox). */
  | 'not_a_recipient'
  /** Project member with a personal membership who was not in the inbox: can be messaged in the project from now on. */
  | 'becomes_recipient';

export type MemberBlock =
  /** External with document access in the project: messages on would make it message-only there. */
  | 'external_loses_documents'
  /** Inbox member with a personal `none` on the project. */
  | 'project_deny'
  /** Inbox member whose project role is Proposer: a message would need review. */
  | 'project_propose'
  /** Inbox member who could send there but is only a Viewer of the project. */
  | 'loses_send'
  /** Folder, document, group, propose or none grants in the inbox space: no simple mapping. */
  | 'inbox_custom_grant'
  /** gains_oversight without --accept-oversight. */
  | 'oversight_not_accepted';

export interface MemberPreview {
  name: string;
  kind: PrincipalRow['kind'];
  external: boolean;
  /** Ladder role in the inbox space (Guest for message-only members); none = not a member. */
  inbox_role: LadderRole;
  project_before: LadderRole;
  project_after: LadderRole;
  /** Personal space grant the apply adds in the project, if any. */
  grant_added: Role | null;
  /** Live messages of the inbox space it sent or received. */
  own_mail: number;
  /** Live messages of the inbox space it can read now / will read in the project. */
  mail_before: number;
  mail_after: number;
  flags: MemberFlag[];
  blocks: MemberBlock[];
}

export interface PairCounts {
  /** Documents of the inbox space, live and in the trash. */
  documents: number;
  live_documents: number;
  messages: number;
  /** Live messages by status. */
  pending: number;
  received: number;
  done: number;
  declined: number;
  agent_cards: number;
  revisions: number;
  proposals: number;
  bytes: number;
}

export interface PairPreview {
  project: string;
  inbox: string;
  /** Applies cleanly (no blocking reason). */
  ok: boolean;
  /** Why the pair is blocked (plain words), empty when ok. */
  blocked: string[];
  counts: PairCounts;
  /** Messages keep their path; the project's folders that will hold mail. */
  mail_folders: string[];
  members: MemberPreview[];
}

export interface SpacesMigration {
  /** True for a preview; false after an apply. */
  dry_run: boolean;
  ok: boolean;
  pairs: PairPreview[];
}

const LADDER: Record<Role, LadderRole> = { none: 'none', guest: 'guest', read: 'viewer', propose: 'proposer', write: 'editor', admin: 'admin' };

interface Plan {
  preview: PairPreview;
  project: SpaceRow;
  inbox: SpaceRow;
  grants: { principalId: string; role: Role }[];
  participants: string[];
}

const mineOf = (ctx: AccessContext, grants: readonly GrantRow[]): GrantRow[] =>
  grants.filter((g) => (g.subject_type === 'principal' ? g.subject_id === ctx.principal.id : ctx.groupIds.includes(g.subject_id)));

const personalSpaceGrant = (grants: readonly GrantRow[], principalId: string): GrantRow | undefined =>
  grants.find((g) => g.scope === 'space' && g.subject_type === 'principal' && g.subject_id === principalId);

const topFolder = (key: string): string | undefined => {
  const i = key.indexOf('/');
  return i > 0 ? key.slice(0, i) : undefined;
};

interface MsgRow {
  doc_id: string;
  path_key: string;
  sender_id: string;
  recipient_id: string;
  content_rev: number;
  received_rev: number | null;
  resolution: 'done' | 'declined' | null;
  resolved_rev: number | null;
}

function plan(core: Core, pair: SpacePair, opts: { acceptOversight: boolean }): Plan {
  const db = core.db;
  const project = getSpaceRowBySlug(db, core.tenantId, pair.project);
  const inbox = getSpaceRowBySlug(db, core.tenantId, pair.inbox);
  if (!project) throw invalidInput('pair', `No space ${pair.project}.`);
  if (!inbox) throw invalidInput('pair', `No space ${pair.inbox}.`);
  const blocked: string[] = [];
  if (project.id === inbox.id) throw invalidInput('pair', 'Project and inbox must be two different spaces.');
  if (project.alias_of) throw invalidInput('pair', `${pair.project} is an alias (already migrated); name its canonical space.`);
  if (inbox.alias_of) throw invalidInput('pair', `${pair.inbox} is already an alias: it was migrated before.`);
  if (!isInboxSpace(inbox)) blocked.push(`${inbox.slug} is not a space with messages (the inbox setting is off).`);
  if (project.archived_at !== null) blocked.push(`${project.slug} is archived.`);
  if (project.review_mode !== 'off') blocked.push(`${project.slug} has review on (${project.review_mode}): messages would need review. Turn review off first.`);

  const snap = aclSnapshot(core);
  const inboxGrants = snap.grantsBySpace.get(inbox.id) ?? [];
  const projectGrants = snap.grantsBySpace.get(project.id) ?? [];

  // Documents of the inbox space and their envelopes.
  const docs = db.prepare('SELECT id, path_key, deleted_at, size FROM documents WHERE space_id = ?').all(inbox.id) as {
    id: string;
    path_key: string;
    deleted_at: number | null;
    size: number;
  }[];
  const msgs = db
    .prepare(
      `SELECT m.doc_id, d.path_key, m.sender_id, m.recipient_id, m.content_rev, m.received_rev, m.resolution, m.resolved_rev
       FROM handoff_messages m JOIN documents d ON d.id = m.doc_id WHERE d.space_id = ? AND d.deleted_at IS NULL ORDER BY m.doc_id`,
    )
    .all(inbox.id) as MsgRow[];
  const allMsgIds = new Set((db.prepare('SELECT m.doc_id FROM handoff_messages m JOIN documents d ON d.id = m.doc_id WHERE d.space_id = ?').all(inbox.id) as { doc_id: string }[]).map((r) => r.doc_id));
  const live = docs.filter((d) => d.deleted_at === null);
  const cards = live.filter((d) => d.path_key.startsWith(`${AGENTS_DIR}/`));
  const strays = live.filter((d) => !allMsgIds.has(d.id) && !d.path_key.startsWith(`${AGENTS_DIR}/`));
  if (strays.length > 0) {
    blocked.push(`${inbox.slug} holds ${strays.length} live document(s) that are neither messages nor agent cards (e.g. ${strays.slice(0, 3).map((d) => d.path_key).join(', ')}): move or delete them first, the project's members would read them.`);
  }
  const status = { pending: 0, received: 0, done: 0, declined: 0 };
  for (const m of msgs) {
    if (m.resolution !== null && m.resolved_rev !== null && m.resolved_rev >= m.content_rev) status[m.resolution]++;
    else if (m.received_rev !== null && m.received_rev >= m.content_rev) status.received++;
    else status.pending++;
  }

  // Path collisions with live documents of the project.
  const projectKeys = new Set((db.prepare('SELECT path_key FROM documents WHERE space_id = ? AND deleted_at IS NULL').all(project.id) as { path_key: string }[]).map((r) => r.path_key));
  const collisions = live.filter((d) => projectKeys.has(d.path_key)).map((d) => d.path_key);
  if (collisions.length > 0) blocked.push(`Path collision with ${project.slug}: ${collisions.slice(0, 5).join(', ')}${collisions.length > 5 ? ` and ${collisions.length - 5} more` : ''}.`);

  const webhooks = (db.prepare('SELECT count(*) AS n FROM webhooks WHERE space_id = ?').get(inbox.id) as { n: number }).n;
  if (webhooks > 0) blocked.push(`${webhooks} webhook(s) on ${inbox.slug}: on the project they would see every document. Remove them first.`);

  if (!noAmbientGrants(project) && projectGrants.some((g) => g.subject_type === 'group' && g.subject_id === snap.allAgentsGroupId)) {
    blocked.push(`${project.slug} has grants for ${ALL_AGENTS_GROUP}; with messages on they would stop working. Grant agents explicitly first.`);
  }

  // Members.
  const principals = db.prepare("SELECT * FROM principals WHERE tenant_id = ? AND kind != 'system' AND disabled_at IS NULL ORDER BY name").all(core.tenantId) as PrincipalRow[];
  const members: MemberPreview[] = [];
  const grants: Plan['grants'] = [];
  const mailFolders = new Set<string>();
  const customInbox: string[] = [];
  for (const row of principals) {
    const ctx = contextForRow(core, row);
    const inboxMine = mineOf(ctx, inboxGrants);
    const projectMine = mineOf(ctx, projectGrants);
    const superadmin = isSuperadmin(ctx);
    const own = msgs.filter((m) => m.sender_id === row.id || m.recipient_id === row.id).length;
    if (inboxMine.length === 0 && projectMine.length === 0 && !superadmin && own === 0) continue;
    const external = row.external === 1;
    const personalInbox = personalSpaceGrant(inboxGrants, row.id);
    const member = personalInbox !== undefined && atLeast(personalInbox.role, 'guest');
    const personalProject = personalSpaceGrant(projectGrants, row.id);
    const inboxSpaceRole = roleAt(ctx, inbox);
    const inboxRole: LadderRole = isMessageOnly(ctx, inbox) ? (member ? 'guest' : 'none') : LADDER[inboxSpaceRole];
    const projectRole = roleAt(ctx, project);
    const flags: MemberFlag[] = [];
    const blocks: MemberBlock[] = [];
    let after: LadderRole = LADDER[projectRole];
    let add: Role | null = null;
    // Grants with no simple mapping in the inbox space.
    if (inboxMine.some((g) => g.scope !== 'space' || g.subject_type === 'group' || g.role === 'propose' || g.role === 'none')) {
      blocks.push('inbox_custom_grant');
      customInbox.push(row.name);
    }
    if (superadmin) {
      flags.push('superadmin');
      after = 'admin';
      if (member && !personalProject) {
        add = 'admin';
        flags.push('membership_made_explicit');
      }
    } else if (external) {
      flags.push('external');
      if (atLeast(projectRole, 'read')) blocks.push('external_loses_documents');
      if (member && !personalProject) {
        add = 'guest';
        flags.push('becomes_guest');
      }
      after = member || personalProject ? 'guest' : 'none';
    } else if (member) {
      if (personalProject?.role === 'none') blocks.push('project_deny');
      else if (!atLeast(projectRole, 'read')) {
        add = 'guest';
        after = 'guest';
        flags.push('becomes_guest');
      } else if (projectRole === 'propose') blocks.push('project_propose');
      else if (projectRole === 'read' && atLeast(inboxSpaceRole, 'write')) blocks.push('loses_send');
      else if (!personalProject) {
        add = projectRole;
        flags.push('membership_made_explicit');
      }
    } else if (personalProject && personalProject.role !== 'none') {
      flags.push('becomes_recipient');
    } else if (atLeast(projectRole, 'read')) {
      flags.push('not_a_recipient');
    }
    const inboxAdmin = isSpaceAdmin(ctx, inbox);
    const othersMail = msgs.length > own;
    if (!superadmin && inboxAdmin && after !== 'admin' && othersMail) flags.push('loses_oversight');
    if (!superadmin && after === 'admin' && !inboxAdmin && othersMail) {
      flags.push('gains_oversight');
      if (!opts.acceptOversight) blocks.push('oversight_not_accepted');
    }
    // Everyone who can receive in the project afterwards has a mail folder there.
    if (member || add !== null || flags.includes('becomes_recipient')) mailFolders.add(row.name.toLowerCase());
    const mailBefore = msgs.filter((m) => atLeast(roleAt(ctx, inbox, m.path_key, m.doc_id), 'read')).length;
    const mailAfter = superadmin || after === 'admin' ? msgs.length : after === 'none' && !member ? 0 : own;
    members.push({
      name: row.name,
      kind: row.kind,
      external,
      inbox_role: inboxRole,
      project_before: LADDER[projectRole],
      project_after: after,
      grant_added: blocks.length > 0 ? null : add,
      own_mail: own,
      mail_before: mailBefore,
      mail_after: mailAfter,
      flags,
      blocks,
    });
    if (add !== null && blocks.length === 0) grants.push({ principalId: row.id, role: add });
  }
  for (const m of members) {
    if (m.blocks.length === 0) continue;
    if (m.blocks.includes('inbox_custom_grant')) continue;
    blocked.push(`${m.name}: ${m.blocks.map(blockText).join('; ')}.`);
  }
  if (customInbox.length > 0) blocked.push(`Folder, document, group, propose or none grants in ${inbox.slug} (${customInbox.join(', ')}): ambiguous; make them plain memberships first.`);
  // A project folder that will hold mail must not already hold project documents or folder grants.
  for (const f of [...mailFolders].sort()) {
    const docsThere = [...projectKeys].filter((k) => topFolder(k) === f);
    if (docsThere.length > 0) blocked.push(`${project.slug}/${f}/ holds ${docsThere.length} project document(s); it would become ${f}'s mail folder. Move them first.`);
    if (projectGrants.some((g) => g.scope === 'path' && g.path_prefix !== null && (g.path_prefix.startsWith(`${f}/`) || `${f}/`.startsWith(g.path_prefix)))) {
      blocked.push(`Folder grant on ${project.slug} covering ${f}/ would change who reads ${f}'s mail. Remove it first.`);
    }
  }
  const revisions = (db.prepare('SELECT count(*) AS n FROM revisions r JOIN documents d ON d.id = r.doc_id WHERE d.space_id = ?').get(inbox.id) as { n: number }).n;
  const proposals = (db.prepare('SELECT count(*) AS n FROM proposals WHERE space_id = ?').get(inbox.id) as { n: number }).n;
  const counts: PairCounts = {
    documents: docs.length,
    live_documents: live.length,
    messages: msgs.length,
    ...status,
    agent_cards: cards.length,
    revisions,
    proposals,
    bytes: inbox.bytes_used,
  };
  const participants = [...new Set(msgs.flatMap((m) => [m.sender_id, m.recipient_id]))];
  return {
    preview: { project: project.slug, inbox: inbox.slug, ok: blocked.length === 0, blocked, counts, mail_folders: [...mailFolders].sort(), members },
    project,
    inbox,
    grants,
    participants,
  };
}

function blockText(b: MemberBlock): string {
  switch (b) {
    case 'external_loses_documents':
      return 'external with document access in the project; with messages on it would read only its own mail there';
    case 'project_deny':
      return 'has a personal "none" on the project';
    case 'project_propose':
      return 'is a Proposer of the project; its messages would need review';
    case 'loses_send':
      return 'can send in the inbox but is only a Viewer of the project; it could no longer send';
    case 'inbox_custom_grant':
      return 'folder, document, group, propose or none grant in the inbox space';
    case 'oversight_not_accepted':
      return 'project Admin would gain oversight of historic mail; pass --accept-oversight if intended';
  }
}

function checkPairs(pairs: readonly SpacePair[]): void {
  if (pairs.length === 0) throw invalidInput('pair', 'Declare at least one pair: --pair <project>=<inbox>.');
  const seen = new Set<string>();
  for (const p of pairs) {
    if (p.project === p.inbox) throw invalidInput('pair', 'Project and inbox must be two different spaces.');
    for (const s of [p.project, p.inbox]) {
      if (seen.has(s)) throw invalidInput('pair', `${s} appears in more than one pair.`);
      seen.add(s);
    }
  }
}

/** Dry run: what an apply would do, per declared pair. Writes nothing. */
export function previewSpacesMigration(core: Core, pairs: readonly SpacePair[], opts: { acceptOversight?: boolean } = {}): SpacesMigration {
  checkPairs(pairs);
  const out = pairs.map((p) => plan(core, p, { acceptOversight: opts.acceptOversight === true }).preview);
  return { dry_run: true, ok: out.every((p) => p.ok), pairs: out };
}

/**
 * Applies every pair in one transaction, or nothing: the preview is recomputed inside the
 * transaction and any blocked pair aborts the whole run (conflict, reason `migration_blocked`).
 */
export function applySpacesMigration(core: Core, pairs: readonly SpacePair[], opts: { acceptOversight?: boolean; actorId: string | null; via: string }): SpacesMigration {
  checkPairs(pairs);
  const db = core.db;
  const now = core.now();
  const accept = opts.acceptOversight === true;
  const result = db
    .transaction(() => {
      const plans = pairs.map((p) => plan(core, p, { acceptOversight: accept }));
      const bad = plans.filter((p) => !p.preview.ok);
      if (bad.length > 0) {
        throw new OpError(
          'conflict',
          { reason: 'migration_blocked', pairs: bad.map((p) => ({ project: p.preview.project, inbox: p.preview.inbox, blocked: p.preview.blocked })) },
          `Migration blocked (nothing changed): ${bad.map((p) => `${p.preview.project}=${p.preview.inbox}: ${p.preview.blocked.join(' ')}`).join(' | ')}`,
        );
      }
      for (const p of plans) {
        const { project, inbox } = p;
        // Re-home: the same rows, only the space changes. The live-path unique index would refuse a collision (the whole run rolls back).
        db.prepare('UPDATE documents SET space_id = ? WHERE space_id = ?').run(project.id, inbox.id);
        db.prepare('UPDATE proposals SET space_id = ? WHERE space_id = ?').run(project.id, inbox.id);
        // A finished export of the inbox: its download re-checks every document at the destination.
        db.prepare('UPDATE exports SET space_id = ? WHERE space_id = ?').run(project.id, inbox.id);
        db.prepare('UPDATE spaces SET bytes_used = bytes_used + ?, inbox = 1 WHERE id = ?').run(inbox.bytes_used, project.id);
        db.prepare('UPDATE spaces SET bytes_used = 0, alias_of = ?, archived_at = COALESCE(archived_at, ?), archived_by = COALESCE(archived_by, ?) WHERE id = ?').run(
          project.id,
          now,
          opts.actorId,
          inbox.id,
        );
        for (const g of p.grants) {
          upsertGrant(db, {
            id: newId(now),
            space_id: project.id,
            scope: 'space',
            path_prefix: null,
            doc_id: null,
            subject_type: 'principal',
            subject_id: g.principalId,
            role: g.role,
            granted_by: opts.actorId,
            granted_at: now,
          });
        }
        recordAudit(core, {
          principal_id: opts.actorId,
          token_id: null,
          via: opts.via,
          op: 'migrate_spaces',
          outcome: 'ok',
          request_id: null,
          ip: null,
          space_id: project.id,
          detail: { project: project.slug, inbox: inbox.slug, ...p.preview.counts, grants_added: p.grants.length },
        });
      }
      bumpAcl(core);
      return plans;
    })
    .immediate();
  // Outstanding waits re-read with the new snapshot: no receipt, no synthetic mail (they park again).
  core.waiters.wake(new Set(result.flatMap((p) => p.participants)));
  return { dry_run: false, ok: true, pairs: result.map((p) => p.preview) };
}

/** Plain-text report (CLI, MCP rendering). */
export function renderSpacesMigration(m: SpacesMigration): string {
  const lines: string[] = [m.dry_run ? 'Space migration preview (dry run: nothing was changed).' : 'Space migration applied.', ''];
  for (const p of m.pairs) {
    const c = p.counts;
    lines.push(`${p.inbox} → ${p.project}: ${p.ok ? (m.dry_run ? 'ready' : 'done') : 'BLOCKED'}`);
    lines.push(
      `  moves ${c.documents} document(s) (${c.live_documents} live, ${c.documents - c.live_documents} in trash), ${c.revisions} revision(s), ${c.proposals} proposal(s), ${c.bytes} bytes`,
      `  messages ${c.messages}: ${c.pending} pending, ${c.received} received, ${c.done} done, ${c.declined} declined; agent cards ${c.agent_cards}`,
      `  ids, revisions, paths, receipts, TTLs and request ids unchanged; ${p.inbox} stays as an alias (archived, hidden)`,
    );
    if (p.mail_folders.length > 0) lines.push(`  mail folders in ${p.project}: ${p.mail_folders.map((f) => `${f}/`).join(', ')}`);
    for (const x of p.members) {
      const who = `${x.name} (${x.kind}${x.external ? ', external' : ''})`;
      const role = x.project_before === x.project_after ? x.project_after : `${x.project_before} → ${x.project_after}`;
      const grant = x.grant_added ? `; adds ${x.grant_added} membership` : '';
      const mail = x.mail_before === x.mail_after ? `mail ${x.mail_after}` : `mail ${x.mail_before} → ${x.mail_after}`;
      lines.push(`  ${x.blocks.length > 0 ? '!' : ' '} ${who}: inbox ${x.inbox_role}; project ${role}${grant}; ${mail} (own ${x.own_mail})`);
      const notes = [...x.flags.map((f) => (f === 'gains_oversight' ? 'gains oversight' : f.replaceAll('_', ' '))), ...x.blocks.map((b) => `BLOCKS: ${b.replaceAll('_', ' ')}`)];
      if (notes.length > 0) lines.push(`      ${notes.join(', ')}`);
    }
    for (const b of p.blocked) lines.push(`  blocked: ${b}`);
    lines.push('');
  }
  lines.push(
    m.ok
      ? m.dry_run
        ? 'Apply with: brain migrate-spaces --apply (same --pair flags), with the server stopped.'
        : 'Restart the server.'
      : 'Nothing can be applied until every declared pair is ready.',
  );
  return lines.join('\n');
}
