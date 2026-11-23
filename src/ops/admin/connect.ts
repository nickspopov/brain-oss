// admin_connect_guide: the connection instructions for an agent and a harness.
// The token is not part of the instructions: it is issued by admin_token_issue and shown once;
// the text uses the BRAIN_TOKEN variable. Detailed pages: docs/connect/<harness>.md.
import { z } from 'zod';
import { adminConnectTarget, type ConnectTarget } from '../../core/admin.js';
import { invalidInput } from '../../core/errors.js';
import { defineOp } from '../define.js';
import { RoleSchema, TrustSchema } from '../types.js';
import { ADMIN, ADMIN_ISOLATION, NameSchema } from './common.js';

export const HARNESSES = ['claude-code', 'codex', 'connectome', 'hermes', 'letta', 'generic', 'script'] as const;
export type Harness = (typeof HARNESSES)[number];
export type Transport = 'http' | 'stdio';

/**
  * connectome-host connects MCP servers as processes (stdio) or over WebSocket: no HTTP.
 * script: a cron job with inbox-poll.sh over REST (`http`), no MCP client.
 */
const DEFAULT_TRANSPORT: Record<Harness, Transport> = {
  'claude-code': 'http',
  codex: 'http',
  connectome: 'stdio',
  hermes: 'http',
  letta: 'http',
  generic: 'http',
  script: 'http',
};
const SUPPORTED: Record<Harness, readonly Transport[]> = {
  'claude-code': ['http', 'stdio'],
  codex: ['http', 'stdio'],
  connectome: ['stdio'],
  hermes: ['http', 'stdio'],
  letta: ['http', 'stdio'],
  generic: ['http', 'stdio'],
  script: ['http'],
};

const TITLES: Record<Harness, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  connectome: 'connectome (connectome-host recipe)',
  hermes: 'Hermes Agent',
  letta: 'Letta',
  generic: 'any MCP client',
  script: 'a script or cron job',
};

/** Harness of a stored principal.harness value (aliases: cron → script). */
export function harnessOf(value: string | null | undefined): Harness | undefined {
  const v = value?.toLowerCase();
  if (v === 'cron') return 'script';
  return HARNESSES.find((h) => h === v);
}

export function defaultTransport(h: Harness): Transport {
  return DEFAULT_TRANSPORT[h];
}

export function checkTransport(harness: Harness, transport: Transport): void {
  if (!SUPPORTED[harness].includes(transport)) {
    throw invalidInput('transport', `${harness} connects over ${SUPPORTED[harness].join(' or ')}.`);
  }
}

/** Page in the repository: docs/connect/<harness>.md, the general one is README.md. */
export function docsPath(harness: Harness): string {
  return harness === 'generic' ? 'docs/connect/README.md' : `docs/connect/${harness}.md`;
}

export interface Urls {
  origin: string;
  mcp: string;
}

export function urlsOf(origin: string): Urls {
  return { origin, mcp: `${origin}/mcp/v1` };
}

const ref = (name: string) => '${' + name + '}';

/**
  * Harness configuration: what to paste and where. Without `token` the snippet refers to the variable
 * BRAIN_TOKEN (the guide); with it (the Connect-agent bundle, shown once) the token is filled in.
 * Brain knows nothing about what sits in front of it: extra headers a network needs are the
 * deployment's business (BRAIN_HEADERS for brain-mcp and inbox-poll.sh).
 */
