// The container files keep their isolation promises, and .env.example documents every BRAIN_* variable.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadConfig } from '../../src/config.js';

const root = path.resolve(import.meta.dirname, '../..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8');

interface Service {
  ports?: unknown;
  privileged?: boolean;
  volumes?: string[];
  cap_drop?: string[];
  cap_add?: string[];
  security_opt?: string[];
  read_only?: boolean;
  restart?: string;
  mem_limit?: string;
  networks?: string[];
  network_mode?: string;
  env_file?: string;
}

const compose = parse(read('deploy/compose.yml')) as {
  services: Record<string, Service>;
  networks: Record<string, { internal?: boolean } | null>;
  volumes: Record<string, unknown>;
};

describe('deploy/compose.yml', () => {
  it('has exactly brain and caddy', () => {
    expect(Object.keys(compose.services).sort()).toEqual(['brain', 'caddy']);
  });

  it.each(['brain', 'caddy'])('%s is locked down', (name) => {
    const s = compose.services[name]!;
    expect(s.privileged).not.toBe(true);
    expect(s.network_mode).toBeUndefined();
    expect(s.cap_drop).toEqual(['ALL']);
    expect(s.security_opt).toContain('no-new-privileges:true');
    expect(s.read_only).toBe(true);
    expect(s.restart).toBe('unless-stopped');
    expect(JSON.stringify(s.volumes ?? [])).not.toMatch(/docker\.sock/);
  });

  it('brain publishes no ports, is only on the internal network, with its data volume and 384m', () => {
    const brain = compose.services.brain!;
    expect(brain.ports).toBeUndefined();
    expect(brain.cap_add).toBeUndefined();
    expect(brain.networks).toEqual(['brain-net']);
    expect(compose.networks['brain-net']?.internal).toBe(true);
    expect(brain.volumes).toEqual(['brain-data:/data']);
    expect(Object.keys(compose.volumes)).toContain('brain-data');
    expect(brain.mem_limit).toBe('384m');
    expect(brain.env_file).toBe('.env');
  });

  it('only the proxy gets egress, published ports and its own env file', () => {
    const proxy = compose.services.caddy!;
    expect(proxy.networks).toEqual(['brain-net', 'egress']);
    expect(compose.networks.egress?.internal ?? false).toBe(false);
    expect(proxy.ports).toEqual(['80:80', '443:443']);
    expect(proxy.cap_add).toEqual(['NET_BIND_SERVICE']);
    expect(proxy.env_file).toBe('proxy.env');
    expect(read('deploy/proxy.env.example')).toMatch(/^BRAIN_DOMAIN=brain\.example\.com$/m);
    expect(read('deploy/Caddyfile')).toMatch(/reverse_proxy brain:7460/);
    expect(read('deploy/.env.example')).not.toMatch(/BRAIN_DOMAIN/);
  });
});

describe('deploy/Dockerfile', () => {
  const df = read('deploy/Dockerfile');

  it('runs node 22 slim as non-root with the heap cap, /data and a healthcheck', () => {
    expect(df).toMatch(/^ARG NODE_IMAGE=node:22-slim$/m);
    expect(df).toMatch(/^USER node$/m);
    expect(df).toMatch(/npm ci --omit=dev/);
    expect(df).toMatch(/BRAIN_DATA_DIR=\/data/);
    expect(df).toMatch(/^HEALTHCHECK [\s\S]*\/healthz/m);
    expect(df).toMatch(/^CMD \["node", "--max-old-space-size=192", "dist\/src\/main\.js"\]$/m);
  });

  it('ships scripts/inbox-poll.sh in the runtime image (GET /inbox-poll.sh)', () => {
    const runtime = df.slice(df.indexOf('AS runtime'));
    expect(runtime).toMatch(/^COPY scripts\/inbox-poll\.sh \.\/scripts\/inbox-poll\.sh$/m);
    expect(read('.dockerignore')).not.toMatch(/^scripts/m);
  });

  it('copies only paths that exist in the repository', () => {
    for (const m of df.matchAll(/^COPY (?!--from)(.+) \S+$/gm)) {
      for (const src of m[1]!.split(' ')) expect(fs.existsSync(path.join(root, src)), src).toBe(true);
    }
  });
});

describe('deploy/.env.example', () => {
  const example = read('deploy/.env.example');

  it('names every BRAIN_* variable the server reads', () => {
    const used = new Set(read('src/config.ts').match(/\bBRAIN_[A-Z_]+(?=:)/g));
    expect(used.size).toBeGreaterThan(20);
    for (const v of used) expect(example, v).toMatch(new RegExp(`^#? ?${v}=`, 'm'));
  });

  it('is a valid production config with the image defaults', () => {
    const env: Record<string, string> = { BRAIN_HOST: '0.0.0.0', BRAIN_DATA_DIR: '/data' };
    for (const line of example.split('\n')) {
      const m = /^(BRAIN_[A-Z_]+)=(.*)$/.exec(line);
      if (m) env[m[1]!] = m[2]!;
    }
    expect(env.BRAIN_DEV).toBeUndefined();
    const c = loadConfig(env);
    expect(c.origin).toBe('https://brain.example.com');
    expect(c.dev).toBe(false);
    expect(c.trustedProxy).toBe(1);
  });
});

describe('deploy scripts', () => {
  it.each(['deploy/smoke.sh', 'deploy/backup.sh'])('%s is executable and parses', (p) => {
    expect(fs.statSync(path.join(root, p)).mode & 0o111).not.toBe(0);
    const shell = p.endsWith('smoke.sh') ? 'bash' : 'sh';
    expect(spawnSync(shell, ['-n', path.join(root, p)]).status).toBe(0);
  });

  it('smoke.sh refuses a wrong argument count', () => {
    const r = spawnSync('bash', [path.join(root, 'deploy/smoke.sh')], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/);
  });
});
