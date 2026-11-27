#!/bin/sh
# Безопасное обновление: проверка окружения → резервная копия → (git pull) → сборка → перезапуск по одному сервису → проверка → откат при сбое.
#  • Сборка идёт ДО остановки чего-либо: если Docker Hub недоступен (таймаут), запущенная версия не затрагивается; сборка повторяется.
#  • Перезапускаются только изменившиеся прикладные сервисы, по очереди (api → worker → web), с ожиданием готовности каждого.
#  • Если новый сервис не стал здоровым, возвращаются прежние образы (откат кода). Миграции БД откату не подлежат —
#    при их изменении восстановление из копии: docs/RUNBOOK.md.
# Переменные: COMPOSE_PROJECT_NAME (по умолчанию procurement), SKIP_PULL=1 (файлы залиты вручную, без git),
#             BUILD_RETRIES, BUILD_RETRY_SLEEP, HEALTH_TRIES, HEALTH_SLEEP.
set -eu
cd "$(dirname "$0")/.."
# Имя проекта фиксируется: оно определяет имена томов (procurement_pgdata). Другое имя = «пустой» стек рядом с боевым.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-procurement}"
BUILD_RETRIES="${BUILD_RETRIES:-3}"; BUILD_RETRY_SLEEP="${BUILD_RETRY_SLEEP:-20}"
HEALTH_TRIES="${HEALTH_TRIES:-40}"; HEALTH_SLEEP="${HEALTH_SLEEP:-3}"
APP_SERVICES="api worker web"

./deploy/preflight.sh

echo "→ резервная копия перед обновлением"
# entrypoint сервиса backup — бесконечный цикл, поэтому скрипт запускается через --entrypoint
docker compose run --rm --entrypoint /backup.sh backup

PREV=$(git rev-parse --short HEAD 2>/dev/null || cat .deployed-version 2>/dev/null || echo unknown)
if [ "${SKIP_PULL:-0}" != 1 ] && [ -d .git ]; then
  echo "→ получение обновлений (текущая версия $PREV)"
  git pull --ff-only
fi

echo "→ запоминаем текущие образы (для отката)"
for s in $APP_SERVICES; do
  img=$(docker compose images -q "$s" 2>/dev/null | head -n 1 || true)
  if [ -n "$img" ]; then docker tag "$img" "pf-rollback-$s" || true; fi
done

echo "→ сборка (запущенная версия продолжает работать)"
n=0
until docker compose build; do
  n=$((n + 1))
  if [ "$n" -ge "$BUILD_RETRIES" ]; then
    echo "СБОРКА НЕ УДАЛАСЬ после $n попыток. Запущенная версия не изменялась. Частая причина — временный сбой сети к Docker Hub: повторите позже." >&2
    exit 1
  fi
  echo "сборка не удалась ($n/$BUILD_RETRIES), повтор через ${BUILD_RETRY_SLEEP} с — обычно это временный сбой сети к Docker Hub"
  sleep "$BUILD_RETRY_SLEEP"
done

wait_ready() { # wait_ready сервис → 0, если сервис готов
  svc=$1; i=0
  while [ "$i" -lt "$HEALTH_TRIES" ]; do
    h=$(docker compose ps --format '{{.Health}}|{{.State}}' "$svc" 2>/dev/null | head -n 1)
    case "$h" in
      healthy*) return 0;;
      "|running"|"|"running*) [ "$svc" = worker ] && [ "$i" -ge 2 ] && return 0;;   # у воркера нет healthcheck: running и не перезапускается
    esac
    i=$((i + 1)); sleep "$HEALTH_SLEEP"
  done
  return 1
}

rollback() {
  echo "→ ОТКАТ: возвращаю прежние образы" >&2
  for s in $APP_SERVICES; do
    if docker image inspect "pf-rollback-$s" >/dev/null 2>&1; then
      docker tag "pf-rollback-$s" "$COMPOSE_PROJECT_NAME-$s:latest" || true
      docker compose up -d --no-deps --no-build "$s" || true
    fi
  done
}

echo "→ перезапуск по очереди с проверкой готовности"
for s in $APP_SERVICES; do
  docker compose up -d --no-deps "$s"
  if ! wait_ready "$s"; then
    echo "СЕРВИС $s не стал готовым. Предыдущая версия: $PREV. Логи: docker compose logs $s" >&2
    rollback
    exit 1
  fi
  echo "  $s готов"
done

echo "→ остальные сервисы (изменения конфигурации применяются, неизменённые не трогаются)"
docker compose up -d
date -u +%Y%m%d-%H%M%S > .deployed-version 2>/dev/null || true
echo "готово: обновление применено (предыдущая версия: $PREV)"
