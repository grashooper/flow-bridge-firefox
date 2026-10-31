#!/usr/bin/env node
'use strict';

/**
 * Автоматизация релиза Flow Bridge (Firefox).
 *
 *   node scripts/release.js patch        # 1.0.0 -> 1.0.1
 *   node scripts/release.js minor        # 1.0.0 -> 1.1.0
 *   node scripts/release.js major        # 1.0.0 -> 2.0.0
 *   node scripts/release.js 2.3.4        # явная версия
 *   node scripts/release.js patch --dry-run   # показать план без изменений
 *   node scripts/release.js patch --no-push   # только коммит и тег
 *
 * Что делает:
 *  1. Поднимает @version в userscript.
 *  2. Обновляет версию в README (бейдж и строку проверки).
 *  3. Добавляет запись в CHANGELOG (по коммитам с прошлого тега).
 *  4. Коммитит, ставит тег vX.Y.Z, пушит main и тег.
 *  5. Создаёт GitHub Release с файлом .user.js (через gh).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'flow-bridge-firefox.user.js');
const README = path.join(ROOT, 'README.md');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');
const TAG_PREFIX = 'v';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');
const noPush = flags.has('--no-push');
const spec = positional[0] || 'patch';

function run(cmd, args) {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
}
const git = (...args) => run('git', args);
const gh = (...args) => run('gh', args);

const MAIN_BRANCH = 'main';

function detail(e) {
    return String((e && (e.stderr || e.message)) || e).trim();
}

/** Понятное сообщение + опциональная подсказка вместо дампа стека. */
function fatal(message, hint) {
    console.error(message);
    if (hint) console.error(hint);
    process.exit(1);
}

/** git-обёртка: при ошибке печатает stderr git, а не объект Error целиком. */
function gitChecked(...args) {
    try {
        return git(...args);
    } catch (e) {
        fatal(`git ${args.join(' ')} — ошибка:\n${detail(e)}`);
    }
}

function currentBranch() {
    try {
        return git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    } catch (e) {
        fatal('Не удалось определить текущую ветку:\n' + detail(e));
    }
}

function readVersion() {
    const m = fs.readFileSync(SCRIPT, 'utf8').match(/^\/\/ @version\s+(\S+)/m);
    if (!m) fatal('Не найден @version в userscript');
    return m[1];
}

function parse(v) {
    const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!m) fatal(`Некорректная версия: ${v}`, 'Ожидается формат X.Y.Z, например 1.2.3');
    return m.slice(1).map(Number);
}
const fmt = (a) => a.join('.');

function bump(v, type) {
    const [ma, mi, pa] = parse(v);
    if (type === 'major') return fmt([ma + 1, 0, 0]);
    if (type === 'minor') return fmt([ma, mi + 1, 0]);
    return fmt([ma, mi, pa + 1]);
}

