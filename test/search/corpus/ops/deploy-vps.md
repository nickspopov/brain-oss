---
title: Deploying to the VPS
tags: [ops, deploy]
---
# Deploying to the VPS

The server runs under the `brain` user as a systemd service. Caddy terminates TLS in front of port 7460.

## Steps

- build the release with `npm run build`
- copy `dist/` and restart the service with `systemctl restart brain`
- check the logs with `journalctl -u brain`
