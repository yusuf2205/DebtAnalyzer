#!/bin/sh
# Замена токена туннеля Cloudflare без правки .env вручную.
#   sh deploy/rotate-secrets.sh tunnel-token      (новый токен читается со стандартного ввода, в историю команд не попадает)
# Делает копию .env (права 600), подставляет токен, пересоздаёт только сервис cloudflared и проверяет, что он запущен.
# Переменные для тестов: ENV_FILE (путь к .env), NO_RESTART=1 (не трогать Docker).
set -eu
ENV_FILE="${ENV_FILE:-$(cd "$(dirname "$0")/.." && pwd)/.env}"
cmd="${1:-}"
case "$cmd" in
  tunnel-token)
    [ -f "$ENV_FILE" ] || { echo "нет файла $ENV_FILE" >&2; exit 1; }
    printf 'Новый токен туннеля (ввод скрыт, затем Enter): ' >&2
    stty -echo 2>/dev/null || true; IFS= read -r TOKEN || true; stty echo 2>/dev/null || true; echo >&2
    case "$TOKEN" in ey*) ;; *) echo "токен должен начинаться с «ey» (Cloudflare: Tunnels → Refresh token / Install)" >&2; exit 1;; esac
    [ "${#TOKEN}" -ge 100 ] || { echo "токен слишком короткий" >&2; exit 1; }
    TS=$(date +%Y%m%d-%H%M%S); cp -p "$ENV_FILE" "$ENV_FILE.bak-$TS"; chmod 600 "$ENV_FILE.bak-$TS"
    TMP="$ENV_FILE.tmp.$$"
    if grep -q '^CLOUDFLARE_TUNNEL_TOKEN=' "$ENV_FILE"; then
      while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in CLOUDFLARE_TUNNEL_TOKEN=*) printf 'CLOUDFLARE_TUNNEL_TOKEN=%s\n' "$TOKEN";; *) printf '%s\n' "$line";; esac
      done < "$ENV_FILE" > "$TMP"
    else { cat "$ENV_FILE"; printf 'CLOUDFLARE_TUNNEL_TOKEN=%s\n' "$TOKEN"; } > "$TMP"; fi
    chmod 600 "$TMP"; mv "$TMP" "$ENV_FILE"
    echo "токен заменён (копия прежнего .env: $ENV_FILE.bak-$TS — удалите её после проверки: в ней старый токен)"
    if [ "${NO_RESTART:-0}" != 1 ]; then
      ( cd "$(dirname "$ENV_FILE")" && docker compose -p "${COMPOSE_PROJECT:-procurement}" up -d cloudflared && sleep 8 && docker compose -p "${COMPOSE_PROJECT:-procurement}" ps cloudflared )
    fi
    ;;
  *) echo "использование: sh deploy/rotate-secrets.sh tunnel-token" >&2; exit 2;;
esac
