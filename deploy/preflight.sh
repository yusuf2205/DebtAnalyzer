#!/bin/sh
# Проверка окружения ПЕРЕД запуском на NAS:  ./deploy/preflight.sh   (код выхода != 0 — запускать нельзя)
cd "$(dirname "$0")/.." || exit 2
ERR=0; WARN=0
err()  { echo "  ✗ $1"; ERR=$((ERR+1)); }
warn() { echo "  ! $1"; WARN=$((WARN+1)); }
ok()   { echo "  ✓ $1"; }
val()  { grep -E "^$1=" .env 2>/dev/null | head -n1 | cut -d= -f2-; }

echo "Проверка .env"
if [ ! -f .env ]; then err ".env не найден (cp .env.example .env и заполните)"; echo "Итог: ошибок $ERR"; exit 1; fi
if git ls-files --error-unmatch .env >/dev/null 2>&1; then err ".env отслеживается Git — секреты не должны попадать в репозиторий"; else ok ".env не в Git"; fi
PERM=$(stat -c %a .env 2>/dev/null || stat -f %Lp .env 2>/dev/null)
case "$PERM" in 600|400) ok "права на .env: $PERM";; *) warn "права на .env: ${PERM:-?} — рекомендуется chmod 600 .env";; esac

PG=$(val POSTGRES_PASSWORD)
[ -n "$PG" ] || err "POSTGRES_PASSWORD не задан"
[ "${#PG}" -ge 24 ] || err "POSTGRES_PASSWORD короче 24 символов"
echo "$PG" | grep -qE '^[A-Za-z0-9_-]+$' || err "POSTGRES_PASSWORD должен состоять только из латинских букв, цифр, _ и - (пароль подставляется в URL подключения)"
[ -n "$(val CLOUDFLARE_TUNNEL_TOKEN)" ] || err "CLOUDFLARE_TUNNEL_TOKEN не задан"

EM=$(val INITIAL_ADMIN_EMAIL); IP=$(val INITIAL_ADMIN_PASSWORD)
if [ -n "$IP" ]; then
  [ -n "$EM" ] || err "INITIAL_ADMIN_PASSWORD задан без INITIAL_ADMIN_EMAIL"
  [ "${#IP}" -ge 12 ] || err "INITIAL_ADMIN_PASSWORD короче 12 символов"
  if ! echo "$IP" | grep -qE '[0-9]' || ! echo "$IP" | grep -qE '[A-Za-z]'; then err "INITIAL_ADMIN_PASSWORD должен содержать буквы и цифры"; fi
  warn "INITIAL_ADMIN_PASSWORD задан: после первого входа и смены пароля удалите его из .env"
else
  ok "начальный администратор не задан (нормально для уже работающей системы)"
fi

if [ -n "$(val GOOGLE_CLIENT_ID)" ]; then
  [ -n "$(val GOOGLE_CLIENT_SECRET)" ] || err "GOOGLE_CLIENT_ID задан без GOOGLE_CLIENT_SECRET"
  case "$(val GOOGLE_REDIRECT_URI)" in https://*) ok "GOOGLE_REDIRECT_URI по HTTPS";; *) err "GOOGLE_REDIRECT_URI должен начинаться с https://";; esac
  K=$(val TOKEN_ENCRYPTION_KEY); [ "${#K}" -ge 32 ] || err "TOKEN_ENCRYPTION_KEY короче 32 символов (нужен для хранения токенов Google)"
else
  ok "вход через Google не настроен (публичные таблицы работают без него)"
fi

BD=$(val BACKUP_DIR); BD=${BD:-./backups}
if [ ! -d "$BD" ]; then
  if mkdir -p "$BD" 2>/dev/null; then ok "создан каталог копий $BD"; else err "каталог копий $BD не существует и не создаётся"; fi
fi
if [ -w "$BD" ]; then ok "каталог копий доступен для записи: $BD"; else err "каталог копий не доступен для записи: $BD"; fi
case "$BD" in /*) ;; *) warn "BACKUP_DIR относительный ($BD) — для NAS укажите абсолютный путь на другом томе/диске, чем база данных";; esac

if command -v docker >/dev/null 2>&1; then
  if docker compose config -q 2>/dev/null; then ok "docker-compose.yml корректен"; else err "docker compose config не проходит — проверьте .env и docker-compose.yml"; fi
else
  warn "docker не найден — конфигурацию Compose проверить нельзя"
fi
echo "Итог: ошибок $ERR, предупреждений $WARN"
[ "$ERR" -eq 0 ]
