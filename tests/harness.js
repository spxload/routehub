// tests/harness.js — общая загрузка Worker'а для всех тестовых файлов.
// Worker импортирует routehub-admin.html (модуль типа Text, его подставляет
// Wrangler при сборке). Node такой импорт не понимает, поэтому тесты грузят
// копию исходника с заменённой строкой импорта. Остальной код не трогается.
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
const SHIM = SRC.replace(/^import ADMIN_HTML from .+$/m,
  "const ADMIN_HTML = '<!doctype html><title>test</title>';");
assert.notEqual(SHIM, SRC, 'строка импорта HTML не найдена — проверить шапку worker.js');
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
