#!/bin/sh
# Безопасное обновление: проверка окружения -> резервная копия -> получение обновлений -> сборка -> запуск -> проверка здоровья.
# Откат — docs/RUNBOOK.md (раздел «Откат»): git checkout <прежняя версия>, при изменении схемы БД — восстановление из копии.
set -eu
cd "$(dirname "$0")/.."
./deploy/preflight.sh
echo "→ резервная копия перед обновлением"
docker compose run --rm backup /backup.sh
PREV=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
echo "→ получение обновлений (текущая версия $PREV)"
git pull --ff-only
echo "→ сборка и запуск"
docker compose build
docker compose up -d
echo "→ ожидание готовности"
i=0
while [ "$i" -lt 40 ]; do
  S=$(docker compose ps --format '{{.Service}}={{.Health}}' | grep -E '^(api|web)=' | tr '\n' ' ')
  case "$S" in
    *unhealthy*|*starting*) ;;
    *api=healthy*web=healthy*|*web=healthy*api=healthy*) echo "готово: $S"; exit 0;;
  esac
  i=$((i+1)); sleep 3
done
echo "ВНИМАНИЕ: сервисы не стали healthy за 2 минуты. Предыдущая версия: $PREV. Логи: docker compose logs api" >&2
exit 1
