# Changelog

Все заметные изменения проекта. Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/).

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
