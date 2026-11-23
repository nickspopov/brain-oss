// Shared world for acceptance tests: spaces, agents, groups, grants, tokens, canaries.
// The world is built directly with core functions; documents are created via the `write` operation
// (seedBeta), so if that operation is missing, seeding fails with "no operation" inside the scenario,
// not in beforeAll.
import { randomBytes } from 'node:crypto';
import { findGroup, addGroupMember, createGroup } from '../../src/core/groups.js';
import { setGrant } from '../../src/core/grants.js';
import { createPrincipal, createSuperadmin } from '../../src/core/principals.js';
import { createSpace } from '../../src/core/spaces.js';
import { issueToken } from '../../src/core/tokens.js';
import type { PrincipalRow, Role, SpaceRow, Trust } from '../../src/store/types.js';
import type { WriteResult } from './api.js';
import { makeClient, type AdapterName, type Client } from './clients/index.js';
import type { Harness } from './harness.js';

export const SPACES = ['shared', 'proj-alpha', 'proj-beta', 'handoff', 'recipes'] as const;
export type SpaceSlug = (typeof SPACES)[number];

export const AGENTS = ['alice-assistant', 'alice-helper', 'alphabot', 'betabot'] as const;
export type PrincipalName = 'alice' | (typeof AGENTS)[number];

const AGENT_TRUST: Record<(typeof AGENTS)[number], Trust> = {
  'alice-assistant': 'admin',
  'alice-helper': 'trusted',
  alphabot: 'limited',
  betabot: 'trusted',
};

export const ALICE_PASSWORD = 'correct-horse-battery-staple';

/**
 * Canaries: unique "words" (letters and digits, so search can find them) that live
 * only in proj-beta. None of them may appear in any response to alphabot.
 */
export function makeCanaries() {
  const tag = randomBytes(4).toString('hex');
  const c = (field: string) => `zqbeta${field}${tag}`;
  return {
    /** Common prefix: the "no canary at all" check searches for it. */
    prefix: 'zqbeta',
    title: c('title'),
    path: c('path'),
    body: c('body'),
    tag: c('tag'),
    message: c('message'),
    folder: c('folder'),
  };
}
export type Canaries = ReturnType<typeof makeCanaries>;

export interface World {
  h: Harness;
  principals: Record<PrincipalName, PrincipalRow>;
  tokens: Record<PrincipalName, string>;
  tokenIds: Record<PrincipalName, string>;
  spaces: Record<SpaceSlug, SpaceRow>;
  groups: { curators: string };
  canary: Canaries;
  client(name: PrincipalName, adapter?: AdapterName): Client;
  /** Grant in the world (via the core; the same functions bump aclVersion). */
  grant(space: SpaceSlug, subject: { principal: PrincipalName } | { group: string }, role: Role, target?: { path?: string; docId?: string }): void;
}

