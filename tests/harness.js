// tests/harness.js — общая загрузка Worker'а для всех тестовых файлов.
// Worker импортирует HTML-страницы (модули типа Text, их подставляет Wrangler
// при сборке). Node такой импорт не понимает, поэтому тесты грузят копию
// исходника с заменёнными строками импорта. Остальной код не трогается.
// Подстановка идёт по ЛЮБОМУ импорту из web/*.html, а не по конкретному имени:
// раньше здесь было зашито ADMIN_HTML, и добавление второй страницы уронило
// разом все двенадцать наборов тестов. Такие места в проекте уже подводили
// (список проб в probes-smoke), поэтому шаблон общий, а не поимённый.
// Копия кладётся В КОРЕНЬ репозитория, иначе не разрешаются относительные
// импорты модулей src/*.js.
//
// Вынесено 2026-08-16 (v1.9.7): тесты разложены по файлам, чтобы правка
// одного набора не требовала перезаливки всего файла через GitHub API.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
export const SRC = fs.readFileSync(path.join(ROOT, 'routehub-worker.js'), 'utf8');
const HTML_IMPORT = /^import ([A-Za-z_$][\w$]*) from '\.\/web\/[^']+\.html';\s*$/gm;
const SHIM = SRC.replace(HTML_IMPORT, "const $1 = '<!doctype html><title>test</title>';");
assert.notEqual(SHIM, SRC, 'строки импорта HTML не найдены — проверить шапку worker.js');
assert.equal((SRC.match(HTML_IMPORT) || []).length, (SRC.match(/\.html';\s*$/gm) || []).length,
  'какой-то импорт HTML не подошёл под шаблон — тесты грузили бы Worker не целиком');
const TMP = path.join(ROOT, '.rh-worker-under-test.mjs');
fs.writeFileSync(TMP, SHIM);
const W = await import(pathToFileURL(TMP).href);

export const T = W.__test;
export const worker = W.default;

export const DE = '\u{1F1E9}\u{1F1EA}', NL = '\u{1F1F3}\u{1F1F1}', US = '\u{1F1FA}\u{1F1F8}';
export const KZ = '\u{1F1F0}\u{1F1FF}', RUF = '\u{1F1F7}\u{1F1FA}', TR = '\u{1F1F9}\u{1F1F7}';
export const WIFI = '\u{1F6DC}';

export function req(url, opts) { return new Request(url, opts || {}); }
export function post(url, body, headers) {
  return new Request(url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(body),
  });
}
