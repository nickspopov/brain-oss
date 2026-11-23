// Demo server for the screenshot tour (`npm run screenshots`): the real app on a
// throwaway data directory with the built web/dist and a realistic demo seed (people, agents,
// spaces, groups, documents with history, handoff messages, a proposal, an attention item, grants at
// space/folder/document level). Nothing here is used by the product.
//
// Determinism: the server clock is fixed. While seeding it starts at SEED_START and moves forward
// by explicit steps, so revisions, messages and audit rows get stable, spread-out timestamps; after
// seeding it runs from PRESENT (the tour pins the browser clock to the same instant). Passwords and
// tokens are throwaway demo values of a temporary instance, not secrets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createSuperadmin } from '../src/core/principals.js';
import { applySpacesMigration, previewSpacesMigration, renderSpacesMigration } from '../src/core/spacesmigrate.js';
import { issueToken } from '../src/core/tokens.js';

export const SEED_START = Date.UTC(2026, 10, 9, 8, 0, 0); // Mon 2026-11-09 08:00 UTC
export const PRESENT = Date.UTC(2026, 10, 17, 10, 0, 0); // Tue 2026-11-17 10:00 UTC
const ALICE_PASSWORD = 'demo-password-alice';
const BOB_PASSWORD = 'demo-password-bob';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SHOTS_PORT ?? '7481');
const statePath = process.env.SHOTS_STATE ?? path.join(os.tmpdir(), `brain-shots-${port}.json`);
const webDir = path.join(root, 'web', 'dist');
if (!fs.existsSync(path.join(webDir, 'index.html'))) {
  console.error(`screenshots-server: ${webDir}/index.html is missing: run \`npm run build:web\` first`);
  process.exit(1);
}

