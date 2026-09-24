// Каждый скрипт устройства обязан разбираться как JavaScript.
// Причина — дефект dash v0.8.0: обратная кавычка в комментарии внутри
// HTML-шаблона закрыла шаблон, Loon отверг скрипт целиком («SyntaxError:
// Unexpected identifier 'up'»), rh.box перестал открываться. Прочие тесты
// dash не загружали, поэтому поломка дошла до устройства.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');

function jsFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith('.js'))
    .map((f) => dir + '/' + f);
}

const FILES = jsFiles('scripts').concat(jsFiles('probes'));

test('скриптов устройства найдено больше нуля', () => {
  assert.ok(FILES.length > 0);
  assert.ok(FILES.includes('scripts/routehub-dash.js'));
});

for (const f of FILES) {
  test('разбирается как JavaScript: ' + f, () => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    // Только разбор, без выполнения: Loon исполняет файл как обычный скрипт.
    assert.doesNotThrow(() => new vm.Script(src, { filename: f }));
  });
}
