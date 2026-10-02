#!/usr/bin/env bash
# Nightly logical backup of the HisabKitab DB. Keeps 14 days. Restore:
#   gunzip -c FILE | docker exec -i hisabkitab-postgres-1 psql -U postgres -d hisabkitab
set -euo pipefail
DIR=/var/backups/hisabkitab; mkdir -p "$DIR"; chmod 700 "$DIR"
F="$DIR/hisabkitab-$(date +%Y%m%d-%H%M).sql.gz"
docker exec hisabkitab-postgres-1 pg_dump -U postgres -d hisabkitab --no-owner | gzip -9 > "$F.tmp"
mv "$F.tmp" "$F"; chmod 600 "$F"
find "$DIR" -name 'hisabkitab-*.sql.gz' -mtime +14 -delete
logger -t hisab-backup "ok $F $(stat -c%s "$F")B"
