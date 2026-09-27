// Сторож размера модулей Worker'а: routehub-worker.js и каждый src/**/*.js
// меньше 15 КБ.
//
// Зачем. Модуль правится и заливается по отдельности, а агент читает его
// целиком: файл больше 15 КБ съедает контекст и тянет правки соседних
// разделов в один коммит (правило — routehub-worker.js, шапка). Раскладка
// clients/stash.js и clients/stash-profile.js (21 КБ каждый) по смысловым
// модулям закрыла нарушение; без сторожа оно вернулось бы тихо — размер
// файла не виден ни в выдаче, ни в других тестах.
// Считаются БАЙТЫ (как `wc -c`), а не символы: комментарии по-русски в UTF-8
// занимают по два байта на букву.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const LIMIT = 15 * 1024;   // 15 360 байт

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('routehub-worker.js и каждый модуль src/**/*.js меньше 15 360 байт', () => {
  const files = jsFiles(path.join(ROOT, 'src'));
  // Пустой обход означал бы, что сторож ничего не сторожит.
  assert.ok(files.length > 10, 'в src/ не найдено модулей: ' + files.length);
  files.push(path.join(ROOT, 'routehub-worker.js'));   // точка входа — тоже модуль Worker'а
  const big = files
    .map((p) => ({ p: path.relative(ROOT, p).split(path.sep).join('/'), n: fs.statSync(p).size }))
    .filter((f) => f.n >= LIMIT)
    .map((f) => f.p + ' — ' + f.n + ' байт');
  assert.deepEqual(big, [], 'модули не меньше ' + LIMIT + ' байт (разложить по смыслу): ' + big.join('; '));
});
