# Changelog

Все заметные изменения проекта. Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/).

## [1.0.3] — 2026-10-31

### Исправлено

- Ответ `batchexecute` больше не буферизуется целиком: патч идёт потоково через `TransformStream`, первый байт уходит сразу (раньше время до первого байта равнялось времени полной загрузки ответа).
- Ошибка чтения тела ответа пробрасывается вызывающему коду; раньше возвращался уже «сожжённый» `Response` и вместо исходной ошибки возникало `Body is unusable`.
- Геттер `XMLHttpRequest.responseText` больше не подменяет `InvalidStateError` (чтение до готовности) пустой строкой.
- Разбор потока: поддерживаются префикс `)]}'\n` и `)]}'\r\n\r\n`, пустые строки между чанками, поток без префикса и обе конвенции длины чанка — при смене формата патч не превращается в молчаливый no-op.
- `fetch` с `URL`-объектом в первом аргументе теперь тоже распознаётся.
- Из пересозданного `Response` удаляется `content-encoding` (тело уже разжато); `content-length` пересчитывается.

### Добавлено

- Защита от цикла редиректов `/unsupported-country` → `/` (не больше 3 переходов за 10 секунд).
- Кэш последнего разобранного ответа для повторных чтений `responseText` / `response`.
- Тесты (`npm test`, встроенный `node:test`) на парсер потока, хуки `fetch`/XHR, редирект и релиз-скрипт.
- `scripts/release.js` отказывается выпускать релиз не из ветки `main` и печатает подсказку для отката при неудачном пуше.

### Обновлено

- `scripts/release.js`: человекочитаемые ошибки git вместо дампа стека, пуш текущей ветки, `--dry-run` работает при незакоммиченных изменениях.
- `.gitignore`: временные `.release-notes-*.md`.

## [1.0.2] — 2026-10-31

### Изменено

- Fix stream parser hang, XHR responseType semantics, preserve availability status

## [1.0.1] — 2026-10-31

### Изменено

- Add release automation script

## [1.0.0] — 2026-10-31

### Добавлено

- Юзерскрипт Flow Bridge для Firefox (Tampermonkey / Violentmonkey / Greasemonkey).
- Хуки `fetch` и `XMLHttpRequest` на `document-start`.
- Патчи ответов Flow:
  - `cPZSdc` — `is_country_supported` / `is_age_supported`;
  - RPC доступности `KV2T2d`, `rThb8d`, `cO7JOb`, `md9xJf`;
  - `availabilityState`, `isCountrySupported`, `isAgeSupported` в JSON.
- Поддержка Closure-стрима `)]}'\n\n` (чанки с длиной-префиксом).
- Блокировка NextAuth `api/auth/signout`.
- Редирект `/unsupported-country` → `/`.
- Выключатель через `localStorage.flow_bridge_ff_off`.
