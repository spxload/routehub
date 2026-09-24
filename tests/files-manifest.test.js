// Сторож манифеста встроенных файлов src/files.js (T-private-repo; в main —
// v1.12.0, в ветке stash-client — перенос, Worker v1.11.0).
//
// Устройство получает конфиг, скрипты, пробы и плагины только из сборки
// Worker'а. Файл, забытый в манифесте, после перевода репозитория в приватный
// режим устройству недоступен вовсе — поэтому забытый файл роняет тест.
// Сверка байт в байт ловит импорт не того файла под чужим ключом.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, T } from './harness.js';
import { TEXT_GLOBS_RE } from './text-loader.mjs';

const { FILES } = await import('../src/files.js');

function list(dir, re) {
  return fs.readdirSync(path.join(ROOT, dir)).filter((f) => re.test(f)).map((f) => dir + '/' + f);
}

const ON_DISK = ['routehub.conf']
  .concat(list('scripts', /\.js$/))
  .concat(list('probes', /\.js$/))
  .concat(list('plugins', /\.(plugin|stoverride)$/))
  .sort();

test('манифест: каждый файл scripts/*.js, probes/*.js, plugins/*.plugin|*.stoverride и routehub.conf встроен', () => {
  // В ветке stash-client 40 таких файлов (24.09): пробы и override стенда.
  assert.ok(ON_DISK.length >= 35, 'подозрительно мало файлов на диске: ' + ON_DISK.length);
  const missing = ON_DISK.filter((p) => !Object.prototype.hasOwnProperty.call(FILES, p));
  assert.deepEqual(missing, [], 'не встроены в src/files.js: ' + missing.join(', '));
});

test('манифест: нет лишних ключей — только файлы с диска из белого списка', () => {
  const extra = Object.keys(FILES).filter((p) => ON_DISK.indexOf(p) < 0);
  assert.deepEqual(extra, [], 'в манифесте то, чего нет на диске или вне белого списка: ' + extra.join(', '));
});

test('манифест: текст каждого файла совпадает с диском байт в байт', () => {
  for (const p of Object.keys(FILES)) {
    assert.equal(typeof FILES[p], 'string', p);
    const disk = fs.readFileSync(path.join(ROOT, p));
    assert.ok(Buffer.from(FILES[p], 'utf8').equals(disk), p + ': текст в манифесте не совпал с файлом');
  }
});

test('манифест: каждый ключ проходит белый список прокси', () => {
  for (const p of Object.keys(FILES)) {
    assert.ok(T.REPO_RAW_RE.test('/t/' + 'a'.repeat(32) + '/repo/' + p), p);
  }
});

test('манифест: каждый импорт src/files.js попал в FILES под своим путём', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/files.js'), 'utf8');
  const imp = {};
  for (const m of src.matchAll(/^import (\w+) from '\.\.\/([^']+)';$/gm)) imp[m[1]] = m[2];
  const ent = {};
  for (const m of src.matchAll(/^ {2}'([^']+)': (\w+),$/gm)) ent[m[1]] = m[2];
  assert.equal(Object.keys(imp).length, Object.keys(FILES).length, 'число импортов и ключей разошлось');
  for (const p in ent) assert.equal(imp[ent[p]], p, 'ключ ' + p + ' указывает на импорт ' + imp[ent[p]]);
});

// Правило Text в wrangler.toml и хук тестов обязаны покрывать одно и то же;
// иначе в Node тест зелёный, а сборка Wrangler падает или вбирает файл как JS.
test('wrangler.toml: правила Text боевого и стенда одинаковы и покрывают манифест', () => {
  const toml = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
  const blocks = [...toml.matchAll(/^\[\[(rules|env\.stash\.rules)\]\]\n((?:[^[\n].*\n)+)/gm)];
  assert.equal(blocks.length, 2, 'ожидались [[rules]] и [[env.stash.rules]]');
  const globs = blocks.map((b) => {
    assert.match(b[2], /^type = "Text"$/m);
    assert.match(b[2], /^fallthrough = true$/m);
    return JSON.parse(b[2].match(/^globs = (\[.*\])$/m)[1]);
  });
  assert.deepEqual(globs[0], globs[1], 'globs боевого и стенда разошлись');
  const toRe = (g) => new RegExp('(?:^|/)' + g.replace(/^\*\*\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
  const res = globs[0].map((g) => { assert.match(g, /^\*\*\//, 'без префикса **/ правило не срабатывает: ' + g); return toRe(g); });
  for (const p of Object.keys(FILES).concat(['web/routehub-admin.html'])) {
    assert.ok(res.some((re) => re.test(p)), p + ' не подпадает ни под одно правило Text');
    assert.ok(TEXT_GLOBS_RE.test(p), p + ' не подпадает под хук tests/text-loader.mjs');
  }
  // Исходники Worker'а под правило Text не подпадают — иначе сборка сломается.
  for (const p of ['routehub-worker.js', 'src/api.js', 'src/api/config.js', 'src/repo.js', 'src/files.js',
    'src/clients/loon.js', 'src/clients/stash.js', 'src/admin/state.js', 'tools/build-inline-override.mjs']) {
    assert.ok(!res.some((re) => re.test(p)), p + ' подпал под правило Text');
    assert.ok(!TEXT_GLOBS_RE.test(p), p + ' подпал под хук тестов');
  }
});

// Override стенда ссылаются на ветки main И stash-client — обе переписываются.
test('ссылки на spxload/routehub в конфиге и плагинах ведут только на встроенные файлы', () => {
  const re = /https:\/\/(?:raw\.githubusercontent\.com\/spxload\/routehub\/(?:main|stash-client)|cdn\.jsdelivr\.net\/gh\/spxload\/routehub@(?:main|stash-client))\/([\w./-]+)/g;
  const bad = [];
  for (const p of Object.keys(FILES)) {
    for (const m of FILES[p].matchAll(re)) if (!Object.prototype.hasOwnProperty.call(FILES, m[1])) bad.push(p + ' -> ' + m[1]);
  }
  assert.deepEqual(bad, [], 'ссылки, которые прокси не перепишет: ' + bad.join('; '));
});

// Предпосылка переписчика: в файлах ветки действительно есть ссылки с обоими
// ref. Пропадут ссылки на stash-client — тест выше станет пустым и зелёным.
test('в файлах ветки есть прямые ссылки и на main, и на stash-client', () => {
  const all = Object.keys(FILES).map((p) => FILES[p]).join('\n');
  assert.match(all, /https:\/\/raw\.githubusercontent\.com\/spxload\/routehub\/stash-client\/probes\//);
  assert.match(all, /https:\/\/raw\.githubusercontent\.com\/spxload\/routehub\/main\//);
  assert.match(all, /https:\/\/cdn\.jsdelivr\.net\/gh\/spxload\/routehub@main\//);
});
