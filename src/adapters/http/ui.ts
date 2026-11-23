// Serving the built UI (`adapters/http/ui.ts`): static files from BRAIN_WEB_DIR
// (`web/dist`) and index.html for every app URL. No logic and no data access: the UI
// uses REST only. Security headers: CSP, nosniff, no framing.
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { sendCode } from './envelope.js';

/** CSP: no external images, scripts, styles or frames are loaded. */
export const UI_CSP = "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/** URLs that do not belong to the UI: index.html is not served for them. */
const RESERVED = /^\/(api|mcp|mcpl)(\/|$)|^\/(healthz|agents\.md|llms\.txt|openapi\.json|inbox-poll\.sh)$|^\/\.well-known\//;

function secure(reply: FastifyReply): FastifyReply {
  return reply
    .header('content-security-policy', UI_CSP)
    .header('x-content-type-options', 'nosniff')
    .header('x-frame-options', 'DENY')
    .header('referrer-policy', 'no-referrer');
}

/** A file inside the UI directory, or `null` (escape from the directory, hidden names, no file). */
export function resolveStatic(dir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segs = decoded.split('/').filter((s) => s !== '');
  if (segs.length === 0 || segs.some((s) => s === '..' || s.startsWith('.'))) return null;
  const file = path.resolve(dir, ...segs);
  if (!file.startsWith(dir + path.sep)) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
  * Registers the UI if the directory has a built index.html. Otherwise does nothing:
  * the server works as before (REST, MCP), and a hint is logged.
 */
export function registerUi(app: FastifyInstance, dir: string | null): boolean {
  if (dir === null) return false;
  const root = path.resolve(dir);
  const indexFile = path.join(root, 'index.html');
  if (!fs.existsSync(indexFile)) {
    app.log.info({ dir: root }, 'UI is not built (npm run build:web); serving the API only');
    return false;
  }

  app.get('/*', async (req, reply) => {
    const urlPath = req.url.split('?')[0] ?? '/';
    if (RESERVED.test(urlPath)) return sendCode(reply, 'not_found');
    // Built files (`/assets/*` with a hash in the name, favicon and the like).
    if (urlPath !== '/' && urlPath !== '/index.html') {
      const file = resolveStatic(root, urlPath);
      if (file) {
        const ext = path.extname(file).toLowerCase();
        const immutable = urlPath.startsWith('/assets/');
        return secure(reply)
          .code(200)
          .header('content-type', TYPES[ext] ?? 'application/octet-stream')
          .header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
          .send(fs.createReadStream(file));
      }
      // A missing built file is an honest 404, not index.html.
      if (urlPath.startsWith('/assets/')) return sendCode(reply, 'not_found');
    }
    // App URL (`/`, `/s/…`, `/search`): the UI does its own routing.
    return secure(reply).code(200).header('content-type', TYPES['.html']!).header('cache-control', 'no-cache').send(fs.createReadStream(indexFile));
  });
  return true;
}