let seeding = true;
let clock = SEED_START;
let liveSince = 0;
const now = (): number => (seeding ? clock : PRESENT + (Date.now() - liveSince));
/** Moves the seed clock forward. */
const tick = (minutes: number): void => {
  clock += Math.round(minutes * 60_000);
  if (clock >= PRESENT) throw new Error('seed clock ran past PRESENT');
};
const at = (day: number, hour: number, minute = 0): void => {
  const t = SEED_START + (day * 24 + hour - 8) * 3_600_000 + minute * 60_000;
  if (t < clock) throw new Error(`seed clock would go back: day ${day} ${hour}:${minute}`);
  clock = t;
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-shots-'));
const origin = `http://127.0.0.1:${port}`;
const config = loadConfig({
  BRAIN_DEV: '1',
  BRAIN_HOST: '127.0.0.1',
  BRAIN_PORT: String(port),
  BRAIN_ORIGIN: origin,
  BRAIN_DATA_DIR: dataDir,
  BRAIN_WEB_DIR: webDir,
  BRAIN_LOG_LEVEL: 'warn',
  BRAIN_BACKGROUND: '0',
  BRAIN_RATE_WRITE: '100000',
  BRAIN_RATE_READ: '100000',
  BRAIN_RATE_SEARCH: '100000',
  BRAIN_RATE_AUTH_FAIL: '100000',
});
const app = createApp(config, { now });
let ready = false;
app.server.get('/api/shots-ready', async (_req, reply) => reply.code(ready ? 200 : 503).send({ ready }));

const alice = createSuperadmin(app.core, 'alice', ALICE_PASSWORD, 'Alice');
const tokens: Record<string, string> = { alice: issueToken(app.core, alice.id, { label: 'alice CLI', createdBy: alice.id }).token };

async function call<T = Record<string, unknown>>(who: string, op: string, input: Record<string, unknown>): Promise<T> {
  const token = tokens[who];
  if (!token) throw new Error(`no token for ${who}`);
  const res = await fetch(`${origin}/api/v1/ops/${op}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (res.status !== 200 || body.result === undefined) throw new Error(`${who} ${op} → ${res.status}: ${JSON.stringify(body.error ?? body)}`);
  tick(0.5);
  return body.result;
}

interface DocOut {
  doc: { id: string; rev: number };
}
const revs = new Map<string, { id: string; rev: number }>();
/** Writes (creates or edits) a document as `who`, remembering the head revision. */
async function write(who: string, space: string, p: string, content: string, message: string): Promise<{ id: string; rev: number }> {
  const key = `${space}/${p}`;
  const prev = revs.get(key);
  const r = await call<DocOut>(who, 'write', { space, path: p, content, message, ...(prev ? { expected_rev: prev.rev } : {}) });
  revs.set(key, r.doc);
  return r.doc;
}

interface MessageOut {
  message: { id: string };
  doc: { rev: number };
}
async function send(from: string, to: string, title: string, body: string, space?: string, replyTo?: MessageOut): Promise<MessageOut> {
  return call<MessageOut>(from, 'handoff_send', { to, title, body, ...(replyTo ? { reply_to: replyTo.message.id } : space ? { space } : {}) });
}
async function ack(who: string, m: MessageOut, status: 'received' | 'done' | 'declined', note?: string): Promise<void> {
  await call(who, 'handoff_ack', { id: m.message.id, expected_rev: m.doc.rev, status, ...(note ? { note } : {}) });
}

const grant = (space: string, subject: { type: 'principal' | 'group'; name: string }, role: string, target: { path?: string; doc?: string } = {}) =>
  call('alice', 'admin_grant_set', {
    space,
    subject,
    role,
    scope: target.doc ? 'doc' : target.path ? 'path' : 'space',
    ...(target.path ? { path_prefix: target.path } : {}),
    ...(target.doc ? { doc_id: target.doc } : {}),
  });
const P = (name: string) => ({ type: 'principal' as const, name });
const G = (name: string) => ({ type: 'group' as const, name });

async function issue(name: string, label: string, days: number | null = 90): Promise<string> {
  const r = await call<{ token: string; info: { id: string } }>('alice', 'admin_token_issue', { principal: name, label, days });
  tokens[name] = r.token;
  return r.info.id;
}

async function seedPeople(): Promise<void> {
  at(0, 9);
  await call('alice', 'admin_principal_create', { name: 'bob', kind: 'human', display_name: 'Bob (Manager)', trust: 'trusted', password: BOB_PASSWORD });
  await call('alice', 'admin_principal_create', { name: 'dave', kind: 'human', display_name: 'Dave Miller', trust: 'trusted', password: 'demo-password-dave' });
  const agents: [string, string, string, string, boolean?][] = [
    ['alice-assistant', 'Claude (lead dev)', 'admin', 'claude-code', true],
    ['alice-helper', 'Hermes (research)', 'trusted', 'hermes'],
    ['alice-coder', 'Letta (memory)', 'limited', 'letta'],
    ['bob-agent', 'Bob\'s agent (household)', 'trusted', 'openclaw'],
    ['alice-project-agent', 'Alphabot (Alpha project)', 'trusted', 'claude-code'],
    ['old-scraper', 'Old web scraper', 'limited', 'cron'],
  ];
  for (const [name, display, trust, harness, admin] of agents) {
    tick(3);
    await call('alice', 'admin_principal_create', {
      name,
      kind: 'agent',
      display_name: display,
      trust,
      harness,
      owner: name === 'alice-project-agent' ? 'bob' : 'alice',
      ...(admin ? { admin: true } : {}),
    });
  }
  tick(5);
  await call('alice', 'admin_principal_create', {
    name: 'ext-bob-agent',
    kind: 'agent',
    display_name: 'Bob’s assistant',
    trust: 'limited',
    external: true,
    owner_label: 'Bob',
  });
  tick(5);
  await issue('alice-assistant', 'Claude Code on Pi', 90);
  await issue('alice-helper', 'laptop', 90);
  await issue('alice-coder', 'Letta server', 30);
  await issue('bob-agent', 'Home hub', null);
  await issue('alice-project-agent', 'Alphabot CI', 90);
  await issue('ext-bob-agent', 'Bob laptop', 30);
  await issue('old-scraper', 'scraper cron', 90);
  // A revoked token in the list.
  const old = await call<{ info: { id: string } }>('alice', 'admin_token_issue', { principal: 'alice-helper', label: 'Hermes old laptop', days: 90 });
  tick(10);
  await call('alice', 'admin_token_revoke', { id: old.info.id });
}

async function seedSpaces(): Promise<void> {
  at(0, 10);
  const spaces: [string, Record<string, unknown>][] = [
    ['shared', { name: 'Shared', description: 'Common knowledge of the team: onboarding, conventions, recipes.', executable: true, protected_paths: ['AGENTS.md'] }],
    ['handoff', { name: 'General', description: 'Messages between agents and people.', inbox: true, ttl_days: 14 }],
    ['admin', { name: 'Admin', description: 'Runbooks and policies for operators.', review_mode: 'limited' }],
    ['proj-alpha', { name: 'Alpha project', description: 'Specs, roadmap and meeting notes of Alpha.' }],
    ['proj-alpha-inbox', { name: 'Alpha inbox', description: 'Messages for the Alpha team.', inbox: true, ttl_days: 30 }],
    ['old-wiki', { name: 'Old wiki', description: 'The wiki before Brain. Read-only, archived.' }],
  ];
  for (const [slug, s] of spaces) {
    tick(2);
    await call('alice', 'admin_space_create', { slug, ...s });
  }

  // Groups: one with a disabled member (old-scraper is disabled later).
  await call('alice', 'admin_group_create', { name: 'curators', description: 'Agents that keep the shared knowledge tidy' });
  await call('alice', 'admin_group_members_set', { name: 'curators', members: ['alice-assistant', 'alice-helper'] });
  await call('alice', 'admin_group_create', { name: 'alpha-team', description: 'Everyone working on Alpha' });
  await call('alice', 'admin_group_members_set', { name: 'alpha-team', members: ['bob', 'alice-project-agent', 'alice-coder', 'old-scraper'] });
  await call('alice', 'admin_group_create', { name: 'household', description: 'Home automation agents' });
  await call('alice', 'admin_group_members_set', { name: 'household', members: ['bob-agent'] });

  // Space-level grants.
  tick(5);
  await grant('shared', G('curators'), 'admin');
  await grant('shared', G('all-agents'), 'read');
  await grant('shared', P('alice-helper'), 'write');
  await grant('shared', P('bob-agent'), 'write');
  await grant('shared', P('bob'), 'read');
  await grant('admin', P('alice-assistant'), 'admin');
  await grant('proj-alpha', G('alpha-team'), 'write');
  await grant('proj-alpha', P('bob'), 'admin');
  await grant('proj-alpha', P('alice-assistant'), 'read');
  // Inbox spaces: recipients need an explicit grant.
  for (const a of ['alice-assistant', 'alice-helper', 'alice-coder', 'bob-agent', 'alice-project-agent', 'ext-bob-agent']) await grant('handoff', P(a), 'write');
  await grant('handoff', P('alice'), 'admin');
  await grant('handoff', P('bob'), 'write');
  await grant('proj-alpha-inbox', P('bob'), 'admin');
  await grant('proj-alpha-inbox', P('alice-project-agent'), 'write');
  await grant('proj-alpha-inbox', P('ext-bob-agent'), 'write');
  await grant('old-wiki', P('alice-helper'), 'read');
  // Folder-level: letta only proposes in specs/, a deny on a private folder of shared.
  await grant('proj-alpha', P('alice-coder'), 'propose', { path: 'specs' });
  await grant('shared', G('all-agents'), 'none', { path: 'private' });
}

const md = (title: string, ...paras: string[]): string => `# ${title}\n\n${paras.join('\n\n')}\n`;

async function seedDocs(): Promise<void> {
  // Day 0–1: initial content.
  at(0, 11);
  await write('alice', 'shared', 'AGENTS.md', md('Agents memo', 'Read `onboarding/getting-started.md` first.', '- Write in English.\n- No secrets in documents.\n- Ask in handoff when unsure.'), 'memo for agents');
  await write('alice-helper', 'shared', 'onboarding/getting-started.md', md('Getting started', 'Brain is the shared memory of our agents and people.', '## First steps\n\n1. Call `start_here`.\n2. Read the AGENTS memo of the space.\n3. Search before you write.'), 'first draft of onboarding');
  await write('alice-helper', 'shared', 'onboarding/faq.md', `---\ntitle: Frequently asked questions\ntags: [onboarding, faq]\n---\n${md('FAQ', '**Can I delete a document?** Yes: it goes to the trash with its history.', '**Who sees my edits?** Everyone with read access to the space; see the activity feed.')}`, 'faq');
  await write('alice-helper', 'shared', 'onboarding/tools.md', md('Tools', '| Tool | What for |\n| --- | --- |\n| `search` | find documents |\n| `write` | create or replace |\n| `edit` | small changes |\n| `handoff_send` | message an agent |'), 'tools table');
  await write('alice-assistant', 'shared', 'conventions/naming.md', md('Naming', 'Paths are lowercase with hyphens: `meetings/2026-11-12.md`.', 'Titles come from the first heading.'), 'naming conventions');
  await write('alice-assistant', 'shared', 'conventions/commit-messages.md', md('Revision messages', 'Say *why*, not *what*: “fix typo in deploy steps”.'), 'revision messages');
  await write('bob-agent', 'shared', 'recipes/deploy-pi.md', md('Deploy on the Raspberry Pi', '```sh\nsystemctl --user restart brain\njournalctl --user -u brain -f\n```', 'Check `/healthz` afterwards.'), 'deploy recipe');
  await write('alice-assistant', 'shared', 'recipes/backup.md', md('Backups', 'Nightly at 03:00 to the NAS. Keep 14 days.'), 'backup recipe');
  await write('alice', 'shared', 'glossary.md', md('Glossary', '**Space** — a folder tree with its own access.\n\n**Grant** — a role for a principal or group.\n\n**Proposal** — an edit that waits for a curator.'), 'glossary');
  await write('alice', 'shared', 'drafts/old-plan.md', md('Old plan', 'Superseded by the roadmap.'), 'old plan');
  await write('alice', 'shared', 'private/salary-notes.md', md('Private notes', 'Hidden from all agents by a folder deny.'), 'private notes');
  at(0, 15);
  await write('alice', 'admin', 'runbooks/incident.md', md('Incident runbook', '1. Check `/healthz`.\n2. Look at the audit for failed logins.\n3. Post in handoff to alice.'), 'incident runbook');
  await write('alice', 'admin', 'runbooks/rotate-tokens.md', md('Rotate tokens', 'Every 90 days: issue a new token, update the agent, revoke the old one.'), 'token rotation');
  await write('alice-assistant', 'admin', 'policies/access.md', md('Access policy', 'Agents get the narrowest role that works. Humans decide external agents.'), 'access policy');
  at(1, 10);
  await write('bob', 'proj-alpha', 'README.md', md('Alpha', 'A small billing service for tutors. See `roadmap.md`.'), 'project readme');
  await write('bob', 'proj-alpha', 'roadmap.md', md('Roadmap', '## Q4\n\n- [x] Invoices\n- [ ] Stripe payouts\n- [ ] Mobile layout'), 'roadmap');
  await write('alice-project-agent', 'proj-alpha', 'specs/api.md', md('API spec', '`POST /invoices` creates an invoice.\n\n`GET /invoices/:id` returns it.'), 'api spec');
  await write('alice-project-agent', 'proj-alpha', 'specs/billing.md', md('Billing', 'Invoices are monthly. VAT is added for EU customers.'), 'billing spec');
  await write('bob', 'proj-alpha', 'meetings/2026-11-10.md', md('Meeting 2026-11-10', 'Present: Bob, Alice, Alphabot.', '- Ship invoices this week.\n- Payouts next sprint.'), 'meeting notes');
  await write('alice-project-agent', 'proj-alpha', 'decisions/0001-database.md', md('0001: SQLite', 'We use SQLite: one file, easy backups, enough for our load.'), 'decision record');
  await write('alice', 'old-wiki', 'notes.md', md('Old notes', 'Moved to Brain in 2026.'), 'import');
  await write('alice', 'old-wiki', 'contacts.md', md('Contacts', 'See the address book instead.'), 'import');

  // Tokens for humans are not needed for the UI; bob writes through a token for the seed only.
  // History: 2–4 revisions on several documents.
  at(2, 9);
  await write('alice-helper', 'shared', 'onboarding/getting-started.md', md('Getting started', 'Brain is the shared memory of our agents and people.', '## First steps\n\n1. Call `start_here`.\n2. Read the AGENTS memo of the space.\n3. Search before you write.\n4. Prefer `edit` for small changes.'), 'add a step about edit');
  at(2, 14);
  await write('alice-assistant', 'shared', 'onboarding/getting-started.md', md('Getting started', 'Brain is the shared memory of our agents and people. Everything has history.', '## First steps\n\n1. Call `start_here`.\n2. Read the AGENTS memo of the space.\n3. Search before you write.\n4. Prefer `edit` for small changes.', '## Asking for help\n\nSend a handoff message to `alice`.'), 'help section');
  at(3, 10);
  await write('bob-agent', 'shared', 'recipes/deploy-pi.md', md('Deploy on the Raspberry Pi', '```sh\ngit pull\nnpm ci && npm run build\nsystemctl --user restart brain\njournalctl --user -u brain -f\n```', 'Check `/healthz` afterwards.'), 'build before restart');
  at(3, 16);
  await write('bob', 'proj-alpha', 'roadmap.md', md('Roadmap', '## Q4\n\n- [x] Invoices\n- [x] Stripe payouts\n- [ ] Mobile layout\n- [ ] Tax report'), 'payouts done, tax report');
  at(4, 11);
  await write('alice-project-agent', 'proj-alpha', 'specs/api.md', md('API spec', '`POST /invoices` creates an invoice.\n\n`GET /invoices/:id` returns it.\n\n`POST /payouts` starts a payout (idempotent with `Idempotency-Key`).'), 'payouts endpoint');
  at(4, 15);
  await write('alice-project-agent', 'proj-alpha', 'specs/api.md', md('API spec', 'All endpoints need a bearer token.', '`POST /invoices` creates an invoice.\n\n`GET /invoices/:id` returns it.\n\n`POST /payouts` starts a payout (idempotent with `Idempotency-Key`).'), 'auth note');
  at(5, 9);
  await write('alice-assistant', 'shared', 'glossary.md', md('Glossary', '**Space** — a folder tree with its own access.\n\n**Grant** — a role for a principal or group.\n\n**Proposal** — an edit that waits for a curator.\n\n**Handoff** — a message between agents.'), 'handoff term');
  await write('alice', 'admin', 'runbooks/incident.md', md('Incident runbook', '1. Check `/healthz`.\n2. Look at the audit for failed logins.\n3. Disable the agent if a token leaked.\n4. Post in handoff to alice.'), 'leaked token step');

  // Trash: one deleted document.
  at(5, 12);
  const old = revs.get('shared/drafts/old-plan.md');
  if (old) await call('alice', 'delete', { space: 'shared', path: 'drafts/old-plan.md', expected_rev: old.rev, message: 'superseded by roadmap' });

  // Proposals: letta (propose on specs/) → one accepted, one open; executable shared → attention.
  at(5, 16);
  const billing = revs.get('proj-alpha/specs/billing.md');
  const accepted = await call<{ proposal: { id: string } }>('alice-coder', 'propose', {
    space: 'proj-alpha',
    path: 'specs/billing.md',
    content: md('Billing', 'Invoices are monthly. VAT is added for EU customers.', 'Refunds are issued within 14 days.'),
    base_rev: billing?.rev,
    message: 'add refunds',
  });
  tick(90);
  await call('bob', 'proposal_decide', { id: accepted.proposal.id, decision: 'accept', note: 'Thanks, good catch.' });
  at(6, 10);
  const api = revs.get('proj-alpha/specs/api.md');
  await call('alice-coder', 'propose', {
    space: 'proj-alpha',
    path: 'specs/api.md',
    content: md('API spec', 'All endpoints need a bearer token.', '`POST /invoices` creates an invoice.\n\n`GET /invoices/:id` returns it.\n\n`POST /payouts` starts a payout (idempotent with `Idempotency-Key`).\n\n`GET /payouts/:id` returns the payout status.'),
    base_rev: api?.rev,
    message: 'document payout status endpoint',
  });
  // Attention item: a non-admin (trusted) agent edits the executable space.
  at(6, 13);
  await write('bob-agent', 'shared', 'recipes/backup.md', md('Backups', 'Nightly at 03:00 to the NAS. Keep 14 days.', 'Also copy `deploy/backups/` to the USB disk every Sunday.'), 'add weekly USB copy');
}

async function seedHandoff(): Promise<void> {
  at(6, 17);
  const digest = await send('alice-helper', 'alice', 'Weekly research digest is ready', 'Five papers on agent memory; summary in shared/onboarding. Want a deeper dive on any of them?');
  void digest;
  tick(20);
  const bobAgent = await send('bob-agent', 'alice', 'Grocery order confirmed', 'Delivery on Thursday 18:00–20:00. Total 42.10 EUR.');
  tick(15);
  const deploy = await send('alice-assistant', 'alice', 'Deploy of the account page finished', 'CI green, deployed to the Pi, /healthz ok. Account page is live.');
  tick(15);
  const keys = await send('alice-project-agent', 'alice', 'Need Stripe live keys', 'To test payouts end-to-end I need the live keys in the CI environment.');
  at(7, 9);
  await ack('alice', bobAgent, 'received');
  await ack('alice', deploy, 'done', 'Checked, looks good.');
  await ack('alice', keys, 'declined', 'Use the test keys; live keys never go to CI.');
  tick(30);
  await send('ext-bob-agent', 'alice', 'Sprint review agenda', 'Bob asks to add “mobile layout” to Friday’s review. 30 minutes is enough.');
  tick(20);
  const ask = await send('alice', 'alice-helper', 'Summarise the design notes', 'Two paragraphs for the onboarding doc, please.');
  // A thread: hermes asks back, alice answers, hermes delivers.
  tick(10);
  const back = await send('alice-helper', 'alice', 'Re: Summarise the design notes', 'For agents or for people? The tone differs.', undefined, ask);
  await ack('alice-helper', ask, 'received');
  tick(5);
  const answer = await send('alice', 'alice-helper', 'Re: Summarise the design notes', 'For people. Plain words, no op names.', undefined, back);
  await ack('alice', back, 'done');
  tick(15);
  await send('alice-helper', 'alice', 'Re: Summarise the design notes', 'Done: shared/onboarding/design-notes.md. Two paragraphs, no jargon.', undefined, answer);
  await ack('alice-helper', answer, 'done');
  const letta = await send('alice', 'alice-coder', 'Re-index the Alpha specs', 'After the API changes; tell me when done.');
  tick(40);
  await ack('alice-coder', letta, 'received');
  // Sent with mixed recipient states (Sent · Seen · Updated, not seen · Done · Declined).
  tick(5);
  const rotate = await send('alice', 'alice-assistant', 'Rotate the backup key', 'The old key goes out on Friday.');
  const disk = await send('alice', 'bob-agent', 'Check the NAS disk', 'SMART warnings since Monday?');
  const ci = await send('alice', 'alice-project-agent', 'Move Alpha CI to the Pi', 'Self-hosted runner, same as Brain.');
  tick(10);
  await ack('alice-assistant', rotate, 'received');
  await ack('bob-agent', disk, 'done', 'Disk is fine, warnings were a cable.');
  await ack('alice-project-agent', ci, 'declined', 'The Pi is too slow for the Alpha build.');
  tick(5);
  await call('alice', 'edit', { id: rotate.message.id, expected_rev: rotate.doc.rev, edits: [{ old_text: 'on Friday.', new_text: 'on Thursday now.' }], message: 'sooner' });
  await send('alice', 'bob-agent', 'Renew the domain', 'Expires in two weeks.');
  tick(10);
  await send('alice-project-agent', 'bob', 'Release notes draft for 1.4', 'Draft is in proj-alpha/meetings; please review before Friday.', 'proj-alpha-inbox');
  tick(5);
  await send('ext-bob-agent', 'alice-project-agent', 'Customer asked about refunds', 'Pointing them to specs/billing.md — correct?', 'proj-alpha-inbox');
}

async function seed(): Promise<void> {
  await seedPeople();
  // bob writes and decides through a token during the seed only.
  tokens.bob = (await call<{ token: string }>('alice', 'admin_token_issue', { principal: 'bob', label: 'seed', days: 30 })).token;
  await seedSpaces();
  await seedDocs();
  await seedHandoff();
  // Profiles (filled in by the agents themselves) and one legacy agent card (a suggestion only).
  tick(5);
  await call('alice-assistant', 'profile_update', { what_i_do: 'Builds and deploys Brain; reviews PRs.', contact: 'Message me in General; answers within the hour while a session is open.' });
  await call('alice-project-agent', 'profile_update', { what_i_do: 'Develops the Alpha mobile app.', contact: 'Message in Alpha; replies the same day.' });
  await call('bob-agent', 'profile_update', { what_i_do: 'Household: groceries, reminders, backups.' });
  await write(
    'alice-helper',
    'handoff',
    '_agents/alice-helper.md',
    md('alice-helper', '## What I do', 'Research digests and summaries for Alice.', '## How to reach', 'handoff_send to alice-helper.', '## Response time', 'Within a day.'),
    'agent card',
  );
  at(7, 12);
  await call('alice', 'admin_space_archive', { slug: 'old-wiki' });
  await call('alice', 'admin_principal_disable', { name: 'dave' });
  await call('alice', 'admin_principal_disable', { name: 'old-scraper' });
  // The Alpha inbox becomes the Messages of Alpha — preview first, then apply on this
  // throwaway demo instance only (never on real data).
  at(7, 13);
  const pairs = [{ project: 'proj-alpha', inbox: 'proj-alpha-inbox' }];
  const preview = renderSpacesMigration(previewSpacesMigration(app.core, pairs));
  console.log(preview);
  applySpacesMigration(app.core, pairs, { actorId: alice.id, via: 'cli' });
  const docIds = Object.fromEntries([...revs].map(([k, v]) => [k, v.id]));
  // Document-level grant: bob-agent may read one admin runbook.
  const rotate = docIds['admin/runbooks/rotate-tokens.md'];
  if (rotate) await grant('admin', P('bob-agent'), 'read', { doc: rotate });
  fs.writeFileSync(
    statePath,
    JSON.stringify({ origin, present: PRESENT, users: { alice: ALICE_PASSWORD, bob: BOB_PASSWORD }, docIds, migratePreview: preview }),
    { mode: 0o600 },
  );
}

async function shutdown(): Promise<void> {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(statePath, { force: true });
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.server.listen({ host: '127.0.0.1', port });
try {
  await seed();
} catch (e) {
  console.error('screenshots-server: seed failed:', e);
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
}
seeding = false;
liveSince = Date.now();
ready = true;
console.log(`screenshots-server: ${origin}`);
