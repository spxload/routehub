// tests/text-loader.mjs — хук загрузки модулей Node для тестов. НЕ тест.
// Worker импортирует файлы как модули Text (правила [[rules]] в wrangler.toml):
// web/*.html, routehub.conf, scripts/*.js, probes/*.js, plugins/*.plugin,
// plugins/*.stoverride. Wrangler подставляет вместо них строку с содержимым
// файла; Node так не умеет. Хук повторяет это правило: файл репозитория,
// подпадающий под те же шаблоны, отдаётся модулем `export default "<текст>"`.
// Тесты тем самым видят РЕАЛЬНЫЕ тексты файлов, а не заглушки.
//
// Шаблоны ниже — те же, что globs в wrangler.toml (с префиксом **/).
// Разойдутся — tests/files-manifest.test.js это поймает.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEXT_GLOBS_RE = /(?:^|\/)(?:[^/]+\.html|scripts\/[^/]+\.js|probes\/[^/]+\.js|[^/]+\.plugin|[^/]+\.stoverride|[^/]+\.conf)$/;

function textRel(url) {
  if (!url.startsWith('file:')) return null;
  const rel = path.relative(ROOT, fileURLToPath(url)).split(path.sep).join('/');
  if (rel.startsWith('..') || rel.startsWith('tests/') || rel.startsWith('node_modules/')) return null;
  return TEXT_GLOBS_RE.test(rel) ? rel : null;
}

export async function load(url, context, nextLoad) {
  if (textRel(url)) {
    const text = await readFile(fileURLToPath(url), 'utf8');
    return { format: 'module', source: 'export default ' + JSON.stringify(text) + ';\n', shortCircuit: true };
  }
  return nextLoad(url, context);
}
