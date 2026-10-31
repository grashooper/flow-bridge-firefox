'use strict';

/**
 * Тесты Flow Bridge (Firefox): юзерскрипт исполняется в vm-песочнице с
 * заглушками window/XMLHttpRequest/localStorage, ответы Google эмулируются
 * независимо от браузера. Запуск: `npm test` (встроенный node:test).
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'flow-bridge-firefox.user.js');
const SRC = fs.readFileSync(SCRIPT_PATH, 'utf8');
const XSSI = ")]}'\n\n";

/* ----------------------------- песочница ----------------------------- */

function invalidStateError() {
    const err = new Error("Failed to read the 'responseText' property from 'XMLHttpRequest'.");
    err.name = 'InvalidStateError';
    return err;
}

function createSandbox(options = {}) {
    const logs = [];
    const store = Object.assign({}, options.storage || {});
    const session = options.session || {};
    const navigations = [];

    class FakeXHR {
        constructor() {
            this._text = '';
            this.responseType = '';
            this.readyState = 4;
        }
    }

    Object.defineProperty(FakeXHR.prototype, 'responseText', {
        configurable: true,
        enumerable: true,
        get() {
            // как в браузере: недоступно при чужом responseType и до загрузки
            if (this.responseType && this.responseType !== 'text') throw invalidStateError();
            if (this.readyState < 3) throw invalidStateError();
            return this._text;
        }
    });

    Object.defineProperty(FakeXHR.prototype, 'response', {
        configurable: true,
        enumerable: true,
        get() {
            if (this.responseType === 'json') return this._text ? JSON.parse(this._text) : null;
            if (this.responseType && this.responseType !== 'text') return null;
            if (this.readyState < 3) return '';
            return this._text;
        }
    });

    const sandbox = {
        console: {
            log: (...a) => logs.push(['log', a.join(' ')]),
            warn: (...a) => logs.push(['warn', a.join(' ')]),
            error: (...a) => logs.push(['error', a.join(' ')])
        },
        localStorage: {
            getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; }
        },
        sessionStorage: {
            getItem: (k) => (Object.prototype.hasOwnProperty.call(session, k) ? session[k] : null),
            setItem: (k, v) => { session[k] = String(v); },
            removeItem: (k) => { delete session[k]; }
        },
        location: {
            href: 'https://flow.google.com' + (options.pathname || '/'),
            pathname: options.pathname || '/',
            replace: (url) => { navigations.push(url); }
        },
        XMLHttpRequest: FakeXHR,
        fetch: options.fetch || (async () => new Response('')),
        Response,
        Headers,
        Request,
        URL,
        TextDecoder,
        TextEncoder,
        TransformStream,
        ReadableStream,
        WritableStream,
        JSON,
        Date,
        Math,
        Promise,
        RegExp,
        Error,
        TypeError,
        Object,
        Array,
        Number,
        String,
        Boolean,
        setTimeout,
        clearTimeout
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox, { filename: 'flow-bridge-firefox.user.js' });

    return { sandbox, logs, navigations, store, session, XHR: FakeXHR };
}

/* ------------------------- построение ответов ------------------------- */

function jsonText(payload) {
    return typeof payload === 'string' ? payload : JSON.stringify(payload);
}

/** Чанк по конвенции Google: len = длина payload + 1 (перевод строки входит). */
function chunk(payload) {
    const text = jsonText(payload);
    return String(text.length + 1) + '\n' + text;
}

/** Чанк по альтернативной конвенции: len = длина только payload. */
function chunkPlainLen(payload) {
    const text = jsonText(payload);
    return String(text.length) + '\n' + text;
}

function envelope(rpcid, payload) {
    return [['wrb.fr', rpcid, jsonText(payload), null, null, null, 'generic']];
}

function streamOf(...chunks) {
    return XSSI + chunks.join('');
}

