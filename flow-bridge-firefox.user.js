// ==UserScript==
// @name         Flow Bridge (Firefox)
// @namespace    flow-bridge-firefox
// @version      1.0.3
// @description  Flow availability unlocker for Firefox — port of the Flow Bridge Chrome extension logic
// @description:ru  Разблокировка Google Flow в Firefox (порт логики Flow Bridge для Chrome)
// @author       grashooper
// @license      MIT
// @homepageURL  https://github.com/grashooper/flow-bridge-firefox
// @supportURL   https://github.com/grashooper/flow-bridge-firefox/issues
// @updateURL    https://raw.githubusercontent.com/grashooper/flow-bridge-firefox/main/flow-bridge-firefox.user.js
// @downloadURL  https://raw.githubusercontent.com/grashooper/flow-bridge-firefox/main/flow-bridge-firefox.user.js
// @match        https://flow.google.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const LOG = '[Flow Bridge FF]';
    const RPC_CPZSDC = 'cPZSdc';
    const TARGET_RPCS = [RPC_CPZSDC, 'KV2T2d', 'rThb8d', 'cO7JOb', 'md9xJf'];

    const SIGN_OUT_MARKER = 'api/auth/signout';
    const AVAILABILITY_MARKERS = ['fetchToolAvailability', 'checkAppAvailability', 'trpc/general.'];
    const REDIRECT_KEY = 'flow_bridge_ff_redirect';
    const REDIRECT_LIMIT = 3;
    const REDIRECT_WINDOW_MS = 10000;

    function isOff() {
        try { return localStorage.getItem('flow_bridge_ff_off') === '1'; } catch (_) { return false; }
    }

    function tryParseJson(text) {
        try { return { ok: true, value: JSON.parse(text) }; } catch (_) { return { ok: false, value: undefined }; }
    }

    /* ---------------- патч protobuf-JSON внутри конверта ---------------- */

    // Возвращает исходную строку, если патчить нечего или payload не разобрался.
    function patchProtobufJson(str, rpcid) {
        const parsed = tryParseJson(str);
        if (!parsed.ok) return str;
        const inner = parsed.value;
        if (!Array.isArray(inner)) return str;

        if (rpcid === RPC_CPZSDC) {
            while (inner.length < 32) inner.push(null);
            if (inner[30] === 1 && inner[31] === 1) return str; // уже пропатчено
            inner[30] = 1; // is_country_supported
            inner[31] = 1; // is_age_supported
            console.log(LOG, '✅ patched cPZSdc (country=1, age=1)');
        } else {
            if (inner.length > 0 && inner[0] === 1) return str; // уже AVAILABLE
            if (inner.length === 0) inner.push(1);
            else inner[0] = 1; // AVAILABLE
            console.log(LOG, '✅ patched', rpcid, '(status=1)');
        }
        return JSON.stringify(inner);
    }

    // Патч набора конвертов: [["wrb.fr", <rpcid>, "<json>", ...], ...].
    // true — если что-то реально изменилось (значит, длину чанка нужно пересчитать).
    function patchEnvelopes(chunk) {
        if (!Array.isArray(chunk)) return false;
        let modified = false;
        for (const item of chunk) {
            if (!Array.isArray(item)) continue;
            if (!TARGET_RPCS.includes(item[1])) continue;
            if (typeof item[2] !== 'string') continue;
            const next = patchProtobufJson(item[2], item[1]);
            if (next !== item[2]) {
                item[2] = next;
                modified = true;
            }
        }
        return modified;
    }

    /* ---------------- потоковый парсер ответов batchexecute ----------------
     *
     * Формат: [")]}'" + переводы строк] и далее либо "<len>\n<json>" (сколько
     * угодно раз), либо один JSON целиком.
     *
     * Google пишет len как длину payload + 1 (учитывая перевод строки перед ним),
     * но встречаются шлюзы/клиенты, где len — длина только payload. Конвенция
     * определяется по первому успешно разобранному чанку и далее применяется ко
     * всему потоку, поэтому смена формата не превращает парсер в no-op.
     */

    const XSSI_RE = /^\)\]\}'\r?\n*/;
    const SEPARATORS_RE = /^[\r\n]+/;

    // Возвращает объект с feed(text, final) и isChanged().
    // feed можно вызывать многократно по мере поступления данных.
    function createPatcher() {
        let buf = '';
        let prefixDone = false;
        let mode = null; // 'chunked' — поток чанков, 'json' — один JSON
        let conv = null; // 'nl' — len включает "\n", 'plain' — len только payload
        let changed = false;

        function patchJsonBody(text) {
            const parsed = tryParseJson(text);
            if (!parsed.ok || !patchEnvelopes(parsed.value)) return text;
            changed = true;
            return JSON.stringify(parsed.value);
        }

        function feed(text, final) {
            buf += text;
            let out = '';

            for (;;) {
                if (!prefixDone) {
                    if (buf.length < 4 && !final) return out; // ждём префикс
                    const prefix = XSSI_RE.exec(buf);
                    if (prefix) {
                        out += prefix[0];
                        buf = buf.slice(prefix[0].length);
                    }
                    prefixDone = true;
                    continue;
                }

                if (mode !== 'json') {
                    const seps = SEPARATORS_RE.exec(buf); // пустые строки между чанками
                    if (seps) {
                        out += seps[0];
                        buf = buf.slice(seps[0].length);
                        continue;
                    }
                }

                if (buf.length === 0) return out;

                if (mode === null) mode = /^[0-9]/.test(buf) ? 'chunked' : 'json';

                if (mode === 'json') {
                    if (!final) return out; // нужен JSON целиком
                    out += patchJsonBody(buf);
                    buf = '';
                    return out;
                }

                const nl = buf.indexOf('\n');
                if (nl === -1) {
                    if (!final) return out; // ждём строку с длиной
                    out += buf;
                    buf = '';
                    return out;
                }

                const lenStr = buf.slice(0, nl);
                const rest = buf.slice(nl + 1);
                if (!/^\d+$/.test(lenStr)) { // не наш формат — отдаём как есть
                    out += buf;
                    buf = '';
                    return out;
                }

                const len = Number(lenStr);
                const order = conv === 'plain' ? ['plain', 'nl'] : ['nl', 'plain'];
                let consumed = false;

                for (const how of order) {
                    const need = how === 'nl' ? len - 1 : len;
                    if (need < 0 || rest.length < need) continue;
                    const payload = rest.slice(0, need);
                    const parsed = tryParseJson(payload);
                    if (!parsed.ok) continue;

                    conv = how;
                    let nextPayload = payload;
                    if (patchEnvelopes(parsed.value)) {
                        nextPayload = JSON.stringify(parsed.value);
                        changed = true;
                    }
                    const nextLen = how === 'nl' ? nextPayload.length + 1 : nextPayload.length;
                    out += String(nextLen) + '\n' + nextPayload;
                    buf = rest.slice(need);
                    consumed = true;
                    break;
                }
                if (consumed) continue;

                if (!final) return out; // ждём остаток чанка
                out += buf;
                buf = '';
                return out;
            }
        }

        return { feed: feed, isChanged: function () { return changed; } };
    }

    // Кэш на последний вход: responseText и response одного XHR читают одну строку.
    let cachedRaw = null;
    let cachedPatched = null;

    function patchGoogleStream(raw) {
        if (!raw || typeof raw !== 'string') return raw;
        if (!TARGET_RPCS.some(function (id) { return raw.indexOf(id) !== -1; })) return raw;
        if (raw === cachedRaw) return cachedPatched;

        const patcher = createPatcher();
        const out = patcher.feed(raw, true);
        cachedRaw = raw;
        cachedPatched = patcher.isChanged() ? out : raw;
        return cachedPatched;
    }

    /* ---------------- глубокий патч обычного JSON ---------------- */

    function patchDeepJson(data) {
        if (!data || typeof data !== 'object') return data;
        if (Array.isArray(data)) {
            for (let i = 0; i < data.length; i++) data[i] = patchDeepJson(data[i]);
            return data;
        }
        for (const k of Object.keys(data)) {
            if (k === 'availabilityState') {
                if (data[k] !== 'AVAILABLE') {
                    console.log(LOG, '✅ availabilityState:', data[k], '-> AVAILABLE');
                    data[k] = 'AVAILABLE';
                }
            } else if (k === 'isCountrySupported' || k === 'is_country_supported') {
                data[k] = true;
            } else if (k === 'isAgeSupported' || k === 'is_age_supported') {
                data[k] = true;
            } else if (typeof data[k] === 'object') {
                data[k] = patchDeepJson(data[k]);
            }
        }
        return data;
    }

    /* ---------------- восстановление маршрута ---------------- */

    function readRedirectState() {
        try {
            const raw = sessionStorage.getItem(REDIRECT_KEY);
            const state = raw ? JSON.parse(raw) : null;
            if (state && typeof state.hops === 'number' && typeof state.ts === 'number') return state;
        } catch (_) { /* sessionStorage недоступен */ }
        return { hops: 0, ts: 0 };
    }

    function writeRedirectState(state) {
        try { sessionStorage.setItem(REDIRECT_KEY, JSON.stringify(state)); } catch (_) {}
    }

    // /unsupported-country -> /, но без бесконечного цикла перезагрузок.
    if (location.pathname === '/unsupported-country' || location.pathname === '/unsupported-country/') {
        const state = readRedirectState();
        const stale = !state.ts || Date.now() - state.ts > REDIRECT_WINDOW_MS;
        const hops = stale ? 0 : state.hops;

        if (hops < REDIRECT_LIMIT) {
            writeRedirectState({ hops: hops + 1, ts: Date.now() });
            console.log(LOG, 'unsupported-country → redirect to / (hop', hops + 1, ')');
            try { location.replace('https://flow.google.com/'); } catch (_) {}
        } else {
            console.warn(LOG, '⚠️ redirect loop detected — /unsupported-country left as is');
        }
        return;
    }

    /* ---------------- XHR hook ---------------- */

    try {
        const XHR = window.XMLHttpRequest;
        const dText = Object.getOwnPropertyDescriptor(XHR.prototype, 'responseText');
        const dResp = Object.getOwnPropertyDescriptor(XHR.prototype, 'response');

        if (dText && dText.get) {
            Object.defineProperty(XHR.prototype, 'responseText', Object.assign({}, dText, {
                get: function () {
                    if (this.responseType && this.responseType !== 'text') {
                        return dText.get.call(this); // нативный InvalidStateError
                    }
                    const raw = dText.get.call(this); // ошибки состояния пробрасываем как есть
                    if (typeof raw !== 'string' || isOff()) return raw;
                    return patchGoogleStream(raw);
                }
            }));
        }

        if (dResp && dResp.get) {
            Object.defineProperty(XHR.prototype, 'response', Object.assign({}, dResp, {
                get: function () {
                    if (this.responseType && this.responseType !== 'text' && this.responseType !== '') {
                        return dResp.get.call(this);
                    }
                    const raw = dResp.get.call(this);
                    if (typeof raw !== 'string' || isOff()) return raw;
                    return patchGoogleStream(raw);
                }
            }));
        }

        console.log(LOG, 'XHR hooked');
    } catch (e) {
        console.error(LOG, 'XHR hook failed', e);
    }

    /* ---------------- fetch hook ---------------- */

    function urlOf(input) {
        try {
            if (typeof input === 'string') return input;
            if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
            if (input && typeof input.url === 'string') return input.url; // Request
            if (input && typeof input.href === 'string') return input.href;
            return String(input);
        } catch (_) {
            return '';
        }
    }

    function hasNoBody(res) {
        return res.status === 204 || res.status === 205 || res.status === 304 || !res.body;
    }

    // Текстовые ответы можно декодировать/перекодировать, бинарные — нельзя.
    function isTextual(res) {
        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        if (!contentType) return true; // тип не указан — считаем текстом
        return /json|text|javascript|xml/.test(contentType);
    }

    function copyHeaders(res) {
        const headers = new Headers(res.headers);
        headers.delete('content-length');   // длина пересчитывается
        headers.delete('content-encoding'); // тело дальше идёт уже разжатым
        return headers;
    }

    // Патчим по мере поступления чанков: не буферизуем ответ целиком и не ломаем
    // стриминг длинных batchexecute-ответов (первый байт уходит сразу).
    function patchResponseStream(res) {
        const decoder = new TextDecoder('utf-8');
        const encoder = new TextEncoder();
        const patcher = createPatcher();

        const stream = res.body.pipeThrough(new TransformStream({
            transform: function (chunk, controller) {
                const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
                const out = patcher.feed(text, false);
                if (out) controller.enqueue(encoder.encode(out));
            },
            flush: function (controller) {
                const out = patcher.feed(decoder.decode(), true);
                if (out) controller.enqueue(encoder.encode(out));
            }
        }));

        return new Response(stream, {
            status: res.status,
            statusText: res.statusText,
            headers: copyHeaders(res)
        });
    }

    try {
        const origFetch = window.fetch;

        window.fetch = async function (...args) {
            const url = urlOf(args[0]);

            if (!isOff() && url.indexOf(SIGN_OUT_MARKER) !== -1) {
                console.warn(LOG, '🚫 prevented NextAuth signOut');
                return new Response(JSON.stringify({ url: location.href }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            const res = await origFetch.apply(this, args);
            if (isOff() || hasNoBody(res) || !isTextual(res)) return res;

            if (url.indexOf('batchexecute') !== -1) {
                try {
                    return patchResponseStream(res);
                } catch (e) {
                    // тело ещё не тронуто — отдаём оригинал
                    console.error(LOG, 'batch stream patch failed', e);
                    return res;
                }
            }

            const isAvailability = AVAILABILITY_MARKERS.some(function (m) {
                return url.indexOf(m) !== -1;
            });

            if (isAvailability) {
                // Ошибка чтения пробрасывается вызывающему коду как в нативном fetch:
                // «сожжённый» Response отдавать нельзя.
                const text = await res.text();
                const headers = copyHeaders(res);
                const parsed = tryParseJson(text);
                if (!parsed.ok) {
                    return new Response(text, { status: res.status, statusText: res.statusText, headers: headers });
                }
                patchDeepJson(parsed.value);
                return new Response(JSON.stringify(parsed.value), {
                    status: res.status,
                    statusText: res.statusText,
                    headers: headers
                });
            }

            return res;
        };

        console.log(LOG, 'fetch hooked');
    } catch (e) {
        console.error(LOG, 'fetch hook failed', e);
    }

    console.log(LOG, 'installed at', location.href);
})();
