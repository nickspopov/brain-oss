#!/usr/bin/env node
// CLI `brain`: admin create, principal create, token issue, doctor, reindex,
// backup, vacuum, import (archive and --plain), export.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openCore } from './app.js';
import { loadConfig } from './config.js';
import { recordAudit } from './core/audit.js';
import { backup, vacuum } from './core/backup.js';
import type { Core } from './core/context.js';
import { runDoctor } from './core/doctor.js';
import type { WriteContext } from './core/documents.js';
import { OpError } from './core/errors.js';
import { createExport } from './core/export/export.js';
import { importArchive, importPlain, type PlainFile } from './core/export/import.js';
import { contextForRow } from './core/guard.js';
import { allPrincipals, createPrincipal, createSuperadmin, findPrincipal } from './core/principals.js';
import { reindexAll } from './core/search/index.js';
import { applySpacesMigration, parsePair, previewSpacesMigration, renderSpacesMigration } from './core/spacesmigrate.js';
import { issueToken } from './core/tokens.js';
import { loadMigrations } from './db/migrate.js';
import type { Trust } from './store/types.js';

const USAGE = `usage: brain <command> [options]

  admin create --name <name> [--display-name <text>] [--password-stdin]
      create a superadmin (human); password is read from the terminal, or from stdin with --password-stdin
  principal create --name <name> --kind agent|human [--trust admin|trusted|limited] [--owner <name>]
                   [--harness <name>] [--display-name <text>]
      create an agent or a member human (no password)
  token issue --principal <name> [--label <text>] [--days <n> | --no-expiry]
      issue a token; the full token is printed once
  doctor
      check database integrity
  reindex
      rebuild the search index from the head revisions of live documents
  backup --out <file>
      consistent snapshot: database (online backup API), blobs and secret.key in one tar
  vacuum
      rewrite the database file without free pages (after admin_purge)
  import <archive.tar.gz> --space <slug> [--mode restore|as-new] [--confirm-secrets] [--as <superadmin>]
      import an export archive into a new space
  import --plain <dir> --space <slug> [--as <superadmin>]
      import a plain tree of files: each file becomes a document (revision 1 by the superadmin)
  export --space <slug> [--mode head|full] --out <file> [--as <superadmin>]
      export a space as tar.gz
  migrate-spaces --preview|--apply --pair <project>=<inbox> [--pair …] [--accept-oversight] [--json] [--as <superadmin>]
      move each declared inbox space into its project space (its Messages), preserving ids, revisions, receipts,
      TTLs and request ids; the inbox slug stays as an alias. --preview writes nothing; run --apply with the
      server stopped (one transaction: every pair or none).
`;

class UsageError extends Error {}

async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