/** Независимый разбор потока: проверяем, что после патча формат остался валидным. */
function parseStream(text, conv) {
    const prefix = /^\)\]\}'\r?\n*/.exec(text);
    let pos = prefix ? prefix[0].length : 0;
    const chunks = [];
    while (pos < text.length) {
        const seps = /^[\r\n]+/.exec(text.slice(pos));
        if (seps) {
            pos += seps[0].length;
            continue;
        }
        const nl = text.indexOf('\n', pos);
        assert.notEqual(nl, -1, 'ожидалась строка с длиной чанка');
        const lenText = text.slice(pos, nl);
        const len = Number(lenText);
        assert.ok(Number.isInteger(len) && len > 0, 'некорректная длина чанка: ' + JSON.stringify(lenText));
        const need = conv === 'plain' ? len : len - 1;
        chunks.push(JSON.parse(text.substr(nl + 1, need)));
        pos = nl + 1 + need;
    }
    return chunks;
}

function xhrRead(env, body, responseType) {
    const xhr = new env.XHR();
    xhr.responseType = responseType || '';
    xhr._text = body;
    return xhr.responseText;
}

/* ------------------------------ метаданные ------------------------------ */

test('метаданные userscript и согласованность версий', () => {
    const version = /^\/\/ @version\s+(\S+)/m.exec(SRC)[1];
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    assert.match(SRC, /^\/\/ @match\s+https:\/\/flow\.google\.com\/\*$/m);
    assert.match(SRC, /^\/\/ @run-at\s+document-start$/m);
    assert.match(SRC, /^\/\/ @grant\s+none$/m);
    assert.equal(version, pkg.version, '@version должен совпадать с package.json');

    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.ok(readme.includes(`version-${version}-`), 'бейдж версии в README отстал от @version');
    assert.ok(readme.includes(`» v${version} `), 'строка проверки установки в README отстала от @version');

    const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    assert.ok(changelog.includes(`## [${version}]`), 'в CHANGELOG нет записи для текущей версии');
});

/* --------------------------- разбор ответов --------------------------- */

test('cPZSdc: страна и возраст пропатчены, массив добит до 32', () => {
    const env = createSandbox();
    const body = streamOf(chunk(envelope('cPZSdc', [null, 'UA'])));
    const inner = JSON.parse(parseStream(xhrRead(env, body))[0][0][2]);

    assert.equal(inner.length, 32);
    assert.equal(inner[30], 1);
    assert.equal(inner[31], 1);
});

test('RPC доступности: первый элемент -> 1, остальные поля не тронуты', () => {
    for (const rpcid of ['KV2T2d', 'rThb8d', 'cO7JOb', 'md9xJf']) {
        const env = createSandbox();
        const body = streamOf(chunk(envelope(rpcid, [3, 'keep'])));
        const inner = JSON.parse(parseStream(xhrRead(env, body))[0][0][2]);

        assert.equal(inner[0], 1, rpcid);
        assert.equal(inner[1], 'keep', rpcid + ': остальные поля не должны меняться');
    }
});

test('несколько чанков: длины пересчитаны, посторонние чанки не изменены', () => {
    const env = createSandbox();
    const other = chunk(envelope('AbCdEf', [1, 2]));
    const body = streamOf(
        chunk(envelope('cPZSdc', [null])),
        chunk(envelope('KV2T2d', [3])),
        other
    );

    const out = xhrRead(env, body);
    const chunks = parseStream(out);

    assert.equal(chunks.length, 3);
    assert.equal(JSON.parse(chunks[0][0][2])[30], 1);
    assert.equal(JSON.parse(chunks[1][0][2])[0], 1);
    assert.ok(out.endsWith(other), 'посторонний чанк должен остаться байт-в-байт');
});

test('plain JSON батч (без чанков) патчится', () => {
    const env = createSandbox();
    const out = xhrRead(env, JSON.stringify(envelope('KV2T2d', [3])));

    const parsed = JSON.parse(out);
    assert.equal(JSON.parse(parsed[0][2])[0], 1);
});