function gt(a, b) {
    const x = parse(a);
    const y = parse(b);
    for (let i = 0; i < 3; i++) {
        if (x[i] !== y[i]) return x[i] > y[i];
    }
    return false;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const current = readVersion();
let next;
if (['patch', 'minor', 'major'].includes(spec)) next = bump(current, spec);
else if (/^\d+\.\d+\.\d+$/.test(spec)) next = spec;
else {
    console.error('Использование: node scripts/release.js [patch|minor|major|X.Y.Z] [--dry-run] [--no-push]');
    process.exit(1);
}
if (!gt(next, current)) {
    console.error(`Новая версия ${next} должна быть больше текущей ${current}`);
    process.exit(1);
}

try { git('fetch', '--tags', '--quiet'); } catch (_) { /* offline */ }
if (git('tag', '--list', `${TAG_PREFIX}${next}`).trim()) {
    fatal(`Тег ${TAG_PREFIX}${next} уже существует`, 'Выберите другую версию: node scripts/release.js <X.Y.Z>');
}

let notes = '';
try {
    if (git('tag', '--list', `${TAG_PREFIX}${current}`).trim()) {
        notes = git('log', '--no-merges', '--pretty=format:- %s', `${TAG_PREFIX}${current}..HEAD`).trim();
    }
} catch (_) { /* ignore */ }
if (!notes) notes = `- Релиз ${next}.`;

console.log(`Версия: ${current} → ${next}`);
if (dryRun) {
    console.log('--- CHANGELOG (preview) ---');
    console.log(`## [${next}] — ${new Date().toISOString().slice(0, 10)}\n\n### Изменено\n\n${notes}`);
    console.log('--- Dry-run: файлы не изменены, коммит/тег/пуш не выполнялись. ---');
    process.exit(0);
}

// Релиз только из основной ветки: иначе тег уедет на коммит, которого нет в main.
const branch = currentBranch();
if (branch !== MAIN_BRANCH) {
    fatal(
        `Релиз возможен только из ветки ${MAIN_BRANCH} (текущая: ${branch}).`,
        `Переключитесь: git switch ${MAIN_BRANCH}`
    );
}

const dirty = git('status', '--porcelain').trim();
if (dirty) {
    fatal('Рабочее дерево не чистое — закоммитьте изменения перед релизом:\n' + dirty);
}

let src = fs.readFileSync(SCRIPT, 'utf8');
src = src.replace(/^\/\/ @version\s+\S+/m, `// @version      ${next}`);
fs.writeFileSync(SCRIPT, src);

let readme = fs.readFileSync(README, 'utf8');
readme = readme.replace(new RegExp(`version-${esc(current)}-`, 'g'), `version-${next}-`);
readme = readme.replace(new RegExp(`» v${esc(current)} `, 'g'), `» v${next} `);
fs.writeFileSync(README, readme);

const date = new Date().toISOString().slice(0, 10);
const entry = `## [${next}] — ${date}\n\n### Изменено\n\n${notes}\n\n`;
let changelog = fs.readFileSync(CHANGELOG, 'utf8');
const idx = changelog.indexOf('## [');
changelog = idx >= 0
    ? changelog.slice(0, idx) + entry + changelog.slice(idx)
    : changelog.trimEnd() + '\n\n' + entry;
fs.writeFileSync(CHANGELOG, changelog);

gitChecked('add', 'flow-bridge-firefox.user.js', 'README.md', 'CHANGELOG.md');
gitChecked('commit', '-m', `Release ${TAG_PREFIX}${next}`);
gitChecked('tag', `${TAG_PREFIX}${next}`);
console.log(`Коммит и тег ${TAG_PREFIX}${next} созданы.`);

if (noPush) {
    console.log('--no-push: пуш и GitHub Release пропущены.');
    process.exit(0);
}

try {
    git('push', 'origin', branch);
    git('push', 'origin', `${TAG_PREFIX}${next}`);
} catch (e) {
    fatal(
        `Пуш не выполнен:\n${detail(e)}`,
        [
            'Локально коммит и тег уже созданы. Дальше — на выбор:',
            `  1) устранить причину и повторить: git push origin ${branch} && git push origin ${TAG_PREFIX}${next}`,
            `  2) откатить релиз: git tag -d ${TAG_PREFIX}${next} && git reset --hard HEAD~1`
        ].join('\n')
    );
}

const notesFile = path.join(ROOT, `.release-notes-${next}.md`);
const releaseNotes = [
    `## Flow Bridge (Firefox) ${next}`,
    '',
    notes,
    '',
    '### 📥 Установка',
    '',
    '1. Установите [Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/).',
    '2. Откройте: `https://raw.githubusercontent.com/grashooper/flow-bridge-firefox/main/flow-bridge-firefox.user.js`',
    '3. Установите и откройте https://flow.google.com.',
    '',
    'Полная инструкция — в [README](https://github.com/grashooper/flow-bridge-firefox#-быстрый-старт).',
    ''
].join('\n');
fs.writeFileSync(notesFile, releaseNotes);

try {
    gh(
        'release', 'create', `${TAG_PREFIX}${next}`, 'flow-bridge-firefox.user.js',
        '--title', `${TAG_PREFIX}${next} — Flow Bridge (Firefox)`,
        '--notes-file', notesFile
    );
    console.log(`Релиз создан: https://github.com/grashooper/flow-bridge-firefox/releases/tag/${TAG_PREFIX}${next}`);
} catch (e) {
    console.warn('Не удалось создать GitHub Release (gh не авторизован?):', e.message);
    console.warn('Коммит и тег уже запушены — релиз можно создать вручную.');
} finally {
    if (fs.existsSync(notesFile)) fs.unlinkSync(notesFile);
}
