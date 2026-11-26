#!/bin/sh
# Тесты скриптов развёртывания (backup.sh, restore-test.sh, preflight.sh) с заглушками pg_dump/psql.
# Проверяют ЛОГИКУ скриптов (ротация, контрольные суммы, пути отказа). Работу настоящих pg_dump/pg_restore
# проверяет только запуск на целевой системе: docker compose run --rm backup /restore-test.sh
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
PASS=0; FAIL=0
t() { # t "описание" команда...
  desc=$1; shift
  if "$@" >/tmp/pf-test.out 2>&1; then PASS=$((PASS+1)); echo "  ✓ $desc"; else FAIL=$((FAIL+1)); echo "  ✗ $desc"; sed 's/^/      /' /tmp/pf-test.out | head -8; fi
}
tn() { # ожидается НЕуспех
  desc=$1; shift
  if "$@" >/tmp/pf-test.out 2>&1; then FAIL=$((FAIL+1)); echo "  ✗ $desc (ожидалась ошибка)"; else PASS=$((PASS+1)); echo "  ✓ $desc"; fi
}
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin"

# ---- заглушки PostgreSQL-утилит ----
cat > "$W/bin/pg_dump" <<'SH'
#!/bin/sh
[ "${FAKE_DUMP_FAIL:-0}" = 1 ] && { echo "pg_dump: error" >&2; exit 1; }
while [ $# -gt 0 ]; do case "$1" in -f) out=$2; shift 2;; *) shift;; esac; done
head -c "${FAKE_DUMP_SIZE:-4096}" /dev/zero | tr '\0' 'x' > "$out"
SH
cat > "$W/bin/pg_restore" <<'SH'
#!/bin/sh
for a in "$@"; do [ "$a" = "--list" ] && { [ "${FAKE_LIST_FAIL:-0}" = 1 ] && exit 1; exit 0; }; done
[ "${FAKE_RESTORE_FAIL:-0}" = 1 ] && { echo "pg_restore: error: could not execute query" >&2; exit 1; }
exit 0
SH
cat > "$W/bin/createdb" <<'SH'
#!/bin/sh
exit 0
SH
cat > "$W/bin/dropdb" <<'SH'
#!/bin/sh
exit 0
SH
# psql: ответы определяются по тексту запроса и переменным окружения
cat > "$W/bin/psql" <<'SH'
#!/bin/sh
q=""; db=""
while [ $# -gt 0 ]; do case "$1" in -c) q=$2; shift 2;; -d) db=$2; shift 2;; *) shift;; esac; done
case "$q" in
  *_prisma_migrations*) echo "${FAKE_MIG:-9}";;
  *"status='APPROVED'"*) echo "${FAKE_BAD1:-0}";;
  *"amount < 0"*) echo "${FAKE_BAD2:-0}";;
  *"amount <= 0"*) echo "${FAKE_BAD3:-0}";;
  *pg_trigger*) echo "${FAKE_TRG:-2}";;
  *'FROM "AuditLog"'*) if [ "$db" = "pf_restore_test" ]; then echo "${FAKE_COPY_AUDIT:-100}"; else echo "${FAKE_LIVE_AUDIT:-120}"; fi;;
  *information_schema*) echo 21;;
  *'FROM "Contract"'*) echo 712;;
  *) echo 0;;
esac
SH
chmod +x "$W/bin/"*
export PATH="$W/bin:$PATH"

