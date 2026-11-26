#!/bin/sh
# Резервная копия: БД (pg_dump -Fc) + загруженные файлы. Запускается в сервисе backup (postgres:16-alpine) раз в сутки.
# Гарантии: файл попадает в каталог копий только после проверки читаемости (pg_restore --list);
# финальное имя — pf-YYYYMMDD-HHMMSS.dump, незавершённые копии (.tmp) страница «Система» не видит.
set -eu
KEEP_DAYS="${KEEP_DAYS:-30}"
MIN_KEEP="${MIN_KEEP:-7}"           # минимум дампов, которые не удаляются никогда (даже если все старше KEEP_DAYS)
DIR="${BACKUP_PATH:-/backups}"
UPLOADS="${UPLOADS_PATH:-/uploads}"
TS=$(date +%Y%m%d-%H%M%S)
OUT="$DIR/pf-$TS.dump"

pg_dump -Fc -f "$OUT.tmp"
pg_restore --list "$OUT.tmp" > /dev/null          # архив должен читаться, иначе копия считается неудачной
if [ "$(wc -c < "$OUT.tmp")" -le 1024 ]; then echo "backup FAILED: dump suspiciously small" >&2; rm -f "$OUT.tmp"; exit 1; fi
mv "$OUT.tmp" "$OUT"
( cd "$DIR" && sha256sum "pf-$TS.dump" > "pf-$TS.dump.sha256" )

if [ -d "$UPLOADS" ]; then
  tar czf "$DIR/uploads-$TS.tgz" -C "$UPLOADS" . 2>/dev/null || echo "warning: uploads archive failed" >&2
fi
echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"

# Ротация: удаляем копии старше KEEP_DAYS, но MIN_KEEP самых свежих дампов оставляем всегда.
COUNT=$(ls -1 "$DIR"/pf-*.dump 2>/dev/null | wc -l)
if [ "$COUNT" -gt "$MIN_KEEP" ]; then
  ls -1t "$DIR"/pf-*.dump | tail -n +"$((MIN_KEEP + 1))" | while read -r f; do
    if [ -n "$(find "$f" -mtime +"$KEEP_DAYS" 2>/dev/null)" ]; then
      b=$(basename "$f" .dump)
      rm -f "$f" "$f.sha256" "$DIR/uploads-${b#pf-}.tgz"
    fi
  done
fi