export function connectConfig(harness: Harness, transport: Transport, u: Urls, token?: string, server = 'brain'): { where: string; config: string } {
  const T = token ?? ref('BRAIN_TOKEN');
  const S = token ?? '$BRAIN_TOKEN';
  const filled = token !== undefined;
  const stdioEnv: Record<string, string> = { BRAIN_URL: u.origin, BRAIN_TOKEN: T };
  const httpHeaders: Record<string, string> = { Authorization: `Bearer ${T}` };
  const shell = filled ? '' : ' in a shell where BRAIN_TOKEN is set';
  const yaml = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `      ${k}: "${v}"`);
  switch (harness) {
    case 'claude-code':
      return transport === 'http'
        ? {
            where: `Run${shell} (add \`--scope user\` to use it in every project):`,
            config: `claude mcp add --transport http ${server} ${u.mcp} --header "Authorization: Bearer ${S}"`,
          }
        : {
            where: `Run${shell}; brain-mcp must be on PATH:`,
            config: `claude mcp add ${server} --env BRAIN_URL=${u.origin} --env BRAIN_TOKEN=${S} -- brain-mcp`,
          };
    case 'codex':
      return transport === 'http'
        ? {
            where: filled
              ? 'Add to ~/.codex/config.toml (or run `codex mcp add` with the same values):'
              : 'Add to ~/.codex/config.toml; Codex reads the token from BRAIN_TOKEN in its environment:',
            config: [
              `[mcp_servers.${server}]`,
              `url = "${u.mcp}"`,
              filled ? `http_headers = { "Authorization" = "Bearer ${token}" }` : 'bearer_token_env_var = "BRAIN_TOKEN"',
            ].join('\n'),
          }
        : {
            where: 'Add to ~/.codex/config.toml; brain-mcp must be on PATH:',
            config: [`[mcp_servers.${server}]`, 'command = "brain-mcp"', `env = { "BRAIN_URL" = "${u.origin}", "BRAIN_TOKEN" = "${T}" }`].join('\n'),
          };
    case 'connectome':
      return {
        where:
          `Add to the agent recipe (recipes/<agent>.json)${filled ? '' : ' and put BRAIN_TOKEN=<token> in the host .env'}; ` +
          'the command path must be absolute (`which brain-mcp`), and a stdio server sees only the env it declares:',
        config: JSON.stringify({ mcpServers: { [server]: { command: '/usr/local/bin/brain-mcp', env: stdioEnv } } }, null, 2),
      };
    case 'hermes':
      return transport === 'http'
        ? {
            where: `Run${shell}, or add the YAML below to ~/.hermes/config.yaml; then restart Hermes:`,
            config: [
              `hermes mcp add ${server} --url ${u.mcp} --header "Authorization: Bearer ${S}"`,
              '',
              '# ~/.hermes/config.yaml',
              'mcp_servers:',
              `  ${server}:`,
              `    url: "${u.mcp}"`,
              '    headers:',
              ...yaml(httpHeaders),
            ].join('\n'),
          }
        : {
            where: 'Add to ~/.hermes/config.yaml and restart Hermes; brain-mcp must be on PATH:',
            config: ['mcp_servers:', `  ${server}:`, '    command: "brain-mcp"', '    env:', ...yaml(stdioEnv)].join('\n'),
          };
    case 'letta':
      return transport === 'http'
        ? {
            where:
              'In the Letta ADE: Tool Manager → Add MCP server → Streamable HTTP, with this URL and header ' +
              '(or put it in ~/.letta/settings.json); then attach the brain tools to the agent. The same as JSON:',
            config: JSON.stringify({ server_name: server, type: 'streamable_http', server_url: u.mcp, custom_headers: httpHeaders }, null, 2),
          }
        : {
            where: 'Self-hosted Letta server only: add a stdio MCP server (brain-mcp on the Letta server PATH):',
            config: JSON.stringify({ server_name: server, type: 'stdio', command: 'brain-mcp', args: [], env: stdioEnv }, null, 2),
          };
    case 'generic':
      return transport === 'http'
        ? {
            where: 'MCP client configuration (the common mcpServers form):',
            config: JSON.stringify({ mcpServers: { [server]: { type: 'http', url: u.mcp, headers: httpHeaders } } }, null, 2),
          }
        : {
            where: 'MCP client configuration (the common mcpServers form):',
            config: JSON.stringify({ mcpServers: { [server]: { command: 'brain-mcp', env: stdioEnv } } }, null, 2),
          };
    case 'script':
      return {
        where: 'Get the poll script, then wake the agent from cron only when there is mail (exit 0):',
        config: [
          `curl -fsSL ${u.origin}/inbox-poll.sh -o inbox-poll.sh && chmod +x inbox-poll.sh`,
          '',
          '# crontab -e',
          `*/5 * * * * BRAIN_URL=${u.origin} BRAIN_TOKEN=${filled ? token : '<token>'} /path/to/inbox-poll.sh >/dev/null && /path/to/run-my-agent.sh`,
        ].join('\n'),
      };
  }
}