export function buildWorld(h: Harness, adapter: AdapterName = 'rest'): World {
  const core = h.core;
  const alice = createSuperadmin(core, 'alice', ALICE_PASSWORD, 'Alice');
  const principals = { alice } as Record<PrincipalName, PrincipalRow>;
  for (const name of AGENTS) {
    principals[name] = createPrincipal(core, { name, kind: 'agent', trust: AGENT_TRUST[name], ownerId: alice.id }, alice.id);
  }
  const tokens = {} as Record<PrincipalName, string>;
  const tokenIds = {} as Record<PrincipalName, string>;
  for (const name of ['alice', ...AGENTS] as PrincipalName[]) {
    const t = issueToken(core, principals[name].id, { label: `${name} test`, createdBy: alice.id });
    tokens[name] = t.token;
    tokenIds[name] = t.id;
  }

  const spaces = {
    shared: createSpace(core, { slug: 'shared', name: 'Shared', description: 'Common knowledge' }, alice.id),
    'proj-alpha': createSpace(core, { slug: 'proj-alpha', name: 'Alpha project' }, alice.id),
    'proj-beta': createSpace(core, { slug: 'proj-beta', name: 'Beta project' }, alice.id),
    handoff: createSpace(core, { slug: 'handoff', name: 'Handoff', ttlDays: 14 }, alice.id),
    recipes: createSpace(core, { slug: 'recipes', name: 'Recipes', executable: true }, alice.id),
  } satisfies Record<SpaceSlug, SpaceRow>;

  const curators = createGroup(core, 'curators', 'Curator agents', alice.id);
  addGroupMember(core, curators.id, principals['alice-assistant'].id, alice.id);
  const allAgents = findGroup(core, 'all-agents');
  if (!allAgents) throw new Error('all-agents group missing');

  const world: World = {
    h,
    principals,
    tokens,
    tokenIds,
    spaces,
    groups: { curators: curators.id },
    canary: makeCanaries(),
    client: (name, a = adapter) => makeClient(a, h, tokens[name]),
    grant(space, subject, role, target) {
      const s = spaces[space];
      const subj =
        'principal' in subject
          ? { subjectType: 'principal' as const, subjectId: principals[subject.principal].id }
          : { subjectType: 'group' as const, subjectId: subject.group === 'all-agents' ? allAgents.id : subject.group === 'curators' ? curators.id : subject.group };
      setGrant(
        core,
        {
          spaceId: s.id,
          scope: target?.docId ? 'doc' : target?.path ? 'path' : 'space',
          pathPrefix: target?.path ?? null,
          docId: target?.docId ?? null,
          role,
          ...subj,
        },
        alice.id,
      );
    },
  };

  // World grants: alphabot gets proj-alpha and read on shared; betabot gets proj-beta.
  world.grant('shared', { group: 'curators' }, 'admin');
  world.grant('recipes', { group: 'curators' }, 'admin');
  world.grant('handoff', { group: 'curators' }, 'write');
  world.grant('recipes', { group: 'all-agents' }, 'read');
  world.grant('shared', { principal: 'alice-helper' }, 'write');
  world.grant('handoff', { principal: 'alice-helper' }, 'write');
  world.grant('proj-alpha', { principal: 'alphabot' }, 'write');
  world.grant('shared', { principal: 'alphabot' }, 'read');
  world.grant('handoff', { principal: 'alphabot' }, 'write');
  world.grant('proj-beta', { principal: 'betabot' }, 'write');
  world.grant('shared', { principal: 'betabot' }, 'read');
  world.grant('handoff', { principal: 'betabot' }, 'write');
  // Recipients need an explicit grant in the inbox space (migration 0008 gives one
  // to the owner; alice-assistant reached handoff only through curators).
  world.grant('handoff', { principal: 'alice' }, 'admin');
  world.grant('handoff', { principal: 'alice-assistant' }, 'write');
  return world;
}

export interface BetaDocs {
  /** Document with canaries in every field: title, path, body, tags, revision message. */
  secret: WriteResult & { doc: NonNullable<WriteResult['doc']> };
  /** Ordinary proj-beta document with a canary in the body. */
  plain: WriteResult & { doc: NonNullable<WriteResult['doc']> };
  paths: { secret: string; plain: string };
}

/** proj-beta documents with canary strings; written by betabot via the write operation. */
export async function seedBeta(w: World): Promise<BetaDocs> {
  const c = w.canary;
  const betabot = w.client('betabot');
  const secretPath = `${c.folder}/${c.path}.md`;
  const secret = await betabot.call<WriteResult>('write', {
    space: 'proj-beta',
    path: secretPath,
    content: `---\ntitle: Plan ${c.title}\ntags: [${c.tag}]\n---\n# Roadmap ${c.title}\n\nThe launch code word is ${c.body}.\n`,
    message: `seed ${c.message}`,
  });
  const plain = await betabot.call<WriteResult>('write', {
    space: 'proj-beta',
    path: 'notes.md',
    content: `# Notes\n\nInternal remark ${c.body} about the client.\n`,
    message: `notes ${c.message}`,
  });
  if (!secret.doc || !plain.doc) throw new Error('seedBeta: write did not commit');
  return { secret: secret as BetaDocs['secret'], plain: plain as BetaDocs['plain'], paths: { secret: secretPath, plain: 'notes.md' } };
}

/** Strings that must not appear in responses to alphabot: canaries, ids of the hidden space and its documents. */
export function hiddenMarkers(w: World, docs?: BetaDocs): string[] {
  const out = [w.canary.prefix, w.spaces['proj-beta'].id, 'proj-beta', w.principals.betabot.id];
  if (docs) out.push(docs.secret.doc.id, docs.plain.doc.id);
  return out;
}

export function assertNoMarkers(text: string, markers: string[], where: string): void {
  const lower = text.toLowerCase();
  for (const m of markers) {
    if (lower.includes(m.toLowerCase())) throw new Error(`hidden marker leaked in ${where}: ${m.slice(0, 12)}…`);
  }
}

export const RANDOM_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
