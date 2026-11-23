# Deploying Brain with Docker

Target: a Linux host (x86_64 or arm64) with Docker Engine and the compose plugin (≥ 2.20). The example stack runs
two containers: `brain` and a TLS-terminating reverse proxy (`caddy`, automatic HTTPS). Brain stays isolated
from everything else on the host:

- its own compose project (`name: brain`) and its own networks;
- **brain publishes no host ports.** The only way in is the proxy, which forwards requests to `http://brain:7460`
  over the private network `brain-net`;
- `brain-net` is `internal: true`: the brain container has no route to the internet, the host LAN or other
  containers. Only the proxy is also on `egress` (a normal bridge) and publishes ports 80/443;
- no `docker.sock`, not privileged, `cap_drop: [ALL]`, `no-new-privileges`, read-only root filesystem (writable:
  the `brain-data` volume at `/data` and a 64 MB tmpfs at `/tmp`), non-root user `node` (uid 1000),
  `mem_limit: 384m` (Node heap capped at 192 MB), `pids_limit`.

**Webhooks do not work in this stack as shipped.** Because `brain-net` has no outbound internet, webhook
deliveries never leave the container. If you need them, change the network as described in
[Outgoing connections](#outgoing-connections).

All commands below run from the `deploy/` directory of a checkout on the host. The examples use
`brain.example.com`; replace it with your hostname.

## Files

| File | What |
| --- | --- |
| `Dockerfile` | multi-stage build (node:22-slim): tsc + vite → production `node_modules` → runtime |
| `compose.yml` | services `brain` and `caddy`, networks `brain-net` (internal) and `egress`, volume `brain-data` |
| `Caddyfile` | the reverse proxy: `{$BRAIN_DOMAIN}` → `brain:7460` |
| `.env.example` | every `BRAIN_*` variable; copy to `.env` (read by `brain` only) |
| `proxy.env.example` | `BRAIN_DOMAIN`; copy to `proxy.env` (read by `caddy` only) |
| `backup.sh` | consistent backup tar out of the running container, for cron |
| `smoke.sh` | `./smoke.sh <url> <token>`: healthz, whoami (REST), start_here (MCP) |

`.env` and `proxy.env` are git-ignored; keep them `chmod 600`.

## First deploy

1. Point a DNS record for `brain.example.com` at the host and open ports 80 and 443 (Caddy needs both to obtain
   and renew the certificate).
2. On the host:

   ```sh
   git clone https://github.com/nickspopov/brain-oss brain && cd brain/deploy
   cp .env.example .env && cp proxy.env.example proxy.env && chmod 600 .env proxy.env
   # proxy.env: BRAIN_DOMAIN=brain.example.com
   # .env:      BRAIN_ORIGIN=https://brain.example.com, BRAIN_TRUSTED_PROXY=1 (the defaults in the example)
   docker compose build
   docker compose up -d
   docker compose ps          # brain: healthy; caddy: running
   ```

3. Create the superadmin (until then every route except `/healthz` answers 503). The CLI runs inside the running
   container against the same volume (SQLite WAL is safe for that):

   ```sh
   docker compose exec brain node dist/src/cli.js admin create --name alice      # asks for the password twice
   ```

   Then sign in at https://brain.example.com and connect agents in the UI (People & agents → Agents → Connect
   agent), or via the CLI:

   ```sh
   docker compose exec brain node dist/src/cli.js principal create --name my-assistant --kind agent --trust limited --owner alice
   docker compose exec brain node dist/src/cli.js token issue --principal my-assistant --label server
   ```

4. Smoke test through the proxy (from anywhere):

   ```sh
   ./smoke.sh https://brain.example.com "$TOKEN"
   ```

All CLI commands: `docker compose exec brain node dist/src/cli.js help`.

## Using your own reverse proxy

If the host already runs a reverse proxy, a load balancer or a tunnel client, delete the `caddy` service (and the
`caddy-*` volumes) from `compose.yml` and attach your proxy container to `brain-net`, forwarding to
`http://brain:7460`. Keep `brain` itself off any network with egress. Requirements for the proxy:

- terminate TLS and serve exactly the hostname in `BRAIN_ORIGIN`;
- put the client address **last** in `X-Forwarded-For` (append or replace), and set `BRAIN_TRUSTED_PROXY` to the
  number of proxy hops in front of Brain;
- do not cache responses (Brain sends `cache-control` where it matters, but nothing should be cached in between);
- allow long requests on `/api/v1/inbox?wait=` and `handoff_wait` (up to `BRAIN_INBOX_WAIT_MAX_S`, 50 s by default).

If your proxy requires extra headers from clients (for example an access gateway in front of Brain), agents set
them in `BRAIN_HEADERS` next to `BRAIN_TOKEN`; see `docs/connect/README.md`. Brain itself only checks its own token.

## Client IP and origin behind the proxy

- **Origin.** The server does not derive its origin from request headers: `BRAIN_ORIGIN` is the only source
  (links in `/agents.md`, `/llms.txt`, OpenAPI, connect guides; the CSRF check compares the browser's `Origin`
  header with it; cookies are `Secure` because it is `https://`). It must equal the public hostname exactly.
  An `http://` origin is refused unless `BRAIN_DEV=1`, which must stay unset in production.