test('префикс ")]}\'\\n" (один перевод строки) патчится', () => {
    const env = createSandbox();
    const body = ")]}'\n" + chunk(envelope('KV2T2d', [3]));
    const out = xhrRead(env, body);

    assert.equal(JSON.parse(parseStream(out)[0][0][2])[0], 1);
});

test('CRLF-префикс патчится и сохраняется как есть', () => {
    const env = createSandbox();
    const body = ")]}'\r\n\r\n" + chunk(envelope('KV2T2d', [3]));
    const out = xhrRead(env, body);

    assert.ok(out.startsWith(")]}'\r\n\r\n"));
    assert.equal(JSON.parse(parseStream(out)[0][0][2])[0], 1);
});

test('пустая строка между чанками не ломает парсинг', () => {
    const env = createSandbox();
    const body = streamOf(chunk(envelope('AbCdEf', [1])), '\n', chunk(envelope('KV2T2d', [3])));
    const out = xhrRead(env, body);

    assert.equal(JSON.parse(parseStream(out)[1][0][2])[0], 1);
});

test('поток без XSSI-префикса патчится', () => {
    const env = createSandbox();
    const body = chunk(envelope('KV2T2d', [3]));
    const out = xhrRead(env, body);

    assert.equal(JSON.parse(parseStream(out)[0][0][2])[0], 1);
});

test('альтернативная конвенция длины (len = payload) поддерживается', () => {
    const env = createSandbox();
    const body = XSSI + chunkPlainLen(envelope('KV2T2d', [3]));
    const out = xhrRead(env, body);

    assert.equal(JSON.parse(parseStream(out, 'plain')[0][0][2])[0], 1);
});

test('идемпотентность: уже пропатченный ответ не меняется', () => {
    const env = createSandbox();
    const already = new Array(32).fill(null);
    already[30] = 1;
    already[31] = 1;
    const body = streamOf(chunk(envelope('cPZSdc', already)), chunk(envelope('KV2T2d', [1])));

    assert.equal(xhrRead(env, body), body);
});

test('мусорный вход не бросает исключений и не портится', () => {
    const env = createSandbox();
    for (const bad of ['', 'cPZSdc broken', '{}', '123', ')JUNK', 'null']) {
        assert.equal(xhrRead(env, bad), bad);
    }
});

/* ----------------------------- XHR-хук ----------------------------- */

test('XHR: responseType=json -> нативный InvalidStateError', () => {
    const env = createSandbox();
    const body = streamOf(chunk(envelope('KV2T2d', [3])));

    assert.throws(() => xhrRead(env, body, 'json'), { name: 'InvalidStateError' });
});

test('XHR: чтение до готовности пробрасывает ошибку состояния', () => {
    const env = createSandbox();
    const xhr = new env.XHR();
    xhr.readyState = 1;
    xhr._text = streamOf(chunk(envelope('KV2T2d', [3])));

    assert.throws(() => xhr.responseText, { name: 'InvalidStateError' });
});

test('XHR: выключатель отключает патчинг', () => {
    const env = createSandbox({ storage: { flow_bridge_ff_off: '1' } });
    const body = streamOf(chunk(envelope('KV2T2d', [3])));

    assert.equal(xhrRead(env, body), body);
});

test('XHR: повторные чтения отдают одно и то же', () => {
    const env = createSandbox();
    const xhr = new env.XHR();
    xhr._text = streamOf(chunk(envelope('KV2T2d', [3])));

    assert.equal(xhr.response, xhr.responseText);
    assert.equal(xhr.responseText, xhr.responseText);
});

/* ----------------------------- fetch-хук ----------------------------- */

function slowStreamResponse(bodyText, delayMs) {
    const encoder = new TextEncoder();
    const cut = Math.min(20, bodyText.length);
    const stream = new ReadableStream({
        async start(controller) {
            controller.enqueue(encoder.encode(bodyText.slice(0, cut)));
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            controller.enqueue(encoder.encode(bodyText.slice(cut)));
            controller.close();
        }
    });
    return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '9999' }
    });
}

