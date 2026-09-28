// Сторож контекста для Read (`.claude/hooks/guard-read.js`).
//
// ЗАЧЕМ. 28.09 сессия умерла на файле в ~1,3 млн токенов; Read с offset/limit
// пропускает любой кусок. Если сторож перестанет срабатывать, следующий
// большой лог снова съест окно, и заметят это только по обрыву сессии. Тест
// гоняет скрипт как чёрный ящик: JSON в stdin, решение в stdout, код выхода.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..', '.claude', 'hooks', 'guard-read.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-read-'));

function file(name, text) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, text);
  return p;
}

// n строк по 60 байт латиницей (59 символов + перевод строки).
const lines = (n) => Array.from({ length: n }, (_, i) => String(i).padEnd(59, 'x')).join('\n') + '\n';

function run(toolInput, { raw, env = {} } = {}) {
  const input = raw !== undefined ? raw : JSON.stringify({
    session_id: 't', cwd: TMP, hook_event_name: 'PreToolUse',
    tool_name: 'Read', tool_input: toolInput, tool_use_id: 'toolu_t',
  });
  const r = spawnSync(process.execPath, [HOOK], {
    input, encoding: 'utf8', env: { ...process.env, RH_READ_MAX_TOKENS: '', ...env },
  });
  const out = r.stdout.trim();
  return { code: r.status, json: out ? JSON.parse(out) : null };
}

const denied = (r) => r.json && r.json.hookSpecificOutput.permissionDecision === 'deny';

test('малый файл — пропуск без вывода', () => {
  const r = run({ file_path: file('small.txt', lines(100)) });
  assert.equal(r.code, 0);
  assert.equal(r.json, null);
});

test('2000 строк по 60 байт (~42 тыс. токенов) без limit — запрет с оценкой', () => {
  const r = run({ file_path: file('big.txt', lines(5000)) });
  assert.equal(r.code, 0);
  assert.ok(denied(r));
  const why = r.json.hookSpecificOutput.permissionDecisionReason;
  assert.match(why, /Сторож контекста: кусок 2000 строк/);
  assert.match(why, /~42 тыс\. токенов/);
  assert.match(why, /limit ≈ 952 строк/);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
});

test('тот же файл, limit 500 (~10,5 тыс.) — пропуск', () => {
  const r = run({ file_path: path.join(TMP, 'big.txt'), offset: 100, limit: 500 });
  assert.equal(r.json, null);
});

test('граница порога: ровно порог — пропуск, на токен больше — запрет', () => {
  const p = file('edge.txt', lines(300)); // 300*60/3 + 300 = 6300
  assert.equal(run({ file_path: p }, { env: { RH_READ_MAX_TOKENS: '6300' } }).json, null);
  assert.ok(denied(run({ file_path: p }, { env: { RH_READ_MAX_TOKENS: '6299' } })));
});

test('offset за концом файла — пустой кусок, пропуск', () => {
  assert.equal(run({ file_path: path.join(TMP, 'big.txt'), offset: 9000 }).json, null);
});

test('кириллица считается по байтам UTF-8, а не по символам', () => {
  // 2000 строк по 30 букв кириллицы: 60 байт + \n = 61 байт на строку.
  const p = file('cyr.txt', Array.from({ length: 2000 }, () => 'щ'.repeat(30)).join('\n') + '\n');
  const r = run({ file_path: p });
  assert.ok(denied(r));
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /~43 тыс\. токенов/);
});

test('картинки и PDF не оцениваются', () => {
  const p = file('pic.png', lines(5000));
  assert.equal(run({ file_path: p }).json, null);
  assert.equal(run({ file_path: file('doc.PDF', lines(5000)) }).json, null);
});

test('нет файла, битый вход, нет пути — молча пропустить (код 0)', () => {
  assert.deepEqual(run({ file_path: path.join(TMP, 'nope.txt') }), { code: 0, json: null });
  assert.deepEqual(run({}, { raw: 'не json' }), { code: 0, json: null });
  assert.deepEqual(run({}), { code: 0, json: null });
});

test('--estimate без offset/limit оценивает весь файл', () => {
  const r = spawnSync(process.execPath, [HOOK, '--estimate', path.join(TMP, 'big.txt')], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  const e = JSON.parse(r.stdout);
  assert.equal(e.lines, 5000);
  assert.equal(e.fileLines, 5000);
  assert.equal(e.bytes, 300000);
  assert.equal(e.tokens, 105000);
});