echo "backup.sh"
B="$W/b1"; U="$W/u1"; mkdir -p "$B" "$U"; echo hello > "$U/file.txt"
t "создаёт дамп, контрольную сумму и архив загрузок" env BACKUP_PATH="$B" UPLOADS_PATH="$U" sh "$HERE/backup.sh"
t "имя соответствует pf-YYYYMMDD-HHMMSS.dump и нет временных файлов" sh -c "ls $B | grep -qE '^pf-[0-9]{8}-[0-9]{6}\.dump$' && ! ls $B | grep -q '\.tmp'"
t "контрольная сумма проверяется" sh -c "cd $B && sha256sum -c pf-*.dump.sha256"
t "архив загрузок создан" sh -c "ls $B | grep -qE '^uploads-.*\.tgz$'"
B2="$W/b2"; mkdir -p "$B2"
tn "отказ pg_dump не оставляет копий" env FAKE_DUMP_FAIL=1 BACKUP_PATH="$B2" UPLOADS_PATH="$W/none" sh "$HERE/backup.sh"
t "…и каталог остаётся пустым" sh -c "[ -z \"\$(ls -A $B2)\" ] || ls $B2 | grep -qv dump.tmp"
tn "нечитаемый архив отклоняется" env FAKE_LIST_FAIL=1 BACKUP_PATH="$B2" UPLOADS_PATH="$W/none" sh "$HERE/backup.sh"
tn "подозрительно маленький дамп отклоняется" env FAKE_DUMP_SIZE=100 BACKUP_PATH="$B2" UPLOADS_PATH="$W/none" sh "$HERE/backup.sh"
t "после отказов нет финальных файлов pf-*.dump" sh -c "! ls $B2 | grep -qE '^pf-.*\.dump$'"

# ротация: 10 старых копий, KEEP_DAYS=1, MIN_KEEP=3 -> остаются 3 самых свежих + новая
B3="$W/b3"; mkdir -p "$B3"
i=1; while [ $i -le 10 ]; do f="$B3/pf-2020010$((i%9+1))-0000$i.dump"; i2=$(printf '%02d' $i); f="$B3/pf-202001${i2}-000000.dump"; echo x > "$f"; echo s > "$f.sha256"; touch -d "2020-01-$i2" "$f"; i=$((i+1)); done
t "ротация: старые удаляются, MIN_KEEP остаётся" sh -c "KEEP_DAYS=1 MIN_KEEP=3 BACKUP_PATH=$B3 UPLOADS_PATH=$W/none sh $HERE/backup.sh && [ \$(ls $B3/pf-*.dump | wc -l) -eq 3 ]"
t "…остались самые свежие, а не случайные" sh -c "ls $B3 | grep -q 'pf-20200110-000000.dump' && ! ls $B3 | grep -q 'pf-20200101-000000.dump'"
t "…вместе с копиями удалены .sha256" sh -c "! ls $B3 | grep -q 'pf-20200101-000000.dump.sha256'"
B4="$W/b4"; mkdir -p "$B4"; for d in 01 02; do echo x > "$B4/pf-202001$d-000000.dump"; touch -d "2020-01-$d" "$B4/pf-202001$d-000000.dump"; done
t "ротация не удаляет копии, если их не больше MIN_KEEP" sh -c "KEEP_DAYS=1 MIN_KEEP=7 BACKUP_PATH=$B4 UPLOADS_PATH=$W/none sh $HERE/backup.sh && [ \$(ls $B4/pf-*.dump | wc -l) -eq 3 ]"