function brokenStreamResponse(bodyText) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(bodyText));
            controller.error(new Error('connection reset'));
        }
    });
    return new Response(stream, { status: 200 });
}

test('fetch: поток не буферизуется — первый байт приходит сразу', async () => {
    const body = streamOf(chunk(envelope('KV2T2d', [3])), chunk(envelope('cPZSdc', [null])));
    const env = createSandbox({ fetch: async () => slowStreamResponse(body, 200) });

    const startedAt = Date.now();
    const res = await env.sandbox.fetch('https://flow.google.com/_/BardChatUi/data/batchexecute?rpcids=KV2T2d');
    const reader = res.body.getReader();
    const first = await reader.read();
    const firstByteMs = Date.now() - startedAt;

    assert.ok(first.value && first.value.length > 0, 'первый кусок должен прийти сразу');
    assert.ok(firstByteMs < 150, `первый байт пришёл через ${firstByteMs} ms — ответ всё ещё буферизуется`);

    const parts = [Buffer.from(first.value)];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(Buffer.from(value));
    }

    const chunks = parseStream(Buffer.concat(parts).toString('utf8'));
    assert.equal(JSON.parse(chunks[0][0][2])[0], 1);
    assert.equal(JSON.parse(chunks[1][0][2])[30], 1);
});

test('fetch: тело из нескольких кусков всё равно патчится', async () => {
    const tail = [];
    for (let i = 0; i < 2000; i++) tail.push('x' + i);
    const body = streamOf(chunk(envelope('cPZSdc', [null])), chunk(envelope('KV2T2d', [3].concat(tail))));
    const env = createSandbox({ fetch: async () => new Response(body, { status: 200 }) });

    const res = await env.sandbox.fetch('https://flow.google.com/_/BardChatUi/data/batchexecute');
    const chunks = parseStream(await res.text());

    assert.equal(JSON.parse(chunks[0][0][2])[30], 1);
    assert.deepEqual(JSON.parse(chunks[1][0][2]), [1].concat(tail));
});

test('fetch: строка, URL-объект и Request определяются одинаково', async () => {
    const body = streamOf(chunk(envelope('KV2T2d', [3])));
    const target = 'https://flow.google.com/_/BardChatUi/data/batchexecute';

    for (const input of [target, new URL(target), new Request(target)]) {
        const env = createSandbox({ fetch: async () => new Response(body, { status: 200 }) });
        const res = await env.sandbox.fetch(input);
        const chunks = parseStream(await res.text());
        assert.equal(JSON.parse(chunks[0][0][2])[0], 1, 'не пропатчен вход: ' + String(input));
    }
});

test('fetch: служебные заголовки тела убраны, остальные сохранены', async () => {
    const body = streamOf(chunk(envelope('KV2T2d', [3])));
    const env = createSandbox({ fetch: async () => slowStreamResponse(body, 0) });
    const res = await env.sandbox.fetch('https://flow.google.com/_/BardChatUi/data/batchexecute');

    assert.equal(res.headers.get('content-encoding'), null);
    assert.equal(res.headers.get('content-length'), null);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
});

test('fetch: ошибка чтения тела batchexecute доходит до потребителя как есть', async () => {
    const env = createSandbox({ fetch: async () => brokenStreamResponse(XSSI) });
    const res = await env.sandbox.fetch('https://flow.google.com/_/BardChatUi/data/batchexecute');

    await assert.rejects(() => res.text(), /connection reset/);
});

test('fetch: ошибка чтения availability пробрасывается, без "Body is unusable"', async () => {
    const env = createSandbox({ fetch: async () => brokenStreamResponse('{"a":1}') });

    await assert.rejects(
        () => env.sandbox.fetch('https://flow.google.com/api/fetchToolAvailability'),
        (err) => err.message === 'connection reset'
    );
});

