#!/bin/sh
# Тесты скриптов развёртывания (backup.sh, restore-test.sh, preflight.sh) с заглушками pg_dump/psql.
# Проверяют ЛОГИКУ скриптов (ротация, контрольные суммы, пути отказа). Работу настоящих pg_dump/pg_restore
# проверяет только запуск на целевой системе: docker compose run --rm --entrypoint /restore-test.sh backup
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

echo "offsite-sync.sh"
cat > "$W/bin/rclone" <<'SH'
#!/bin/sh
# заглушка: copy/check/delete; сбой по переменным окружения; журнал вызовов
echo "$*" >> "${FAKE_RCLONE_LOG:-/dev/null}"
case "$1" in
  copy) [ "${FAKE_RCLONE_COPY_FAIL:-0}" = 1 ] && exit 1; exit 0;;
  check) [ "${FAKE_RCLONE_CHECK_FAIL:-0}" = 1 ] && exit 1; exit 0;;
  delete) exit 0;;
esac
exit 0
SH
chmod +x "$W/bin/rclone"
O="$W/off"; mkdir -p "$O"; echo x > "$O/pf-20261127-000000.dump"; LOG="$W/rc.log"
tn "без OFFSITE_REMOTE — отказ (не настроено)" env BACKUP_PATH="$O" sh "$HERE/offsite-sync.sh"
t "копирование и проверка проходят, пишется состояние ok" env BACKUP_PATH="$O" OFFSITE_REMOTE=off:pf FAKE_RCLONE_LOG="$LOG" sh "$HERE/offsite-sync.sh"
t "…last-offsite-sync.json: ok=true" sh -c "grep -q '\"ok\":true' $O/last-offsite-sync.json"
t "…копируются только файлы копий (фильтр)" sh -c "grep -q 'include pf-\*.dump' $LOG && grep -q 'include uploads-' $LOG"
t "…без OFFSITE_KEEP_DAYS ничего не удаляется" sh -c "! grep -q '^delete' $LOG"
t "…с OFFSITE_KEEP_DAYS чистится только внешнее хранилище" sh -c "env BACKUP_PATH=$O OFFSITE_REMOTE=off:pf OFFSITE_KEEP_DAYS=60 FAKE_RCLONE_LOG=$LOG sh $HERE/offsite-sync.sh && grep -q '^delete off:pf --min-age 60d' $LOG"
tn "ошибка копирования — отказ" env BACKUP_PATH="$O" OFFSITE_REMOTE=off:pf FAKE_RCLONE_COPY_FAIL=1 sh "$HERE/offsite-sync.sh"
t "…состояние ok=false" sh -c "grep -q '\"ok\":false' $O/last-offsite-sync.json"
tn "расхождение по размеру — отказ" env BACKUP_PATH="$O" OFFSITE_REMOTE=off:pf FAKE_RCLONE_CHECK_FAIL=1 sh "$HERE/offsite-sync.sh"
O2="$W/off2"; mkdir -p "$O2"
tn "нет копий для отправки — отказ" env BACKUP_PATH="$O2" OFFSITE_REMOTE=off:pf sh "$HERE/offsite-sync.sh"

echo "rotate-secrets.sh"
RS="$W/rs"; mkdir -p "$RS"; OLD=eyOLD000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
NEW=eyNEW000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
printf 'POSTGRES_PASSWORD=pgpass
CLOUDFLARE_TUNNEL_TOKEN=%s
BACKUP_DIR=/x
' "$OLD" > "$RS/.env"; chmod 600 "$RS/.env"
t "токен заменяется, остальные строки не тронуты" sh -c "printf '%s
' $NEW | env ENV_FILE=$RS/.env NO_RESTART=1 sh $HERE/rotate-secrets.sh tunnel-token && grep -q '^CLOUDFLARE_TUNNEL_TOKEN=$NEW\$' $RS/.env && grep -q '^POSTGRES_PASSWORD=pgpass\$' $RS/.env && grep -q '^BACKUP_DIR=/x\$' $RS/.env"
t "…делается копия прежнего .env (с правами 600 — на Linux)" sh -c "ls $RS/.env.bak-* >/dev/null && grep -q '^CLOUDFLARE_TUNNEL_TOKEN=eyOLD' $RS/.env.bak-* && case \"\$(uname -s)\" in MINGW*|MSYS*|CYGWIN*) true;; *) [ \"\$(stat -c %a $RS/.env.bak-*)\" = 600 ] && [ \"\$(stat -c %a $RS/.env)\" = 600 ];; esac"
tn "токен не в формате Cloudflare — отказ, .env не меняется" sh -c "echo notatoken | env ENV_FILE=$RS/.env NO_RESTART=1 sh $HERE/rotate-secrets.sh tunnel-token"
t "…прежний токен остаётся в .env" sh -c "grep -q '^CLOUDFLARE_TUNNEL_TOKEN=$NEW\$' $RS/.env"
tn "неизвестная команда — отказ" sh "$HERE/rotate-secrets.sh" bogus

