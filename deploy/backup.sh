#!/bin/sh
# Consistent Brain backup out of the running container, for cron:
#   15 3 * * * /opt/brain/deploy/backup.sh >> /var/log/brain-backup.log 2>&1
# BACKUP_DIR (default /var/backups/brain), KEEP_DAYS (default 14).
# The tar holds brain.db (online-backup snapshot), secret.key and blobs/: keep it private.
set -eu
cd "$(dirname "$0")"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/brain}"
KEEP_DAYS="${KEEP_DAYS:-14}"
OUT="$BACKUP_DIR/brain-$(date -u +%Y%m%dT%H%M%SZ).tar"
umask 077
mkdir -p "$BACKUP_DIR"
# `brain backup` needs a file path (no stdout): write into the volume, stream out, delete.
docker compose exec -T brain node dist/src/cli.js backup --out /data/tmp/backup.tar
trap 'docker compose exec -T brain rm -f /data/tmp/backup.tar' EXIT
docker compose exec -T brain cat /data/tmp/backup.tar > "$OUT.partial"
tar -tf "$OUT.partial" brain.db secret.key > /dev/null
mv "$OUT.partial" "$OUT"
find "$BACKUP_DIR" -name 'brain-*.tar' -mtime "+$KEEP_DAYS" -delete
echo "backup: $OUT ($(wc -c < "$OUT") bytes)"