test('fetch: NextAuth signOut блокируется без обращения к сети', async () => {
    const env = createSandbox({
        fetch: async () => { throw new Error('network must not be called'); }
    });

    const res = await env.sandbox.fetch('https://flow.google.com/api/auth/signout', { method: 'POST' });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { url: 'https://flow.google.com/' });
});

test('fetch: availabilityState / isCountrySupported / isAgeSupported патчатся вглубь', async () => {
    const payload = {
        a: { availabilityState: 'UNAVAILABLE' },
        b: [{ isCountrySupported: false, isAgeSupported: false }],
        c: { nested: { availabilityState: 'OFF' } }
    };
    const env = createSandbox({
        fetch: async () => new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        })
    });

    const res = await env.sandbox.fetch('https://flow.google.com/api/fetchToolAvailability');

    assert.deepEqual(await res.json(), {
        a: { availabilityState: 'AVAILABLE' },
        b: [{ isCountrySupported: true, isAgeSupported: true }],
        c: { nested: { availabilityState: 'AVAILABLE' } }
    });
});

test('fetch: 204 и посторонние URL проходят без изменений', async () => {
    const noContent = createSandbox({ fetch: async () => new Response(null, { status: 204 }) });
    const resA = await noContent.sandbox.fetch('https://flow.google.com/_/BardChatUi/data/batchexecute');
    assert.equal(resA.status, 204);
    assert.equal(resA.body, null);

    const env = createSandbox({ fetch: async () => new Response('hello', { status: 200 }) });
    const resB = await env.sandbox.fetch('https://flow.google.com/other');
    assert.equal(await resB.text(), 'hello');
});

/* --------------------------- маршрут и редирект --------------------------- */

test('редирект с /unsupported-country и защита от цикла', () => {
    const session = {};

    const first = createSandbox({ pathname: '/unsupported-country', session });
    assert.deepEqual(first.navigations, ['https://flow.google.com/']);

    createSandbox({ pathname: '/unsupported-country', session });
    createSandbox({ pathname: '/unsupported-country', session });
    const fourth = createSandbox({ pathname: '/unsupported-country', session });

    assert.deepEqual(fourth.navigations, [], 'после трёх переходов редирект должен прекращаться');
    assert.ok(
        fourth.logs.some(([level, msg]) => level === 'warn' && msg.includes('redirect loop')),
        'должно быть предупреждение о цикле'
    );

    const normal = createSandbox({ pathname: '/' });
    assert.deepEqual(normal.navigations, []);
});

/* ------------------------------ release.js ------------------------------ */

function makeTempRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-bridge-release-'));
    for (const item of ['flow-bridge-firefox.user.js', 'README.md', 'CHANGELOG.md', 'package.json']) {
        fs.copyFileSync(path.join(ROOT, item), path.join(dir, item));
    }
    fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });

    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'flow-bridge-test');
    git('config', 'user.email', 'test@example.com');
    git('add', '-A');
    git('commit', '-q', '-m', 'initial');

    return { dir, git };
}

