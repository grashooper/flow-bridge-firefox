# 🌉 Flow Bridge для Firefox

<div align="center">

![Version](https://img.shields.io/badge/version-1.0.1-blue?style=for-the-badge)
![Platform](https://img.shields.io/badge/platform-Firefox%20%7C%20Tampermonkey-orange?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)

[![Install in Tampermonkey](https://img.shields.io/badge/Install%20in-Tampermonkey-00A82D?style=for-the-badge&logo=tampermonkey&logoColor=white)](https://raw.githubusercontent.com/grashooper/flow-bridge-firefox/main/flow-bridge-firefox.user.js)

**Разблокировка Google Flow в Firefox**

*Один самодостаточный юзерскрипт — без VPN и прокси*

[🚀 Быстрый старт](#-быстрый-старт) •
[⚙️ Использование](#️-использование) •
[🔍 Диагностика](#-диагностика) •
[💖 Поддержка](#-поддержать-проект)

---

</div>

## ✨ Особенности

<table>
<tr>
<td width="50%">

### 🎯 Доступность
- ✅ Патч `cPZSdc` — `is_country_supported` / `is_age_supported`
- ✅ RPC доступности `KV2T2d`, `rThb8d`, `cO7JOb`, `md9xJf`
- ✅ `availabilityState` → `AVAILABLE`
- ✅ Редирект `/unsupported-country` → `/`

</td>
<td width="50%">

### 🛠️ Технически
- ✅ Хуки `fetch` и `XMLHttpRequest` на `document-start`
- ✅ Closure-стрим `batchexecute` (`)]}'\n\n`)
- ✅ Блок NextAuth `api/auth/signout`
- ✅ Выключатель без удаления скрипта

</td>
</tr>
</table>

## 📋 Требования

| Компонент | Версия |
|---|---|
| Firefox | актуальная |
| Tampermonkey | любая (или Violentmonkey / Greasemonkey) |

## 🚀 Быстрый старт

### Вариант 1 — из GitHub (Raw)

1. Установите [Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/) и закрепите иконку на панели.
2. Откройте ссылку на скрипт:
   ```
   https://raw.githubusercontent.com/grashooper/flow-bridge-firefox/main/flow-bridge-firefox.user.js
   ```
3. Нажмите **«Установить»**.
4. Откройте [https://flow.google.com](https://flow.google.com) — заглушка должна исчезнуть.

### Вариант 2 — локально (без GitHub)

1. Скачайте `flow-bridge-firefox.user.js` из репозитория.
2. Tampermonkey → **Dashboard** → **Utilities** → **Install from file** (или перетащите файл в окно dashboard).
3. Нажмите **«Установить»**.
4. Откройте `https://flow.google.com`.

## ✅ Проверка установки

- Tampermonkey → Dashboard → **Installed scripts** → «Flow Bridge (Firefox)» v1.0.1 включён.
- На `flow.google.com` откройте консоль (F12 → Console) — должны быть строки:
  ```
  [Flow Bridge FF] fetch hooked
  [Flow Bridge FF] XHR hooked
  [Flow Bridge FF] ✅ patched cPZSdc (country=1, age=1)
  ```

## ⚙️ Использование

- Скрипт включён по умолчанию и работает только на `flow.google.com`.
- **Выключить** (без удаления) — в консоли на `flow.google.com`:
  ```js
  localStorage.setItem('flow_bridge_ff_off', '1');
  ```
- **Включить обратно**:
  ```js
  localStorage.removeItem('flow_bridge_ff_off');
  ```

## 🔍 Как это работает

1. На `document-start` ставятся обёртки на `fetch` и геттеры `responseText` / `response` у `XMLHttpRequest`.
2. Ответы `batchexecute` проходят через `patchGoogleStream`: парсится Closure-формат (префикс `)]}'\n\n`, чанки `длина\nJSON`) и патчатся поля доступности.
3. Ответы `fetchToolAvailability`, `checkAppAvailability`, `trpc/general.` проходят через `patchDeepJson`.
4. Запросы `api/auth/signout` блокируются — Google не разлогинивает при проверке доступности.
5. Открыт `/unsupported-country` — выполняется редирект на `/`.

## ❓ Диагностика

| Симптом | Что проверить |
|---|---|
| Нет сообщений `[Flow Bridge FF]` в консоли | Tampermonkey включён? Скрипт включён? Открыт именно `flow.google.com`? |
| Заглушка осталась | Очистите кэш сайта (Ctrl+Shift+Del), проверьте консоль на ошибки |
| Перестало работать после обновления Flow | Google изменил RPC — обновите `TARGET_RPCS` и `patchProtobufJson` |
| TM не ставит локальный файл | Разрешите доступ к файлам в `about:addons` или используйте Raw-ссылку |

## ⚠️ Ограничения

- Это **клиентская** модификация ответов: не связана с Google и не гарантирует работу при изменениях на стороне сервиса.
- Использование может нарушать условия использования Google — на ваш риск.
- Версия без телеметрии и подписанного kill switch (в отличие от Chrome-расширения).

## 📁 Структура репозитория

```
flow-bridge-firefox/
├── flow-bridge-firefox.user.js   # сам скрипт
├── scripts/release.js            # автоматизация релиза
├── README.md                     # эта инструкция
├── CHANGELOG.md                  # история изменений
├── LICENSE                       # MIT
└── .gitignore
```

## 🔄 Обновление

- Репозиторий: https://github.com/grashooper/flow-bridge-firefox
- Raw-ссылка для установки и обновления:
  ```
  https://raw.githubusercontent.com/grashooper/flow-bridge-firefox/main/flow-bridge-firefox.user.js
  ```
- После изменений поднимайте `@version` в метаданных и пушьте в `main` — Tampermonkey подхватит обновление через `@updateURL`.
- Для форков: замените `grashooper` в `@homepageURL`, `@supportURL`, `@updateURL`, `@downloadURL` и в README на свой GitHub-логин.

## 🚀 Релиз

```bash
node scripts/release.js patch   # 1.0.0 → 1.0.1
node scripts/release.js minor   # 1.0.1 → 1.1.0
node scripts/release.js major   # 1.1.0 → 2.0.0
node scripts/release.js 2.3.4   # явная версия
node scripts/release.js patch --dry-run   # только показать план
node scripts/release.js patch --no-push   # коммит и тег без пуша
```

Скрипт поднимает `@version`, версию в README и CHANGELOG, коммитит, ставит тег `vX.Y.Z`, пушит `main` и тег, затем создаёт GitHub Release с файлом `.user.js` (через `gh`). Требования: чистый рабочий каталог и авторизованный `gh`.

---

## 💖 Поддержать проект

Если проект оказался полезен, вы можете поддержать его развитие:

<div align="center">

### 💵 USDT (TRC20)

<img src="https://img.shields.io/badge/USDT-TRC20-26A17B?style=for-the-badge&logo=tether&logoColor=white" alt="USDT TRC20"/>

```
TCyZuUjX3ymFmrDPxTmeSNPMuuWRDtviFy
```

<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=TCyZuUjX3ymFmrDPxTmeSNPMuuWRDtviFy" alt="USDT QR Code" width="200"/>

---

*Спасибо за вашу поддержку! ❤️*

</div>

---

## 📄 Лицензия

[MIT](LICENSE)

Вопросы и баги: [GitHub Issues](https://github.com/grashooper/flow-bridge-firefox/issues)