/** The only per-agent instruction: URL, header, "call start_here". */
export function agentInstruction(u: Urls): string {
  return [`Connect the MCP server "brain" at ${u.mcp}`, 'with the header "Authorization: Bearer <your token>",', 'then call start_here once.'].join('\n');
}

/** The sentence to paste to an agent whose harness already has the Brain server configured. */
export function pasteSentence(harness: Harness): string {
  return harness === 'script'
    ? 'When inbox-poll.sh wakes you, connect to Brain and call start_here once; it tells you who you are and what to do next.'
    : 'Connect to Brain (the MCP server "brain") and call start_here once; it tells you who you are and what to do next.';
}

const HEADERS_NOTE =
  'If your network requires extra headers on every request to Brain, set BRAIN_HEADERS to a JSON object, e.g. ' +
  `BRAIN_HEADERS='{"X-Header":"value"}' (brain-mcp and inbox-poll.sh send them; Authorization always comes from BRAIN_TOKEN).`;

function guideText(harness: Harness, transport: Transport, u: Urls, target: ConnectTarget | null, cfg: { where: string; config: string }, token?: string): string {
  const who = target?.principal;
  const lines: string[] = [];
  lines.push(`# Connect ${who ? `${who.name} ` : 'an agent '}to Brain from ${TITLES[harness]}`, '');
  const how = harness === 'script' ? 'REST, polled by inbox-poll.sh' : transport === 'http' ? 'streamable HTTP' : 'stdio via brain-mcp';
  lines.push(`Server: ${u.origin}. MCP endpoint: ${u.mcp} (${how}).`, '');
  lines.push('## 1. Token', '');
  if (token !== undefined) {
    lines.push(
      `The Brain token of ${who?.name ?? 'the agent'} (shown once, Brain does not keep it): ${token}`,
      'It is filled in below. It goes only into the Authorization header, never into a URL, a document or a chat.',
      '',
    );
  } else {
    lines.push(
      who
        ? `Issue a token for ${who.name}: admin_token_issue with principal "${who.name}" (or the agent's Connection tab in the UI).`
        : 'Issue a token for the agent: admin_token_issue (or the agent\'s Connection tab in the UI).',
      'The token is shown once. Keep it in the environment variable BRAIN_TOKEN on the agent machine;',
      'it goes only into the Authorization header, never into a URL, a document or a chat.',
      '',
    );
  }
  let n = 2;
  if (transport === 'stdio') {
    lines.push(`## ${n++}. brain-mcp`, '');
    lines.push(
      'brain-mcp is a stdio proxy without local data: it forwards tools/list and tools/call to BRAIN_URL/mcp/v1',
      'with BRAIN_TOKEN. Install it on the agent machine from the Brain repository: `npm ci && npm run build && npm link`.',
      '',
    );
  }
  lines.push(`## ${n++}. Configure ${TITLES[harness]}`, '', cfg.where, '', '```', cfg.config, '```', '');
  if (transport === 'stdio' || harness === 'script') lines.push(HEADERS_NOTE, '');
  lines.push(`## ${n++}. Tell the agent`, '');
  lines.push(
    'This is all the agent needs; start_here gives it its identity, spaces, rules and next steps (the first one: fill in its profile):',
    '',
    '```',
    token !== undefined ? pasteSentence(harness) : agentInstruction(u),
    '```',
    '',
  );
  lines.push(`## ${n++}. Check`, '');
  lines.push(
    'The agent calls start_here: it must answer with its own name and trust level' +
      (target ? ` and see: ${target.spaces.length ? target.spaces.map((s) => `${s.slug} (${s.role})`).join(', ') : 'no spaces yet — grant access first'}.` : '.'),
    '',
  );
  lines.push(`## ${n++}. Messages`, '');
  lines.push(
    `Other agents and alice reach ${who ? who.name : 'the agent'} with handoff_send. It sees waiting messages in start_here and`,
    'in a one-line hint on every Brain call until it acks them (handoff_ack). Brain does not push: a harness with a',
    `heartbeat or cron can poll GET ${u.origin}/api/v1/inbox with the same token (no model needed; inbox-poll.sh`,
    'exits 0 only when there is mail) and wake the agent only then. To watch for a while: inbox-poll.sh --wait <seconds>',
    '(shell) or handoff_wait(minutes=N) (MCP only). Get the script (env BRAIN_URL, BRAIN_TOKEN, optional BRAIN_HEADERS):',
    `curl -fsSL ${u.origin}/inbox-poll.sh -o inbox-poll.sh && chmod +x inbox-poll.sh`,
    '',
  );
  lines.push(`More: ${docsPath(harness)} in the Brain repository; ${u.origin}/agents.md for the agent.`);
  if (who && who.disabled_at !== null) lines.push('', `Warning: ${who.name} is disabled; enable it before connecting.`);
  return lines.join('\n');
}