/** Reads a password from the terminal without echo. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new UsageError('stdin is not a terminal: use --password-stdin'));
      return;
    }
    process.stderr.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch: string): void => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (c === '\u0003') {
          stdin.setRawMode(false);
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

function requireString(v: unknown, flag: string): string {
  if (typeof v !== 'string' || v === '') throw new UsageError(`--${flag} is required`);
  return v;
}

const TRUST = ['admin', 'trusted', 'limited'] as const;

async function adminCreate(core: Core, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { name: { type: 'string' }, 'display-name': { type: 'string' }, 'password-stdin': { type: 'boolean' } },
  });
  const name = requireString(values.name, 'name');
  let password: string;
  if (values['password-stdin']) {
    password = await readPasswordFromStdin();
  } else {
    password = await promptHidden(`password for ${name}: `);
    const again = await promptHidden('repeat password: ');
    if (again !== password) throw new UsageError('passwords do not match');
  }
  const p = createSuperadmin(core, name, password, values['display-name']);
  process.stdout.write(`superadmin ${p.name} created (id ${p.id})\n`);
}

function principalCreate(core: Core, args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      kind: { type: 'string' },
      trust: { type: 'string' },
      owner: { type: 'string' },
      harness: { type: 'string' },
      'display-name': { type: 'string' },
    },
  });
  const name = requireString(values.name, 'name');
  const kind = requireString(values.kind, 'kind');
  if (kind !== 'agent' && kind !== 'human') throw new UsageError('--kind must be agent or human');
  const trust = (values.trust ?? (kind === 'agent' ? 'limited' : 'trusted')) as Trust;
  if (!TRUST.includes(trust)) throw new UsageError('--trust must be admin, trusted or limited');
  let ownerId: string | null = null;
  if (values.owner) {
    const owner = findPrincipal(core, values.owner);
    if (!owner) throw new UsageError('owner not found');
    ownerId = owner.id;
  }
  const p = createPrincipal(
    core,
    {
      name,
      kind,
      trust,
      ownerId,
      harness: values.harness ?? null,
      ...(values['display-name'] ? { displayName: values['display-name'] } : {}),
    },
    null,
  );
  process.stdout.write(`${p.kind} ${p.name} created (id ${p.id}, trust ${p.trust})\n`);
}

function tokenIssue(core: Core, args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      principal: { type: 'string' },
      label: { type: 'string' },
      days: { type: 'string' },
      'no-expiry': { type: 'boolean' },
    },
  });
  const name = requireString(values.principal, 'principal');
  const p = findPrincipal(core, name);
  if (!p || p.kind === 'system') throw new UsageError('principal not found');
  if (values.days !== undefined && values['no-expiry']) throw new UsageError('use either --days or --no-expiry');
  let days: number | null | undefined;
  if (values['no-expiry']) days = null;
  else if (values.days !== undefined) {
    days = Number(values.days);
    if (!Number.isInteger(days) || days < 1) throw new UsageError('--days must be a positive integer');
  }
  const t = issueToken(core, p.id, { label: values.label ?? '', days });
  process.stderr.write(
    `token for ${p.name} (prefix ${t.prefix}, ${t.expiresAt === null ? 'no expiry' : `expires ${new Date(t.expiresAt).toISOString()}`}); shown once:\n`,
  );
  process.stdout.write(`${t.token}\n`);
}

function doctor(core: Core): boolean {
  const report = runDoctor(core.db, { expectedSchemaVersion: loadMigrations().length });
  if (report.ok) process.stdout.write('doctor: ok\n');
  else for (const p of report.problems) process.stdout.write(`doctor: ${p}\n`);
  return report.ok;
}

/** Caller for import/export from the CLI: the given one or the first active superadmin. */
function cliCaller(core: Core, name: string | undefined): WriteContext {
  const p = name
    ? findPrincipal(core, name)
    : allPrincipals(core).find((x) => x.role === 'superadmin' && x.kind === 'human' && x.disabled_at === null);
  if (!p || p.role !== 'superadmin' || p.disabled_at !== null) throw new UsageError('an active superadmin is required (--as <name>)');
  return { ...contextForRow(core, p), via: 'cli', tokenId: null, ip: null, op: 'import', requestId: null };
}

function cliAudit(core: Core, ctx: WriteContext, op: string, detail: Record<string, unknown>): void {
  recordAudit(core, { principal_id: ctx.principal.id, token_id: null, via: 'cli', op, outcome: 'ok', request_id: null, ip: null, detail });
}

/** Tree files: relative paths with `/`; hidden files and directories and symlinks are skipped. */
function readTree(root: string): PlainFile[] {
  const out: PlainFile[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) out.push({ path: r, bytes: fs.readFileSync(abs) });
    }
  };
  walk(root, '');
  return out;
}

/** `brain migrate-spaces`: pairs are declared explicitly, never guessed by suffix. */
function migrateSpaces(core: Core, args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      preview: { type: 'boolean' },
      apply: { type: 'boolean' },
      pair: { type: 'string', multiple: true },
      'accept-oversight': { type: 'boolean' },
      json: { type: 'boolean' },
      as: { type: 'string' },
    },
    strict: true,
  });
  if (values.preview === values.apply) throw new UsageError('migrate-spaces: pass exactly one of --preview or --apply');
  if (!values.pair || values.pair.length === 0) throw new UsageError('migrate-spaces: declare at least one --pair <project>=<inbox>');
  let pairs;
  try {
    pairs = values.pair.map(parsePair);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const acceptOversight = values['accept-oversight'] === true;
  const out = values.apply
    ? applySpacesMigration(core, pairs, { acceptOversight, actorId: cliCaller(core, values.as).principal.id, via: 'cli' })
    : previewSpacesMigration(core, pairs, { acceptOversight });
  process.stdout.write(values.json ? `${JSON.stringify(out, null, 2)}\n` : `${renderSpacesMigration(out)}\n`);
  return out.ok ? 0 : 1;
}

async function cmdBackup(core: Core, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { out: { type: 'string' } } });
  const out = requireString(values.out, 'out');
  const r = await backup(core, out);
  process.stdout.write(`backup: ${r.file} (${r.bytes} bytes, ${r.blobs} blob file(s))\n`);
}

