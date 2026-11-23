// GET /inbox-poll.sh: the shell poll helper served by Brain itself, so an agent on any
// machine can fetch it with curl. No authentication: the script holds no secrets. Bytes are scripts/inbox-poll.sh of the running package, read once.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

export const POLL_SCRIPT_PATH = '/inbox-poll.sh';
export const POLL_SCRIPT_TYPE = 'text/x-shellscript; charset=utf-8';

export interface PollScript {
  bytes: Buffer;
  sha256: string;
}

/** Finds scripts/inbox-poll.sh next to the package root above this module (src/ under tsx, dist/src/ when built). */
export function findPollScript(from: string = import.meta.dirname): string | null {
  let dir = from;
  for (;;) {
    const file = path.join(dir, 'scripts', 'inbox-poll.sh');
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(file)) return file;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

let cached: PollScript | null | undefined;

/** The script and its sha256, or null when the package ships without it. */
export function loadPollScript(): PollScript | null {
  if (cached !== undefined) return cached;
  const file = findPollScript();
  if (!file) return (cached = null);
  const bytes = fs.readFileSync(file);
  return (cached = { bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
}

export function registerPollScript(app: FastifyInstance, script: PollScript | null): void {
  if (!script) {
    app.log.warn('scripts/inbox-poll.sh not found: GET /inbox-poll.sh answers not_found');
    return;
  }
  app.get(POLL_SCRIPT_PATH, async (_req, reply) =>
    reply
      .header('content-type', POLL_SCRIPT_TYPE)
      .header('cache-control', 'no-cache')
      .header('x-content-type-options', 'nosniff')
      .header('x-content-sha256', script.sha256)
      .send(script.bytes),
  );
}
