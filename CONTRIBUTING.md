# Contributing

## Инварианты

- Лимиты Telegram (`4096`, `32768`, `1024`, `64`) живут только в `src/config/constants.ts`. Хардкод в других файлах запрещён.
- Экранирование — только `escapeFor` из `src/utils/escape.ts`. Не собирайте HTML конкатенацией без неё.
- Разбиение — только `splitVisible` / `truncateVisible`. Они учитывают теги, entities и escape-пары.
- Inline-клавиатуры, `callback_data`, rich/fallback и caption — только в `src/telegram/sender.ts`.
- Rich-сообщения никогда не редактируются: `editMessageText` работает только с HTML.
- Запрещено импортировать `@oh-my-pi/*`: шлюз общается с OMP только через RPC-контракт. Иначе standalone-бинарник потянет весь agent runtime.
- Reply keyboard не используется.
- `src/omp/client.ts` — единственное место `Bun.spawn`, рукопожатия и закрытия процесса.
- STT — отдельный loopback-сайдкар на Python (`scripts/stt_server.py`); TypeScript-клиент только ходит по HTTP. Не встраивайте faster-whisper в бинарник.

## Перед PR

```sh
bun run typecheck
bun test
bun run build
```

Тесты обязательны для нового поведения. Офлайн-тесты не должны ходить в сеть: Telegram API и OMP подменяются (`src/tests/helpers/`). Реальный OMP проверяется только в `ci-omp.test.ts` под `OMP_E2E=1`; живой STT — только вручную через `curl`/клиент.

## Стиль

- TypeScript strict, ESM, `.ts`-расширения в импортах.
- Никаких `any` на границах: входящие кадры OMP и Telegram парсятся Zod-схемами либо проверяются `typeof`/`in`.
- Ошибки логируются структурированно (`event` + поля), тела сообщений и base64 не пишутся в лог.
- Секреты не попадают в логи: ключи с `token|secret|authorization|apiKey` редактируются автоматически.

## Коммиты

Английский, повелительное наклонение: `add rich fallback`, `fix chunk reassembly`.