function cmdImport(core: Core, args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      space: { type: 'string' },
      mode: { type: 'string' },
      plain: { type: 'string' },
      as: { type: 'string' },
      'confirm-secrets': { type: 'boolean' },
    },
  });
  const space = requireString(values.space, 'space');
  const ctx = cliCaller(core, values.as);
  if (values.plain !== undefined) {
    if (positionals.length > 0) throw new UsageError('use either an archive or --plain <dir>');
    const r = importPlain(ctx, space, readTree(values.plain));
    cliAudit(core, ctx, 'import', { space, mode: 'plain', documents: r.documents });
    process.stdout.write(`import: ${r.documents} document(s) into ${r.space}\n`);
    return;
  }
  if (positionals.length !== 1) throw new UsageError('pass one archive file');
  const mode = values.mode ?? 'restore';
  if (mode !== 'restore' && mode !== 'as-new') throw new UsageError('--mode must be restore or as-new');
  const r = importArchive(ctx, { archive: fs.readFileSync(positionals[0]!), space, mode, confirmSecrets: values['confirm-secrets'] });
  cliAudit(core, ctx, 'import', { space, mode, documents: r.documents, revisions: r.revisions });
  const created = r.principals_created.length ? `; created disabled principals: ${r.principals_created.join(', ')}` : '';
  process.stdout.write(`import: ${r.documents} document(s), ${r.revisions} revision(s) into ${r.space}${created}\n`);
}

async function cmdExport(core: Core, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { space: { type: 'string' }, mode: { type: 'string' }, out: { type: 'string' }, as: { type: 'string' } } });
  const space = requireString(values.space, 'space');
  const out = requireString(values.out, 'out');
  const mode = values.mode ?? 'head';
  if (mode !== 'head' && mode !== 'full') throw new UsageError('--mode must be head or full');
  const ctx = cliCaller(core, values.as);
  const r = await createExport(ctx, { space, mode });
  fs.copyFileSync(path.join(core.config.dataDir, 'tmp', 'exports', `${r.export_id}.tar.gz`), out);
  cliAudit(core, ctx, 'export', { space, mode, size: r.size });
  process.stdout.write(`export: ${out} (${r.size} bytes, sha256 ${r.sha256})\n`);
}

export async function runCli(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return cmd ? 0 : 2;
  }
  const core = openCore(loadConfig());
  try {
    if (cmd === 'admin' && sub === 'create') await adminCreate(core, rest);
    else if (cmd === 'principal' && sub === 'create') principalCreate(core, rest);
    else if (cmd === 'token' && sub === 'issue') tokenIssue(core, rest);
    else if (cmd === 'doctor') return doctor(core) ? 0 : 1;
    else if (cmd === 'reindex') process.stdout.write(`reindex: ${reindexAll(core)} document(s)\n`);
    else if (cmd === 'backup') await cmdBackup(core, [sub, ...rest].filter((x): x is string => x !== undefined));
    else if (cmd === 'vacuum') {
      const v = vacuum(core);
      process.stdout.write(`vacuum: ${v.before} → ${v.after} bytes\n`);
    } else if (cmd === 'import') cmdImport(core, [sub, ...rest].filter((x): x is string => x !== undefined));
    else if (cmd === 'export') await cmdExport(core, [sub, ...rest].filter((x): x is string => x !== undefined));
    else if (cmd === 'migrate-spaces') return migrateSpaces(core, [sub, ...rest].filter((x): x is string => x !== undefined));
    else throw new UsageError(`unknown command: ${[cmd, sub].filter(Boolean).join(' ')}`);
    return 0;
  } finally {
    core.db.close();
  }
}

/** Core errors are contract codes (core/errors): show the reason and the fields, not just the generic text. */
function describeError(err: unknown): string {
  if (err instanceof OpError) {
    const d = err.details ?? {};
    const issues = Array.isArray(d.issues) ? (d.issues as { path: string; message: string }[]).map((i) => `${i.path}: ${i.message}`) : [];
    const reason = typeof d.reason === 'string' ? [`reason: ${d.reason}`] : [];
    return [err.message, ...issues, ...reason].join(' ');
  }
  return err instanceof Error ? err.message : String(err);
}

runCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`brain: ${describeError(err)}\n`);
    if (err instanceof UsageError) process.stderr.write(USAGE);
    process.exit(2);
  },
);