function runRelease(dir, args) {
    try {
        return { status: 0, stdout: execFileSync(process.execPath, ['scripts/release.js', ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }), stderr: '' };
    } catch (e) {
        return { status: e.status === undefined ? 1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
    }
}

function nextPatchVersion() {
    const [ma, mi, pa] = /^\/\/ @version\s+(\S+)/m.exec(SRC)[1].split('.').map(Number);
    return `${ma}.${mi}.${pa + 1}`;
}

test('release.js: --dry-run работает при грязном дереве и ничего не меняет', () => {
    const { dir, git } = makeTempRepo();
    fs.appendFileSync(path.join(dir, 'README.md'), '\nlocal change\n');

    const result = runRelease(dir, ['patch', '--dry-run']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Версия: \\S+ → ${nextPatchVersion().replace(/\./g, '\\.')}`));
    assert.equal(git('tag', '--list', 'v' + nextPatchVersion()).trim(), '');
});

test('release.js: релиз с ветки, отличной от main, запрещён', () => {
    const { dir, git } = makeTempRepo();
    git('switch', '-q', '-c', 'feature/x');

    const result = runRelease(dir, ['patch']);

    assert.notEqual(result.status, 0, 'скрипт должен отказаться');
    assert.match(result.stderr, /только из ветки main/);
    assert.doesNotMatch(result.stderr, /at Object\.|node:internal/, 'не должно быть дампа стека');
    assert.equal(git('tag', '--list', 'v' + nextPatchVersion()).trim(), '', 'тег создаваться не должен');
});

test('release.js: успешный выпуск обновляет версию, README, CHANGELOG и тег', () => {
    const { dir, git } = makeTempRepo();
    const next = nextPatchVersion();

    const result = runRelease(dir, ['patch', '--no-push']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(git('tag', '--list', `v${next}`).trim(), `v${next}`);

    const script = fs.readFileSync(path.join(dir, 'flow-bridge-firefox.user.js'), 'utf8');
    assert.match(script, new RegExp(`^// @version\\s+${next.replace(/\./g, '\\.')}$`, 'm'));

    const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    assert.ok(readme.includes(`version-${next}-`));
    assert.ok(readme.includes(`» v${next} `));

    const changelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
    assert.ok(changelog.includes(`## [${next}]`));
    assert.match(git('log', '-1', '--pretty=%s'), new RegExp(`Release v${next.replace(/\./g, '\\.')}`));
});





/* ------------------------- устойчивость к разбиению ------------------------- */

test('fetch: границы кусков в любом месте не ломают патч (включая UTF-8)', async () => {
    const body = streamOf(
        chunk(envelope('cPZSdc', [null, 'Київ 🎬'])),
        chunk(envelope('KV2T2d', [3, 'текст'])),
        chunk(envelope('AbCdEf', [7]))
    );
    const target = 'https://flow.google.com/_/BardChatUi/data/batchexecute';

    const ref = createSandbox({ fetch: async () => new Response(body, { status: 200 }) });
    const expected = await (await ref.sandbox.fetch(target)).text();
    assert.notEqual(expected, body, 'тестовые данные должны реально патчиться');

    for (const size of [1, 2, 3, 7, 64]) {
        const bytes = Buffer.from(body, 'utf8');
        const stream = new ReadableStream({
            start(controller) {
                for (let i = 0; i < bytes.length; i += size) {
                    controller.enqueue(new Uint8Array(bytes.subarray(i, i + size)));
                }
                controller.close();
            }
        });

        const env = createSandbox({ fetch: async () => new Response(stream, { status: 200 }) });
        const out = await (await env.sandbox.fetch(target)).text();
        assert.equal(out, expected, `кусок по ${size} байт`);
    }
});

test('fetch: бинарное тело не перекодируется и не портится', async () => {
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
    const env = createSandbox({
        fetch: async () => new Response(binary, { status: 200, headers: { 'content-type': 'image/png' } })
    });

    const res = await env.sandbox.fetch('https://flow.google.com/_/BardChatUi/data/batchexecute');
    const bytes = new Uint8Array(await res.arrayBuffer());

    assert.deepEqual(Array.from(bytes), Array.from(binary));
    assert.equal(res.headers.get('content-type'), 'image/png');
});

test('fetch: аргументы запроса передаются в нативный fetch без изменений', async () => {
    const calls = [];
    const body = streamOf(chunk(envelope('KV2T2d', [3])));
    const env = createSandbox({
        fetch: async (...args) => {
            calls.push(args);
            return new Response(body, { status: 200 });
        }
    });

    await env.sandbox.fetch('https://flow.google.com/_/BardChatUi/data/batchexecute', {
        method: 'POST',
        body: 'f.req=1'
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].method, 'POST');
    assert.equal(calls[0][1].body, 'f.req=1');
});
