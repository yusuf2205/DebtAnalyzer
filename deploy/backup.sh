#!/bin/sh
# Резервная копия БД в формате custom (-Fc) + проверка читаемости архива + ротация.
set -eu
TS=$(date +%Y%m%d-%H%M%S)
OUT="/backups/pf-$TS.dump"
pg_dump -Fc -f "$OUT"
# Проверка: архив должен читаться, иначе копия считается неудачной.
pg_restore --list "$OUT" > /dev/null
echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
find /backups -name 'pf-*.dump' -mtime +"${KEEP_DAYS:-30}" -delete