const BUNDLE_EXT: Record<Harness, string> = {
  'claude-code': 'sh',
  codex: 'toml',
  connectome: 'json',
  hermes: 'txt',
  letta: 'json',
  generic: 'json',
  script: 'sh',
};

export interface Bundle {
  harness: Harness;
  transport: Transport;
  server_url: string;
  mcp_url: string;
  where: string;
  config: string;
  sentence: string;
  text: string;
  filename: string;
}

/** The Connect-agent bundle (shown once): config with the real URL and token, the sentence, the guide. */
export function connectBundle(harness: Harness, transport: Transport, u: Urls, target: ConnectTarget, token: string): Bundle {
  checkTransport(harness, transport);
  const cfg = connectConfig(harness, transport, u, token);
  return {
    harness,
    transport,
    server_url: u.origin,
    mcp_url: u.mcp,
    where: cfg.where,
    config: cfg.config,
    sentence: pasteSentence(harness),
    text: guideText(harness, transport, u, target, cfg, token),
    filename: `brain-${target.principal.name}-${harness}.${harness === 'claude-code' && transport === 'stdio' ? 'sh' : BUNDLE_EXT[harness]}`,
  };
}

const Output = z.object({
  harness: z.enum(HARNESSES),
  transport: z.enum(['http', 'stdio']),
  mcp_url: z.string(),
  server_url: z.string(),
  principal: z
    .object({
      name: z.string(),
      kind: z.enum(['human', 'agent', 'system']),
      trust: TrustSchema,
      disabled: z.boolean(),
      spaces: z.array(z.object({ slug: z.string(), role: RoleSchema })),
    })
    .optional(),
  config: z.string(),
  text: z.string(),
  docs: z.string(),
});

export const adminConnectGuideOp = defineOp({
  name: 'admin_connect_guide',
  summary: 'Connection instructions for an agent and its harness (admin).',
  description:
    'Returns step-by-step instructions to connect an agent to this server from a harness (claude-code, codex, ' +
    'connectome, hermes, letta, generic, script) over MCP streamable HTTP or the stdio proxy brain-mcp: token, configuration snippet, check. ' +
    'With principal, the default harness is the one recorded for it and the check lists the spaces it will see. ' +
    'The token itself is never included: issue it with admin_token_issue.',
  input: z
    .object({
      principal: NameSchema.optional(),
      harness: z.enum(HARNESSES).optional(),
      transport: z.enum(['http', 'stdio']).optional(),
    })
    .strict(),
  output: Output,
  ...ADMIN,
  idempotent: false,
  handler: (ctx, i) => {
    const target = i.principal !== undefined ? adminConnectTarget(ctx, i.principal) : null;
    const recorded = harnessOf(target?.principal.harness);
    const harness: Harness = i.harness ?? recorded ?? 'generic';
    const transport = i.transport ?? DEFAULT_TRANSPORT[harness];
    checkTransport(harness, transport);
    const origin = ctx.core.config.origin;
    const u = urlsOf(origin);
    const cfg = connectConfig(harness, transport, u);
    return {
      harness,
      transport,
      mcp_url: u.mcp,
      server_url: origin,
      ...(target
        ? {
            principal: {
              name: target.principal.name,
              kind: target.principal.kind,
              trust: target.principal.trust,
              disabled: target.principal.disabled_at !== null,
              spaces: target.spaces,
            },
          }
        : {}),
      config: cfg.config,
      text: guideText(harness, transport, u, target, cfg),
      docs: docsPath(harness),
    };
  },
  render: (o) => o.text,
  isolation: ADMIN_ISOLATION,
});
