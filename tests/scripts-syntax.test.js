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

// Разбор не ловит подстановку: «${…}» внутри шаблона — валидный JS, но
// тихо меняет страницу. HTML дашборда — чистый текст (инвариант в шапке
// шаблона), поэтому в его теле нет ни обратных кавычек, ни «${».
test('HTML-шаблон dash — чистый текст: нет «`» и «${» внутри', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/routehub-dash.js'), 'utf8');
  const open = src.indexOf('var HTML = `');
  assert.ok(open >= 0, 'шаблон var HTML не найден');
  const bodyStart = open + 'var HTML = `'.length;
  const close = src.indexOf('`;', bodyStart);
  assert.ok(close > bodyStart, 'конец шаблона не найден');
  const body = src.slice(bodyStart, close);
  assert.ok(body.includes('</html>'), 'шаблон закрылся раньше </html>');
  assert.equal(body.indexOf('${'), -1, 'подстановка ${ внутри шаблона');
});
