// tests/harness.js — общая загрузка Worker'а для всех тестовых файлов.
// Worker импортирует файлы как модули Text (web/routehub-admin.html и
// манифест src/files.js — конфиг, скрипты, пробы, плагины); их подставляет
// Wrangler при сборке. Node такой импорт не понимает, поэтому до загрузки
// Worker'а регистрируется хук tests/text-loader.mjs: он отдаёт те же файлы
// строкой, как Wrangler. Тесты видят реальные тексты, код Worker'а грузится
// как есть, без копии с подменёнными импортами (так было до v1.12.0).
//
// Вынесено 2026-08-16 (v1.9.7): тесты разложены по файлам, чтобы правка
// одного набора не требовала перезаливки всего файла через GitHub API.

import fs from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const SRC = fs.readFileSync(path.join(ROOT, 'routehub-worker.js'), 'utf8');
register('./text-loader.mjs', import.meta.url);
const W = await import(pathToFileURL(path.join(ROOT, 'routehub-worker.js')).href);

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