- **Client IP** (auth-failure rate limit, audit, sessions). Fastify's `trustProxy` is driven by
  `BRAIN_TRUSTED_PROXY=<hops>`: with `1`, the TCP peer (the proxy container) is trusted and the client IP is the
  **last** entry of `X-Forwarded-For`. A value the client puts in its own `X-Forwarded-For` stays in front of it and
  is ignored. With `BRAIN_TRUSTED_PROXY=0` every client would share the proxy's IP and one bad client could lock
  everyone out of login; the server warns about that at start.
- Brain is reachable only from the proxy (no published ports, internal network), so nobody can forge the peer hop.

## Health and doctor

```sh
docker compose ps                                   # healthcheck: GET /healthz every 30 s
docker compose logs --tail 100 brain
docker compose exec brain node dist/src/cli.js doctor   # exit 0 and "doctor: ok"
```

## Backup (cron)

`brain backup --out <file>` writes a consistent tar (SQLite online backup of `brain.db`, `secret.key`,
`blobs/`). It needs a real file path (no `-` for stdout), so `backup.sh` writes it into the volume's `tmp/`,
streams it out with `docker compose exec -T brain cat`, checks it lists `brain.db` and `secret.key`, deletes the
copy in the volume and prunes files older than `KEEP_DAYS` (14):

```sh
crontab -e
15 3 * * * /opt/brain/deploy/backup.sh >> /var/log/brain-backup.log 2>&1
# BACKUP_DIR=/var/backups/brain (default), KEEP_DAYS=14
```

The tar holds the whole unencrypted database (documents, webhook signing secrets in plain text, password and token
hashes) and `secret.key` (the key that encrypts paging and `changes` cursors). Keep backups as private as the
server, and copy them off the host encrypted (e.g. with `age` to object storage).

The temporary copy counts against free space in the volume for a moment; it is not part of the import/export
format.

## Restore from a backup tar

A `brain backup` tar is restored by unpacking it into an **empty** data volume (there is no `restore`
command; `brain import` is a different thing — it imports a space *export* archive, see below). Keep a copy of the
current data first, so a wrong or damaged backup cannot leave you with nothing:

```sh
B=brain-20260101T031500Z.tar
tar -tf "$B" | grep -qxE '(\./)?brain\.db' || { echo "not a brain backup: $B"; exit 1; }   # sanity check before touching data
docker compose stop brain caddy
# 1. Keep the current data.
docker compose run --rm --no-deps -v "$PWD:/out" --entrypoint sh brain \
  -c 'tar -cf /out/brain-before-restore.tar -C /data .'
# 2. Empty the volume and unpack the backup.
docker compose run --rm --no-deps -v "$PWD/$B:/restore.tar:ro" --entrypoint sh brain \
  -c 'find /data -mindepth 1 -delete && tar -xf /restore.tar -C /data && ls -la /data'
docker compose run --rm --no-deps brain node dist/src/cli.js doctor      # must print "doctor: ok"
docker compose up -d
./smoke.sh https://brain.example.com "$TOKEN"
```

If `doctor` fails, put the old data back the same way from `brain-before-restore.tar` (step 2 with that file).
Deleting the old contents before unpacking matters: a leftover `brain.db-wal` from the old database would be
replayed on top of the restored one. Migrations newer than the backup run on start (the schema only moves forward).

Space **export** archives (`brain export`, UI export) are imported as a new space:

```sh
docker compose run --rm --no-deps -v "$PWD/notes.tar.gz:/in.tar.gz:ro" brain \
  node dist/src/cli.js import /in.tar.gz --space notes --mode restore     # or --mode as-new
```

## Upgrade

```sh
cd /opt/brain && git pull
cd deploy
./backup.sh                                # take a backup first (see above)
docker compose build brain
docker compose up -d                       # recreates brain; migrations run at start
docker compose ps && ./smoke.sh https://brain.example.com "$TOKEN"
docker image prune -f                      # drops dangling old images
```

Pin the proxy with `CADDY_TAG=<version>` in the shell or an `--env-file`, and update it the same way
(`docker compose pull caddy && docker compose up -d`).

## Rollback

Code rollback without a schema change: check out the previous commit and rebuild.

```sh
cd /opt/brain && git checkout <previous-commit>
cd deploy && docker compose build brain && docker compose up -d
```

If the newer version ran a migration, the older code refuses to start (`database schema N is newer than code (M)`).
Then roll back data too: restore the backup taken before the upgrade (see "Restore"), with the old code checked
out. Writes made after that backup are lost, so keep the window between backup and upgrade short.

Tip: tag images before upgrading (`docker tag brain:local brain:prev`) — rollback is then
`docker tag brain:prev brain:local && docker compose up -d --no-build`.

## Outgoing connections

`brain-net` is internal, so the server cannot make outgoing connections: webhooks can be configured and are
queued, but are never delivered. If you need webhooks, add a second network with egress to the `brain` service
only and set `BRAIN_WEBHOOK_ALLOW_HOSTS` as needed; this weakens the isolation (brain could then reach the
internet and the host's LAN).

## Resource notes

- Measured on arm64 (Raspberry Pi, no container): idle RSS ≈ 125 MB after the smoke test; production
  `node_modules` ≈ 144 MB (better-sqlite3, zod, MCP SDK, yjs/lib0).
- `BRAIN_MAX_DATA_BYTES` (default 5 GiB) and `BRAIN_MIN_FREE_MB` stop writes before the disk fills; the volume
  lives on the host's Docker disk.
