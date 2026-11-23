import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'brain' && pkg.version) return pkg.version;
    }
    dir = path.dirname(dir);
  }
  return '0.0.0';
}

export const SERVER_VERSION = readVersion();

/** Version of the v1 contract: `1.N`, bumped on every extension. Started at 1.0; 1.1 — admin_connect_guide; 1.2 — start_here; 1.3 — list without space, admin_space_create.grant; 1.4 — start_here spaces[].inbox; 1.5 — handoff_send, handoff_inbox, handoff_ack, read.handoff, inbox statuses in start_here; 1.6 — space setting inbox, handoff_send.space, handoff_inbox.space, GET /api/v1/inbox; 1.7 — handoff_wait, GET /api/v1/inbox?wait and server_time, external principals (admin_principal_*.external, owner_label, limits), handoff message from_external/to_external, read.handoff.external_from, start_here mail/external; 1.8 — handoff_recipients (REST), spaces[].archived; 1.9 — role `guest`, explain level `mail`, mail read predicate (messages private to sender, recipient and space admins); 1.10 — space aliases (old inbox slugs resolve to their project space), canonical_space on handoff messages / handoff_inbox / handoff_wait, activity.include_messages (messages left out by default), list.include_messages, handoff message snippet, admin_spaces_preview; 1.11 — profile_get, profile_update, admin_space_members, admin_profile_get, admin_access_explain spaces[].member (role ladder), admin_principal_* what_i_do/contact/last_seen, handoff_recipients what_i_do, start_here onboarding.op (profile instead of agent card); 1.12 — admin_agent_connect (agent + memberships + token at once, bundle shown once), admin_agent_connection (live check, negative probe), harnesses codex and script in admin_connect_guide; 1.13 — client-held mail cursor: GET /api/v1/inbox next_cursor, ?since= (events, more, resync) and ?events=, handoff_wait since/events/next_cursor. */
export const CONTRACT_VERSION = '1.13';