echo "restore-test.sh"
R="$W/r1"; mkdir -p "$R"
tn "без копий — отказ и запись результата" env BACKUP_PATH="$R" sh "$HERE/restore-test.sh"
t "…результат записан как неудача" sh -c "grep -q '\"ok\":false' $R/last-restore-test.json && grep -q 'нет резервных копий' $R/last-restore-test.json"
env BACKUP_PATH="$R" UPLOADS_PATH="$W/none" sh "$HERE/backup.sh" >/dev/null 2>&1
t "успешная проверка пишет ok:true и сводку" sh -c "BACKUP_PATH=$R sh $HERE/restore-test.sh && grep -q '\"ok\":true' $R/last-restore-test.json && grep -q 'договоров 712' $R/last-restore-test.json"
t "результат проверки доступен на чтение остальным (API работает не от root)" sh -c "[ -n \"\$(find $R/last-restore-test.json -perm -004)\" ]"
RJ="$R/last-restore-test.json"; command -v cygpath >/dev/null 2>&1 && RJ=$(cygpath -m "$RJ")
t "…файл результата — валидный JSON" node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$RJ"
tn "ошибка pg_restore — отказ" env FAKE_RESTORE_FAIL=1 BACKUP_PATH="$R" sh "$HERE/restore-test.sh"
t "…с причиной в результате" sh -c "grep -q 'pg_restore' $R/last-restore-test.json && grep -q '\"ok\":false' $R/last-restore-test.json"
tn "нарушение инварианта (подтверждённый платёж без суммы) — отказ" env FAKE_BAD1=3 BACKUP_PATH="$R" sh "$HERE/restore-test.sh"
tn "не восстановлены триггеры защиты — отказ" env FAKE_TRG=1 BACKUP_PATH="$R" sh "$HERE/restore-test.sh"
tn "не восстановлены миграции — отказ" env FAKE_MIG=0 BACKUP_PATH="$R" sh "$HERE/restore-test.sh"
tn "в копии больше аудита, чем в рабочей БД — отказ" env FAKE_COPY_AUDIT=500 FAKE_LIVE_AUDIT=10 BACKUP_PATH="$R" sh "$HERE/restore-test.sh"
tn "копия пуста при непустой рабочей БД — отказ" env FAKE_COPY_AUDIT=0 FAKE_LIVE_AUDIT=10 BACKUP_PATH="$R" sh "$HERE/restore-test.sh"
echo "повреждённый" >> "$(ls -1t $R/pf-*.dump | head -1)"
tn "повреждённая копия (контрольная сумма) — отказ" env BACKUP_PATH="$R" sh "$HERE/restore-test.sh"
t "…с указанием на контрольную сумму" sh -c "grep -q 'контрольная сумма' $R/last-restore-test.json"

echo "preflight.sh"
P="$W/repo"; mkdir -p "$P/deploy"; cp "$HERE/preflight.sh" "$P/deploy/"; cp "$HERE/../docker-compose.yml" "$P/"; mkdir -p "$P/bk"
good() { cat > "$P/.env" <<EOF
POSTGRES_PASSWORD=abcdefghijklmnopqrstuvwx12
CLOUDFLARE_TUNNEL_TOKEN=tok
INITIAL_ADMIN_EMAIL=a@b.cc
INITIAL_ADMIN_PASSWORD=Strongpass12345
BACKUP_DIR=$P/bk
EOF
chmod 600 "$P/.env"; }
tn "нет .env — отказ" sh "$P/deploy/preflight.sh"
good; t "корректный .env проходит" sh "$P/deploy/preflight.sh"
good; sed -i 's/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=short/' "$P/.env"; tn "короткий пароль БД — отказ" sh "$P/deploy/preflight.sh"
good; sed -i 's/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=abcdefghijklmnopqrstuvwx@1\/2/' "$P/.env"; tn "спецсимволы в пароле БД (ломают URL) — отказ" sh "$P/deploy/preflight.sh"
good; sed -i '/^CLOUDFLARE/d' "$P/.env"; tn "нет токена туннеля — отказ" sh "$P/deploy/preflight.sh"
good; sed -i 's/^INITIAL_ADMIN_PASSWORD=.*/INITIAL_ADMIN_PASSWORD=password/' "$P/.env"; tn "слабый начальный пароль — отказ" sh "$P/deploy/preflight.sh"
good; printf 'GOOGLE_CLIENT_ID=x\nGOOGLE_CLIENT_SECRET=y\nGOOGLE_REDIRECT_URI=http://x/cb\nTOKEN_ENCRYPTION_KEY=short\n' >> "$P/.env"; tn "Google без https и ключа — отказ" sh "$P/deploy/preflight.sh"
good; sed -i "s#^BACKUP_DIR=.*#BACKUP_DIR=/proc/nope/bk#" "$P/.env"; tn "недоступный каталог копий — отказ" sh "$P/deploy/preflight.sh"

echo "синтаксис"
for f in backup.sh restore-test.sh preflight.sh update.sh; do t "sh -n $f" sh -n "$HERE/$f"; done

echo; echo "Итог: пройдено $PASS, провалено $FAIL"
[ "$FAIL" -eq 0 ]
