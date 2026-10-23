[![CI](https://github.com/DemumuMind/omp-tg/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/DemumuMind/omp-tg/actions/workflows/ci.yml)

# omp-tg

Telegram-шлюз к [OMP](https://docs.omp.sh): агент живёт в Telegram как обычный собеседник, а шлюз общается с `omp --mode rpc` по официальному JSON-RPC (NDJSON поверх stdio). Один standalone-бинарник Bun, без Node.js и Docker.

## Возможности

- DM, группы и форумы: в группе у каждого участника своя сессия OMP внутри `chat_id:thread_id`.
- Стриминг ответа в редактируемое сообщение, финал — нативное rich-сообщение Telegram с fallback на HTML.
- Inline-диалоги OMP: `ask` (single/multi + свой ответ), `select`, `confirm`, `input`, `editor`.
- Медиа: фото уходят в prompt; голос и аудио транскрибируются локальным faster-whisper (если включён STT); видео, видео-заметки и документы сохраняются и передаются агенту путём.
- `MEDIA:/path` в ответе агента автоматически отправляется как нативное вложение (фото, видео, голос, аудио, документ).
- Реакции `👀 → 👍/👎`, ответы с цитированием, теги автора в группах.
- Группы: allowlist чатов, режим «только по упоминанию», regex wake words.
- Меню команд в Telegram, `/model` с inline-пикером, `/usage` по токенам и стоимости.
- Inline-поиск команд (`@bot имя`) - работает после `/setinline` в BotFather.
- Управление сессиями: `/sessions`, `/resume`, `/title`, `/export` в HTML.
- Ответ на голосовое можно получить голосом: локальный Piper, без облака.
- Health-эндпоинт, systemd watchdog `Type=notify`, лимиты памяти/CPU на OMP-scope, ретенция файлов.
- `!cmd` — bash через OMP; `@path` — файл из рабочего каталога.
- Allowlist пользователей, sandbox для `@path`, denylist разрушительных команд.

Репозиторий: https://github.com/DemumuMind/omp-tg (public, MIT).

## Требования

- Linux, systemd.
- [Bun](https://bun.sh) 1.4.3 для сборки.
- OMP ≥ 18.12, установленный и авторизованный под тем же пользователем (`omp` → `/login`, либо API-key в окружении).

## Быстрый старт

```sh
bun install
bun run typecheck
bun test
bun run build

TELEGRAM_BOT_TOKEN=... \
ALLOWED_USER_IDS=123456789 \
OMP_BIN=$(command -v omp) \
OMP_WORKDIR=$PWD \
OMP_SESSION_ROOT=$PWD/.omp-sessions \
./dist/omp-tg
```

`--check` проверяет конфиг и доступность бинарника OMP, не запуская polling:

```sh
TELEGRAM_BOT_TOKEN=test ALLOWED_USER_IDS=1 ./dist/omp-tg --check
```

## BotFather

1. `/newbot`, получить токен.
2. Для групп: отключить privacy mode (`/setprivacy` → Disable), иначе бот не увидит обычные сообщения.
3. Для форумов: включить топики и выдать боту право `can_manage_topics` (нужно для `message_thread_id`).
4. Узнать свой `user_id` можно у @userinfobot и вписать в `ALLOWED_USER_IDS`.
5. Для inline-поиска: `/setinline` → выбрать бота → placeholder (например, `command`). Без этого шага Telegram не присылает inline-запросы.

## Конфигурация

Все переменные — в `.env.example`. Ключевые:

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | токен BotFather |
| `ALLOWED_USER_IDS` | — | обязательный список ID через запятую |
| `OMP_ENDPOINT` | `spawn` | единственный поддерживаемый транспорт |
| `OMP_BIN` | `/home/omp/.local/bin/omp` | путь к OMP |
| `OMP_WORKDIR` | `/home/omp/workspace` | cwd агента и корень sandbox для `@path` |
| `OMP_SESSION_ROOT` | `/home/omp/.omp/tg-sessions` | каталоги сессий OMP |
| `OMP_UPLOAD_DIR` | `$OMP_WORKDIR/.omp-tg-uploads` | входящие документы |
| `OMP_SPAWN_MODE` | `direct` | `systemd-user-scope` выносит OMP из cgroup шлюза |
| `MAX_ACTIVE_SESSIONS` | `4` | одновременно живых OMP-процессов |
| `IDLE_TIMEOUT_MS` | `1800000` | простой до закрытия сессии |
| `OMP_START_TIMEOUT_MS` | `30000` | ожидание `ready` от OMP |
| `OMP_REQUEST_TIMEOUT_MS` | `30000` | таймаут RPC-команды (не промпта) |
| `THROTTLE_MS` | `1200` | минимальный интервал правок streaming-сообщения |
| `OMP_MEMORY_MAX` | `1G` | лимит памяти на OMP-scope |
| `OMP_MEMORY_SWAP_MAX` | `256M` | лимит swap на OMP-scope |
| `OMP_TASKS_MAX` | `512` | лимит задач на OMP-scope |
| `OMP_CPU_QUOTA` | `200%` | лимит CPU на OMP-scope |
| `HEALTH_HOST` / `HEALTH_PORT` | `127.0.0.1:8766` | локальный `/health`; `0` отключает |
| `RETENTION_UPLOAD_DAYS` | `14` | удаление старых входящих файлов |
| `RETENTION_EXPORT_DAYS` | `14` | удаление старых HTML-экспортов |
| `SESSION_RETENTION_DAYS` | `0` | удаление старых `.jsonl`; `0` — не трогать |
| `STT_ENABLED` | `false` | транскрибировать голос/аудио локальным faster-whisper |
| `STT_URL` | `http://127.0.0.1:8765` | адрес STT-сайдкара |
| `STT_LANGUAGE` | пусто (auto) | язык распознавания, например `ru` |
| `STT_TIMEOUT_MS` | `120000` | таймаут распознавания |
| `TTS_ENABLED` | `false` | локальный Piper для голосовых ответов |
| `TTS_URL` | `http://127.0.0.1:8767` | адрес TTS-сайдкара |
| `TTS_TIMEOUT_MS` | `120000` | таймаут синтеза |
| `TTS_MAX_CHARS` | `1500` | максимум символов в озвучке |

## Команды

| Команда | Действие |
|---|---|
| `/start`, `/help` | справка |
| `/new` | новая сессия OMP |
| `/abort` | прервать текущий тур |
| `/status` | модель, sessionId, занятость, число сообщений |
| `/cancel` | закрыть активный диалог `ask` |
| `/model [name]` | inline-пикер модели или прямое переключение |
| `/usage` | токены, стоимость, число инструментов |
| `/commands` | команды шлюза и OMP |
| `/whoami` | user/chat/thread, бот, уровень доступа |
| `/sessions` | последние 10 сессий чата: файл, дата, размер |
| `/resume <номер\|id>` | переключиться на сессию из `/sessions` |
| `/title <name>` | имя текущей сессии OMP |
| `/export` | HTML-экспорт сессии файлом |
| `/file <path>` | отправить файл из `OMP_WORKDIR` (≤ 50 MB) |
| `MEDIA:/path` | агент сам отправляет вложение из `OMP_WORKDIR` |
| `/id` | `chat_id`, `thread_id`, `user_id` |
| `!cmd` | bash через OMP, таймаут 30 с |
| `@path` | передать файл агенту; путь обязан быть внутри `OMP_WORKDIR` |
| любой другой `/cmd` | уходит в OMP как родная slash-команда |

## Безопасность

- Пустой `ALLOWED_USER_IDS` невозможен: конфиг не загрузится.
- `!cmd` выполняется не shell'ом шлюза, а RPC-командой `bash` самого OMP; перед вызовом срабатывает denylist (`rm -rf /`, `mkfs`, `dd of=/dev/*`, fork bomb и т.п.). Denylist — эвристика, не sandbox.
- `@path`, `/file` и `MEDIA:` резолвятся через `realpath` и обязаны лежать внутри `OMP_WORKDIR`; для `@path` дополнительно разрешён `OMP_UPLOAD_DIR` (входящие документы).
- Шлюз работает под отдельным пользователем `omp`; юнит включает `ProtectSystem=strict`, `NoNewPrivileges`, `PrivateTmp`, `MemoryMax=512M`.

## Деплой

```sh
sudo install -d -o omp -g omp /opt/omp-tg/bin /etc/omp-tg
sudo install -m 0755 dist/omp-tg /opt/omp-tg/bin/omp-tg
sudo install -m 0644 deploy/omp-tg.service /etc/systemd/system/omp-tg.service
sudo install -m 0644 deploy/omp-update.service /etc/systemd/system/omp-update.service
sudo install -m 0644 deploy/omp-update.timer /etc/systemd/system/omp-update.timer
sudo install -m 0755 deploy/omp-update.sh /opt/omp-tg/bin/omp-update.sh
sudo install -m 0755 deploy/omp-tg-update.sh /opt/omp-tg/bin/omp-tg-update.sh
sudo install -m 0755 deploy/omp-tg-backup.sh /opt/omp-tg/bin/omp-tg-backup.sh
sudo install -m 0644 deploy/omp-tg-update.service /etc/systemd/system/omp-tg-update.service
sudo install -m 0644 deploy/omp-tg-update.timer /etc/systemd/system/omp-tg-update.timer
sudo install -m 0644 deploy/omp-tg-backup.service /etc/systemd/system/omp-tg-backup.service
sudo install -m 0644 deploy/omp-tg-backup.timer /etc/systemd/system/omp-tg-backup.timer
sudo install -m 0755 scripts/stt_server.py /opt/omp-tg/bin/stt_server.py
sudo install -m 0755 scripts/tts_server.py /opt/omp-tg/bin/tts_server.py
sudo install -m 0600 /dev/null /etc/omp-tg/env   # затем вписать токен и ALLOWED_USER_IDS

sudo loginctl enable-linger omp                 # нужно для systemd-run --user
sudo systemctl daemon-reload
sudo systemctl enable --now omp-tg
sudo systemctl enable --now omp-update.timer
sudo systemctl enable --now omp-tg-update.timer
sudo systemctl enable --now omp-tg-backup.timer
```

STT (опционально, локально, без облака и ключей):

```sh
sudo -u omp uv venv /home/omp/.local/share/omp-tg/stt-venv --python /usr/bin/python3
sudo -u omp uv pip install --python /home/omp/.local/share/omp-tg/stt-venv/bin/python faster-whisper
sudo -u omp /home/omp/.local/share/omp-tg/stt-venv/bin/python - <<'PY'
from faster_whisper import WhisperModel
WhisperModel("small", device="cpu", compute_type="int8", download_root="/home/omp/.cache/omp-tg-stt")
PY
sudo install -m 0644 deploy/omp-tg-stt.service /etc/systemd/system/omp-tg-stt.service
sudo systemctl daemon-reload
sudo systemctl enable --now omp-tg-stt
```

TTS (опционально, локальный Piper):

```sh
sudo -u omp uv venv /home/omp/.local/share/omp-tg/tts-venv --python /usr/bin/python3
sudo -u omp uv pip install --python /home/omp/.local/share/omp-tg/tts-venv/bin/python piper-tts
sudo -u omp mkdir -p /home/omp/.local/share/omp-tg/piper
sudo -u omp curl -fL -o /home/omp/.local/share/omp-tg/piper/ru_RU-irina-medium.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/irina/medium/ru_RU-irina-medium.onnx
sudo -u omp curl -fL -o /home/omp/.local/share/omp-tg/piper/ru_RU-irina-medium.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/irina/medium/ru_RU-irina-medium.onnx.json
sudo install -m 0644 deploy/omp-tg-tts.service /etc/systemd/system/omp-tg-tts.service
sudo systemctl daemon-reload
sudo systemctl enable --now omp-tg-tts
```

В `/etc/omp-tg/env`: `TTS_ENABLED=true`, `TTS_URL=http://127.0.0.1:8767`. Голосовой ответ отправляется только на транскрибированный voice/audio; текст остаётся основным ответом. Для health/watchdog юнит использует `Type=notify`, `WatchdogSec=90`; проверка: `curl -fsS http://127.0.0.1:8766/health`.

Затем в `/etc/omp-tg/env` (или drop-in) выставить `STT_ENABLED=true`, `STT_LANGUAGE=ru`, `STT_TIMEOUT_MS=300000` и перезапустить `omp-tg`. Юнит STT ограничен `MemoryMax=2G`, слушает только loopback. Модель `small` (~460 MB, int8) грузится один раз, на 2 CPU распознавание идёт примерно в реальном времени.

Обновление OMP — ежедневный таймер (`04:00`, `Persistent=true`): `omp update --stable` + `systemctl restart omp-tg`. Отдельного `omp.service` нет: OMP-процессы — дети шлюза.

Обновление самого шлюза — ежедневный таймер (`04:30`): скачивает `omp-tg` и `omp-tg.sha256` из latest GitHub release, проверяет checksum, атомарно подменяет бинарник и перезапускает сервис только если файл изменился. Предыдущая версия остаётся в `/opt/omp-tg/bin/omp-tg.prev`. Ручной запуск: `sudo systemctl start omp-tg-update`.

Обновление бинарника — атомарная подмена:

```sh
sudo deploy/install.sh dist/omp-tg
```

Бэкап — ежедневно (`03:30`): `/etc/omp-tg/env` и `OMP_SESSION_ROOT` в `/var/backups/omp-tg/omp-tg-<UTC>.tar.gz` (0600, хранится 14 дней). Восстановление:

```sh
sudo tar -xzf /var/backups/omp-tg/omp-tg-<stamp>.tar.gz -C /
sudo systemctl restart omp-tg
```

Бэкап локальный; для offsite добавьте свой rclone/S3-шаг в `deploy/omp-tg-backup.sh`.

Диагностика:

```sh
journalctl -u omp-tg -o cat -f
journalctl -u omp-tg-stt -o cat -f
journalctl -u omp-tg-tts -o cat -f
journalctl -u omp-update -o cat
journalctl -u omp-tg-update -o cat
journalctl -u omp-tg-backup -o cat
```

Шлюз пишет по одной JSON-строке на событие; токены и секреты редактируются.

## Ограничения

- Один OMP-процесс на пользователя в `chat_id:thread_id`; при `MAX_ACTIVE_SESSIONS` самая старая простаивающая сессия закрывается, занятые — нет (новый чат получит «все сессии заняты»).
- `OMP_ENDPOINT` поддерживает только `spawn`: у OMP нет сетевого сервера.
- Обработка апдейтов параллельна между чатами и последовательна внутри чата; долгий `!cmd` не блокирует другие чаты.
- Без запущенного STT голос и аудио уходят агенту путём; транскрипция не облачная и не требует ключей.
- TTS `ru_RU-irina-medium` рассчитан на русский; для другого языка замени модель и `TTS_MODEL`.
- Ретенция сессий по умолчанию выключена (`SESSION_RETENTION_DAYS=0`), чтобы не удалять историю.
- `small`/int8 на CPU ошибается на шумных и коротких записях; язык задаётся `STT_LANGUAGE`, auto-режим на коротких фразах менее стабилен.
- Inline-поиск требует ручного `/setinline` в BotFather; кэш команд OMP заполняется после первого `/commands` или работы сессии.
- В RPC-модели OMP только text/image content: произвольные файлы, созданные агентом, автоматически не отправляются — используйте `/file`.
- `--mode rpc-ui` не поддерживается; только `rpc`.

## Разработка

```sh
bun test                  # офлайн; реальный OMP не нужен
OMP_E2E=1 bun run test:omp  # handshake против установленного OMP
```

Архитектура: `src/omp/client.ts` — единственное место spawn/handshake/close и scope-лимитов; `src/omp/session-manager.ts` — LRU и жизненный цикл сессий; `src/telegram/sender.ts` — единственное место rich/fallback, нарезки и inline-клавиатур; `src/stt/` + `scripts/stt_server.py` — распознавание, `src/tts/` + `scripts/tts_server.py` — синтез; `src/health/server.ts` + `src/utils/watchdog.ts` — liveness. Подробности — в `CONTRIBUTING.md`.