echo "update.sh"
UD="$W/udbin"; mkdir -p "$UD"
cat > "$UD/docker" <<'SH'
#!/bin/sh
echo "$*" >> "$DOCKER_LOG"
case "$1 $2" in
  "compose build") n=$(cat "$DOCKER_CNT" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$DOCKER_CNT"; [ "$n" -le "${FAKE_BUILD_FAIL:-0}" ] && exit 1; exit 0;;
  "compose ps") for a; do svc=$a; done
    case "$svc" in api) echo "${FAKE_API_HEALTH:-healthy}|running";; web) echo "${FAKE_WEB_HEALTH:-healthy}|running";; worker) echo "|running";; esac; exit 0;;
  "compose images") echo "sha256:fakeimage"; exit 0;;
esac
exit 0
SH
chmod +x "$UD/docker"
UR="$W/urepo"; mkdir -p "$UR/deploy"; cp "$HERE/update.sh" "$UR/deploy/"; printf '#!/bin/sh\nexit 0\n' > "$UR/deploy/preflight.sh"; chmod +x "$UR/deploy/preflight.sh" "$UR/deploy/update.sh"
runu() { rm -f "$W/d.log" "$W/d.cnt"; env PATH="$UD:$PATH" DOCKER_LOG="$W/d.log" DOCKER_CNT="$W/d.cnt" SKIP_PULL=1 BUILD_RETRY_SLEEP=0 HEALTH_SLEEP=0 HEALTH_TRIES=3 "$@" sh "$UR/deploy/update.sh"; }
t "успешное обновление проходит" runu
t "…копия делается через --entrypoint (entrypoint сервиса — бесконечный цикл)" grep -qx "compose run --rm --entrypoint /backup.sh backup" "$W/d.log"
t "…сервисы перезапускаются по очереди: api, worker, web" sh -c "a=\$(grep -n '^compose up -d --no-deps api\$' $W/d.log | cut -d: -f1); w=\$(grep -n '^compose up -d --no-deps worker\$' $W/d.log | cut -d: -f1); x=\$(grep -n '^compose up -d --no-deps web\$' $W/d.log | cut -d: -f1); [ \"\$a\" -lt \"\$w\" ] && [ \"\$w\" -lt \"\$x\" ]"
t "…имя проекта по умолчанию — procurement (имена томов)" sh -c "grep -q procurement $UR/deploy/update.sh && ! grep -q 'COMPOSE_PROJECT_NAME:-procurement-finance' $UR/deploy/update.sh"
t "…пишется .deployed-version" test -s "$UR/.deployed-version"
t "сбой сети при сборке: повтор, затем успех" runu FAKE_BUILD_FAIL=2 BUILD_RETRIES=3
t "…сборка вызывалась трижды" sh -c "[ \"\$(grep -c '^compose build\$' $W/d.log)\" = 3 ]"
tn "сборка не удаётся совсем — отказ" runu FAKE_BUILD_FAIL=9 BUILD_RETRIES=2
t "…и ни один сервис при этом не перезапускался" sh -c "! grep -q 'up -d' $W/d.log"
tn "api не стал здоровым — отказ" runu FAKE_API_HEALTH=unhealthy
t "…выполнен откат: прежний образ возвращён и сервис поднят без сборки" sh -c "grep -qx 'tag pf-rollback-api procurement-api:latest' $W/d.log && grep -qx 'compose up -d --no-deps --no-build api' $W/d.log"
t "…web после неудачи api не запускался на новой версии" sh -c "! grep -qx 'compose up -d --no-deps web' $W/d.log"

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
for f in backup.sh restore-test.sh preflight.sh update.sh offsite-sync.sh rotate-secrets.sh; do t "sh -n $f" sh -n "$HERE/$f"; done

echo; echo "Итог: пройдено $PASS, провалено $FAIL"
[ "$FAIL" -eq 0 ]
