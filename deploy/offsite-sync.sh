#!/bin/sh
# Копия резервных копий ВНЕ NAS (rclone). Запускается в сервисе offsite (профиль offsite) раз в 6 часов.
# Копирует (copy, а не sync): удаление файлов на NAS не удаляет их во внешнем хранилище. После копирования проверяет
# совпадение размеров, и только затем пишет last-offsite-sync.json — его читает страница «Система».
# Настройка: OFFSITE_REMOTE (например, "offsite:procurement") и конфигурация rclone (rclone.conf или RCLONE_CONFIG_* ).
# Рекомендуется шифрование (тип crypt): данные уходят во внешнее хранилище уже зашифрованными.
set -u
DIR="${BACKUP_PATH:-/backups}"
STATE="$DIR/last-offsite-sync.json"

state() { # state ok|true|false "описание"
  printf '{"at":"%s","ok":%s,"detail":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE" && chmod 644 "$STATE"
}

if [ -z "${OFFSITE_REMOTE:-}" ]; then echo "offsite: OFFSITE_REMOTE не задан — копирование вне NAS не настроено" >&2; exit 2; fi
if ! ls "$DIR"/pf-*.dump >/dev/null 2>&1; then state false "в каталоге нет копий для отправки"; echo "offsite FAILED: нет копий" >&2; exit 1; fi

FILTER="--include pf-*.dump --include pf-*.dump.sha256 --include uploads-*.tgz --include last-restore-test.json"
# shellcheck disable=SC2086
if ! rclone copy "$DIR" "$OFFSITE_REMOTE" $FILTER --retries 3 --low-level-retries 5 --stats 0; then
  state false "ошибка копирования (см. docker compose logs offsite)"; echo "offsite FAILED: copy" >&2; exit 1
fi
# shellcheck disable=SC2086
if ! rclone check "$DIR" "$OFFSITE_REMOTE" --one-way --size-only $FILTER; then
  state false "копия не совпала с оригиналом по размеру"; echo "offsite FAILED: check" >&2; exit 1
fi
if [ -n "${OFFSITE_KEEP_DAYS:-}" ]; then
  # Во внешнем хранилище удаляются только файлы копий старше N дней (сами копии на NAS не затрагиваются).
  rclone delete "$OFFSITE_REMOTE" --min-age "${OFFSITE_KEEP_DAYS}d" --include "pf-*" --include "uploads-*" || echo "warning: очистка старых копий не удалась" >&2
fi
N=$(ls -1 "$DIR"/pf-*.dump | wc -l | tr -d ' ')
state true "отправлено и проверено; копий на NAS: $N"
echo "offsite ok: копий на NAS $N"
