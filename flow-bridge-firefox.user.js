// ==UserScript==
// @name         Flow Bridge (Firefox)
// @namespace    flow-bridge-firefox
// @version      1.0.2
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
    const TARGET_RPCS = ['cPZSdc', 'KV2T2d', 'rThb8d', 'cO7JOb', 'md9xJf'];

    function isOff() {
        try { return localStorage.getItem('flow_bridge_ff_off') === '1'; } catch (_) { return false; }
    }

    function patchProtobufJson(str, rpcid) {
        try {
            const inner = JSON.parse(str);
            if (!Array.isArray(inner)) return str;
            if (rpcid === 'cPZSdc') {
                while (inner.length < 32) inner.push(null);
                inner[30] = 1; // is_country_supported
                inner[31] = 1; // is_age_supported
                console.log(LOG, '✅ patched cPZSdc (country=1, age=1)');
            } else if (TARGET_RPCS.includes(rpcid)) {
                if (inner.length === 0) inner.push(1);
                else inner[0] = 1; // AVAILABLE
                console.log(LOG, '✅ patched', rpcid, '(status=1)');
            }
            return JSON.stringify(inner);
        } catch (_) {
            return str;
        }
    }

    function patchGoogleStream(raw) {
        if (!raw || typeof raw !== 'string') return raw;
        if (!TARGET_RPCS.some(function (id) { return raw.indexOf(id) !== -1; })) return raw;

        let ua = 0;
        let h = raw.indexOf(")]}'\n\n");
        if (h >= 0) ua = h + 6;
        else {
            h = raw.indexOf("\n\n");
            if (h >= 0) ua = h + 2;
        }
        const prefix = raw.slice(0, ua);
        const body = raw.slice(ua);

        try {
            const data = JSON.parse(body);
            if (Array.isArray(data)) {
                let modified = false;
                for (const item of data) {
                    if (Array.isArray(item) && TARGET_RPCS.includes(item[1]) && typeof item[2] === 'string') {
                        item[2] = patchProtobufJson(item[2], item[1]);
                        modified = true;
                    }
                }
                if (modified) return prefix + JSON.stringify(data);
            }
        } catch (_) { /* not a plain JSON batch */ }

        let out = prefix;
        let pos = ua;
        let anyModified = false;

        while (pos < raw.length) {
            const nextNl = raw.indexOf("\n", pos);
            if (nextNl === -1) { out += raw.slice(pos); break; }
            const lenStr = raw.substring(pos, nextNl);
            const len = Number(lenStr);
            if (!Number.isFinite(len) || len <= 0 || nextNl + len > raw.length) { out += raw.slice(pos); break; }

            const chunkWithNl = raw.substr(nextNl, len);
            const chunkJson = chunkWithNl.slice(1);
            try {
                const chunk = JSON.parse(chunkJson);
                let chunkModified = false;
                for (const item of chunk) {
                    if (Array.isArray(item) && TARGET_RPCS.includes(item[1]) && typeof item[2] === 'string') {
                        item[2] = patchProtobufJson(item[2], item[1]);
                        chunkModified = true;
                        anyModified = true;
                    }
                }
                if (chunkModified) {
                    const newChunkJson = JSON.stringify(chunk);
                    out += String(1 + newChunkJson.length) + '\n' + newChunkJson;
                } else {
                    out += lenStr + chunkWithNl;
                }
            } catch (err) {
                out += lenStr + chunkWithNl;
            }
            pos = nextNl + len;
        }
        return anyModified ? out : raw;
    }

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

    // Route recovery: /unsupported-country -> /
    if (location.pathname === '/unsupported-country' || location.pathname === '/unsupported-country/') {
        console.log(LOG, 'unsupported-country → redirect to /');
        try { location.replace('https://flow.google.com/'); } catch (_) {}
        return;
    }

    // XHR hook
    try {
        const XHR = window.XMLHttpRequest;
        const dText = Object.getOwnPropertyDescriptor(XHR.prototype, 'responseText');
        const dResp = Object.getOwnPropertyDescriptor(XHR.prototype, 'response');

        if (dText && dText.get) {
            Object.defineProperty(XHR.prototype, 'responseText', {
                configurable: true,
                get: function () {
                    if (this.responseType && this.responseType !== 'text') {
                        return dText.get.call(this);
                    }
                    try {
                        const raw = dText.get.call(this);
                        if (typeof raw !== 'string' || isOff()) return raw;
                        return patchGoogleStream(raw);
                    } catch (_) {
                        try { return dText.get.call(this); } catch (__) { return ''; }
                    }
                }
            });
        }
        if (dResp && dResp.get) {
            Object.defineProperty(XHR.prototype, 'response', {
                configurable: true,
                get: function () {
                    if (this.responseType && this.responseType !== 'text' && this.responseType !== '') {
                        return dResp.get.call(this);
                    }
                    try {
                        const raw = dResp.get.call(this);
                        if (typeof raw !== 'string' || isOff()) return raw;
                        return patchGoogleStream(raw);
                    } catch (_) {
                        try { return dResp.get.call(this); } catch (__) { return null; }
                    }
                }
            });
        }
        console.log(LOG, 'XHR hooked');
    } catch (e) {
        console.error(LOG, 'XHR hook failed', e);
    }

    // fetch hook
    try {
        const origFetch = window.fetch;
        window.fetch = async function (...args) {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');

            if (!isOff() && url.indexOf('api/auth/signout') !== -1) {
                console.warn(LOG, '🚫 prevented NextAuth signOut');
                return new Response(JSON.stringify({ url: location.href }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            const res = await origFetch.apply(this, args);
            if (isOff()) return res;

            if (url.indexOf('batchexecute') !== -1) {
                if (res.status === 204 || res.status === 205 || res.status === 304) return res;
                try {
                    const raw = await res.text();
                    const patched = patchGoogleStream(raw);
                    const headers = new Headers(res.headers);
                    headers.delete('content-length');
                    return new Response(patched, { status: res.status, statusText: res.statusText, headers: headers });
                } catch (_) {
                    return res;
                }
            }

            if (url.indexOf('fetchToolAvailability') !== -1 ||
                url.indexOf('checkAppAvailability') !== -1 ||
                url.indexOf('trpc/general.') !== -1) {
                if (res.status === 204 || res.status === 205 || res.status === 304) return res;
                try {
                    const text = await res.text();
                    const headers = new Headers(res.headers);
                    headers.delete('content-length');
                    try {
                        const data = JSON.parse(text);
                        patchDeepJson(data);
                        return new Response(JSON.stringify(data), { status: res.status, statusText: res.statusText, headers: headers });
                    } catch (_) {
                        return new Response(text, { status: res.status, statusText: res.statusText, headers: headers });
                    }
                } catch (_) {
                    return res;
                }
            }

            return res;
        };
        console.log(LOG, 'fetch hooked');
    } catch (e) {
        console.error(LOG, 'fetch hook failed', e);
    }

    console.log(LOG, 'installed at', location.href);
})();
