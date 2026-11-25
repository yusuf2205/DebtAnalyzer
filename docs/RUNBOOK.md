# Эксплуатация на NAS (UGREEN DXP4800 Plus)

> Статус: конфигурация Docker подготовлена, но **ещё не запускалась на NAS** (на машине разработки нет Docker-демона).
> Первый запуск проверьте по чек-листу ниже.

## Первый запуск
1. Установите Docker (UGOS: «Docker» из центра приложений) и скопируйте репозиторий на NAS.
2. `cp .env.example .env`, заполните `POSTGRES_PASSWORD` (`openssl rand -base64 32`), `INITIAL_ADMIN_*`, `CLOUDFLARE_TUNNEL_TOKEN`, `BACKUP_DIR` (том NAS).
3. Cloudflare Zero Trust → Tunnels → создайте туннель, Public hostname → `http://web:3000`.
4. `docker compose up -d --build`, затем `docker compose ps` — все сервисы `healthy`/`running`.
5. Войдите под начальным администратором, смените пароль, удалите `INITIAL_ADMIN_PASSWORD` из `.env`.

Чек-лист: `docker compose ps` · `docker compose logs api | tail` · вход через HTTPS-домен · перезагрузка NAS → сервисы поднялись сами (`restart: unless-stopped`).

## Безопасность сети
Порты postgres/api/web на хост не публикуются; единственный вход — исходящий туннель cloudflared (HTTPS на стороне Cloudflare).
Включите Cloudflare Access (SSO/OTP) перед приложением как дополнительный слой.

## Резервные копии
Сервис `backup` раз в сутки делает `pg_dump -Fc` в `BACKUP_DIR`, проверяет архив `pg_restore --list`, удаляет копии старше `BACKUP_KEEP_DAYS`.
Загруженные исходные файлы лежат в томе `uploads` — копируйте его вместе с дампом (`docker run --rm -v procurement-finance_uploads:/d -v $PWD/backups:/b alpine tar czf /b/uploads.tgz -C /d .`).
Копируйте `BACKUP_DIR` вне NAS (облако/второй диск).

## Восстановление (проверяйте раз в квартал на тестовом стенде!)
```sh
docker compose stop api worker web
docker compose exec -T postgres psql -U pf -d postgres -c 'DROP DATABASE pf' -c 'CREATE DATABASE pf'
docker compose exec -T postgres pg_restore -U pf -d pf --no-owner < backups/pf-YYYYMMDD-HHMMSS.dump
docker compose start api worker web
```
Проверка: вход работает, число договоров/платежей совпадает с ожидаемым, в журнале аудита нет разрывов.

## Логи и мониторинг
`docker compose logs -f api` (ротация 10 МБ × 5). Health: `GET /api/health` (используется healthcheck Docker). Для оповещений — Uptime Kuma на `https://<домен>/api/health`.

## Google Sheets
**Публичная таблица** (настройки не нужны): в Google Таблице «Настройки доступа → Все, у кого есть ссылка → Читатель». В приложении: «Google Sheets» → вставить ссылку → «Проверить доступ» → выбрать лист и год плана → «Подключить и загрузить данные».

**Закрытая таблица** (OAuth, права только на чтение таблиц `spreadsheets.readonly`):
1. Google Cloud Console → новый проект → включить **Google Sheets API**.
2. OAuth consent screen (External; в режиме Testing добавьте свой аккаунт в Test users) → Credentials → **OAuth client ID → Web application**.
3. Authorized redirect URI: `https://<ваш-домен>/api/google/oauth/callback` (для проверки на ПК: `http://localhost:3000/api/google/oauth/callback`).
4. Заполните в `.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY`; `docker compose up -d`.
5. «Google Sheets» → «Подключить Google-аккаунт» → разрешить доступ.

Как работает синхронизация: приложение **только читает** таблицу. Каждая синхронизация (кнопка или по расписанию, воркер проверяет каждые 5 минут) создаёт предпросмотр изменений относительно последнего сохранённого импорта. Договоры, оплаты и задолженность меняются только после подтверждения; изменение «Оплачено» у существующего договора превращается в задачу сверки. Если данные не изменились, новых черновиков нет. Ошибки (закрыт доступ, лист переименован) видны в статусе источника.
Refresh-токены Google хранятся в БД зашифрованными (AES-256-GCM, ключ — `TOKEN_ENCRYPTION_KEY`). Отзыв доступа: myaccount.google.com → Безопасность → Сторонние приложения.
