#!/bin/sh
# Проверка восстановления: берёт ПОСЛЕДНЮЮ резервную копию, восстанавливает её в отдельную БД и проверяет целостность.
# Результат пишется в /backups/last-restore-test.json (его показывает страница «Система»).
# Рабочая БД не изменяется. Запуск вручную: docker compose run --rm backup /restore-test.sh
set -u
DIR="${BACKUP_PATH:-/backups}"
SCRATCH="${SCRATCH_DB:-pf_restore_test}"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

report() { printf '{"at":"%s","ok":%s,"detail":"%s"}\n' "$NOW" "$1" "$2" > "$DIR/last-restore-test.json"; }
fail()   { echo "restore-test FAILED: $1" >&2; report false "$1"; dropdb --if-exists "$SCRATCH" 2>/dev/null; exit 1; }

LATEST=$(ls -1t "$DIR"/pf-*.dump 2>/dev/null | head -n 1)
[ -n "$LATEST" ] || fail "нет резервных копий"
if [ -f "$LATEST.sha256" ]; then
  ( cd "$DIR" && sha256sum -c "$(basename "$LATEST").sha256" > /dev/null 2>&1 ) || fail "контрольная сумма не совпала: $(basename "$LATEST")"
fi

dropdb --if-exists "$SCRATCH" || fail "не удалось подготовить БД"
createdb "$SCRATCH" || fail "не удалось создать БД"
pg_restore --no-owner --exit-on-error -d "$SCRATCH" "$LATEST" 2> /tmp/restore.err || fail "pg_restore: $(head -c 200 /tmp/restore.err | tr '\n"' '  ')"

q() { psql -X -tA -d "$SCRATCH" -c "$1"; }
MIG=$(q 'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL') || fail "нет таблицы миграций"
[ "$MIG" -ge 1 ] || fail "миграции не восстановлены"

# Инварианты данных
BAD1=$(q "SELECT count(*) FROM \"Payment\" WHERE status='APPROVED' AND \"signedAmount\" IS NULL")
BAD2=$(q 'SELECT count(*) FROM "Contract" WHERE amount < 0 OR "openingPaid" < 0')
BAD3=$(q 'SELECT count(*) FROM "Payment" WHERE amount <= 0')
if [ "$BAD1" != 0 ] || [ "$BAD2" != 0 ] || [ "$BAD3" != 0 ]; then fail "нарушены инварианты данных ($BAD1/$BAD2/$BAD3)"; fi

# Защита данных на уровне БД должна быть восстановлена вместе с данными
TRG=$(q "SELECT count(*) FROM pg_trigger WHERE tgname IN ('audit_log_no_update','payment_guard')")
[ "$TRG" = 2 ] || fail "не восстановлены триггеры защиты данных"

# Сравнение с рабочей БД: копия не может содержать больше записей аудита, чем рабочая, и не быть пустой
LIVE_AUDIT=$(psql -X -tA -d "${PGDATABASE:-pf}" -c 'SELECT count(*) FROM "AuditLog"')
COPY_AUDIT=$(q 'SELECT count(*) FROM "AuditLog"')
[ "$COPY_AUDIT" -le "$LIVE_AUDIT" ] || fail "в копии больше записей аудита, чем в рабочей БД ($COPY_AUDIT > $LIVE_AUDIT)"
if [ "$LIVE_AUDIT" -gt 0 ] && [ "$COPY_AUDIT" -eq 0 ]; then fail "копия пуста"; fi

TABLES=$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
CONTRACTS=$(q 'SELECT count(*) FROM "Contract"')
dropdb "$SCRATCH"
MSG="$(basename "$LATEST"): таблиц $TABLES, миграций $MIG, договоров $CONTRACTS, аудит $COPY_AUDIT из $LIVE_AUDIT"
report true "$MSG"
echo "restore-test ok: $MSG"
