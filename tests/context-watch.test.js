// Монитор контекста (`.claude/hooks/context-watch.js`).
//
// ЗАЧЕМ. Хук — единственное, что сообщает модели, сколько контекста занято:
// сама она этого не видит. Если ступени сдвинутся, предупреждение придёт
// после автосжатия и детали сессии пропадут; если сломается память ступени —
// одно и то же предупреждение будет на каждом вызове инструмента; если
// пропадёт или соврёт строка остатка — модель не сможет планировать задачу
// по объёму; если хук упадёт — сессия получит ошибку хука на каждом запросе.
// Тест гоняет скрипт как чёрный ящик, как его запускает Claude Code: JSON в
// stdin, ответ в stdout, код выхода.
//
// Формат входа и выхода — https://code.claude.com/docs/en/hooks
// (`transcript_path`, `session_id`, `source`, `trigger`,
// `hookSpecificOutput.additionalContext`); объём — формула `used_percentage`
// https://code.claude.com/docs/en/statusline#context-window-fields.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..', '.claude', 'hooks', 'context-watch.js');
const SETTINGS = path.join(HERE, '..', '.claude', 'settings.json');
const CTX_VARS = ['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'CLAUDE_PROJECT_DIR'];
// Окно 1 000 000 без PCT: точка автосжатия ровно 1 000 000, 1 % = 10 000 токенов.
const W1M = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' };
// Окно 100 000: 5 % = 5 000 < резерва 25 000 на передачу дел.
const W100K = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000' };

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-watch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Запись ответа ассистента в формате транскрипта Claude Code.
function asst(input, cacheRead = 0, cacheCreate = 0, extra = {}) {
  return {
    type: 'assistant',
    isSidechain: false,
    message: {
      id: 'msg_x',
      model: 'claude-opus-5-5',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
        output_tokens: 777777, // выход в объём контекста не входит
      },
    },
    ...extra,
  };
}
const user = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const boundary = (post) => ({ type: 'system', subtype: 'compact_boundary',
  compactMetadata: { trigger: 'auto', preTokens: 790000, postTokens: post } });

function transcript(dir, records, name = 't.jsonl') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  return file;
}

// HOME и cwd — в песочнице: настройки пользователя не влияют на тест.
function run(dir, input, env = {}) {
  const base = { ...process.env };
  for (const v of CTX_VARS) delete base[v];
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  const r = spawnSync(process.execPath, [HOOK], {
    input: raw,
    encoding: 'utf8',
    env: { ...base, TMPDIR: dir, HOME: dir, ...env },
  });
  const out = r.stdout.trim();
  return { code: r.status, out, err: r.stderr, json: out ? JSON.parse(out) : null };
}

function prompt(dir, file, env, extra = {}) {
  return run(dir, { session_id: 's1', transcript_path: file, cwd: dir,
    hook_event_name: 'UserPromptSubmit', prompt: 'дальше', ...extra }, env);
}

function tool(dir, file, env) {
  return run(dir, { session_id: 's1', transcript_path: file, cwd: dir, hook_event_name: 'PostToolUse',
    tool_name: 'Bash', tool_input: {}, tool_response: {} }, env);
}

function ctx(res) {
  return res.json ? res.json.hookSpecificOutput.additionalContext : '';
}

function stepOf(res) {
  const m = ctx(res).match(/ступень (\d) из 3/g);
  if (!m) return 0;
  assert.equal(m.length, 1, 'за один вызов — не больше одного сообщения о ступени');
  return Number(m[0].match(/\d/)[0]);
}

// Строка остатка: [процент, тыс. токенов] или null.
function remainOf(res) {
  const m = ctx(res).match(/^Контекст: (\d+) % до точки сжатия, осталось ~(\d+) тыс\. токенов\.$/m);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function silent(res) {
  assert.equal(res.code, 0, 'код выхода 0');
  assert.equal(res.out, '', 'stdout пуст');
  assert.equal(res.err, '', 'stderr пуст');
}

// Одна свежая песочница на замер: ступень определяется «с нуля».
// Ступень берётся по PostToolUse — там нет строки остатка и базы не мешают.
function stepFor(t, used, env = W1M) {
  const dir = sandbox(t);
  const res = tool(dir, transcript(dir, [user('q'), asst(used)]), env);
  assert.equal(res.code, 0);
  return stepOf(res);
}

test('границы ступеней 80/90/95 % пути до автосжатия', (t) => {
  assert.equal(stepFor(t, 799999), 0);
  assert.equal(stepFor(t, 800000), 1);
  assert.equal(stepFor(t, 899999), 1);
  assert.equal(stepFor(t, 900000), 2);
  assert.equal(stepFor(t, 949999), 2);
  assert.equal(stepFor(t, 950000), 3);
  assert.equal(stepFor(t, 990000), 3);
});

test('тексты ступеней: планируй конец / завершай / критично; фразы для Дианы', (t) => {
  const d1 = sandbox(t);
  assert.match(ctx(tool(d1, transcript(d1, [asst(810000)]), W1M)), /планируй конец/);
  const d2 = sandbox(t);
  assert.match(ctx(tool(d2, transcript(d2, [asst(910000)]), W1M)), /завершай/);
  const d3 = sandbox(t);
  const r3 = tool(d3, transcript(d3, [asst(960000)]), W1M);
  assert.match(ctx(r3), /критично: передача дел сейчас/);
  assert.match(ctx(r3), /Контекст подходит к концу — запускаю передачу дел \(handoff\)/);
  assert.match(ctx(r3), /Откройте новую сессию Code с репозиторием routehub и напишите: Продолжи по studio\/handoff\/<файл>/);
  assert.match(r3.json.systemMessage, /Контекст подходит к концу/);
});

test('малое окно: ступень 3 сдвигается, чтобы остаток вмещал передачу дел (25 тыс.)', (t) => {
  // Точка 100 000: 95 % оставили бы 5 000 — мало; ступени сходятся к 75 %.
  assert.equal(stepFor(t, 74999, W100K), 0);
  assert.equal(stepFor(t, 75000, W100K), 3);
  // Точка 1 000 000: 5 % = 50 000 ≥ 25 000 — ступень 3 остаётся на 95 %.
  assert.equal(stepFor(t, 949999), 2);
});

test('строка остатка — на КАЖДОМ запросе, с верными числами', (t) => {
  const dir = sandbox(t);
  const file = transcript(dir, [user('q'), asst(100000, 212000, 500)]);
  // 312 500 из 1 000 000: 31 %, осталось 687 500 → ~688 тыс.
  for (let i = 0; i < 3; i++) {
    const res = prompt(dir, file, W1M);
    assert.deepEqual(remainOf(res), [31, 688]);
    assert.equal(stepOf(res), 0);
  }
});

test('остаток считается от точки сжатия с PCT облака, а не от окна модели', (t) => {
  const dir = sandbox(t);
  // Точка 967 000 × 0,8 = 773 600; 700 000 → 90 %, осталось 73 600 → ~74 тыс.
  const res = prompt(dir, transcript(dir, [asst(700000)]), { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' });
  assert.deepEqual(remainOf(res), [90, 74]);
  assert.equal(stepOf(res), 2);
});

test('после точки сжатия остаток не уходит в минус', (t) => {
  const dir = sandbox(t);
  assert.deepEqual(remainOf(prompt(dir, transcript(dir, [asst(1200000)]), W1M)), [120, 0]);
});

test('PostToolUse строку остатка не пишет', (t) => {
  const dir = sandbox(t);
  const file = transcript(dir, [asst(300000)]);
  prompt(dir, file, W1M); // база и первая строка
  silent(tool(dir, file, W1M));
});

test('объём = input + cache_read + cache_creation; output не входит', (t) => {
  const dir = sandbox(t);
  const res = tool(dir, transcript(dir, [asst(100000, 500000, 310000)]), W1M);
  assert.equal(stepOf(res), 2);
  assert.match(ctx(res), /91 % пути до автосжатия \(~910 тыс\. токенов из ~1000 тыс\., осталось ~90 тыс\.\)/);
});

test('точка автосжатия по умолчанию — ~967K (окно 1M у Opus 5.5)', (t) => {
  assert.equal(stepFor(t, 773500, {}), 0);
  assert.equal(stepFor(t, 773600, {}), 1);
});

test('PCT облака сдвигает точку: 80 % от 967K = 773 600', (t) => {
  const env = { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' };
  assert.equal(stepFor(t, 618800, env), 0);
  assert.equal(stepFor(t, 618880, env), 1);
  // Ступень 3 раньше точки сжатия: 95 % от 773 600 = 734 920.
  assert.equal(stepFor(t, 734920, env), 3);
});

test('PCT вне 1…100 не действует', (t) => {
  assert.equal(stepFor(t, 800000, { ...W1M, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '150' }), 1);
  assert.equal(stepFor(t, 800000, { ...W1M, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '0' }), 1);
});

test('окно автосжатия: `500k` читается как 500 → минимум 100 000; не больше окна модели', (t) => {
  assert.equal(stepFor(t, 75000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500k' }), 3);
  assert.equal(stepFor(t, 160000, { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' }), 1);
  assert.equal(stepFor(t, 159000, { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' }), 0);
  assert.equal(stepFor(t, 160000, { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900000' }), 1);
});

test('настройка autoCompactWindow из файлов настроек; переменная старше', (t) => {
  const dir = sandbox(t);
  fs.mkdirSync(path.join(dir, '.claude'));
  // В песочнице HOME = cwd, поэтому это одновременно и настройки пользователя.
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ autoCompactWindow: 500000 }));
  const file = transcript(dir, [asst(400000)]);
  assert.equal(stepOf(tool(dir, file, {})), 1, '400 000 из 500 000 = 80 %');
  const d2 = sandbox(t);
  fs.mkdirSync(path.join(d2, '.claude'));
  fs.writeFileSync(path.join(d2, '.claude', 'settings.json'), JSON.stringify({ autoCompactWindow: 500000 }));
  fs.writeFileSync(path.join(d2, '.claude', 'settings.local.json'), JSON.stringify({ autoCompactWindow: 1000000 }));
  assert.equal(stepOf(tool(d2, transcript(d2, [asst(400000)]), {})), 0, 'локальные настройки старше');
  const d3 = sandbox(t);
  fs.mkdirSync(path.join(d3, '.claude'));
  fs.writeFileSync(path.join(d3, '.claude', 'settings.json'), JSON.stringify({ autoCompactWindow: 500000 }));
  assert.equal(stepOf(tool(d3, transcript(d3, [asst(400000)]), W1M)), 0, 'переменная старше настроек');
  const d4 = sandbox(t);
  fs.mkdirSync(path.join(d4, '.claude'));
  fs.writeFileSync(path.join(d4, '.claude', 'settings.json'), '{битый');
  assert.equal(stepOf(tool(d4, transcript(d4, [asst(800000)]), {})), 1, 'битый файл — окно по умолчанию');
});

test('берётся ПОСЛЕДНИЙ usage, а не первый и не наибольший', (t) => {
  const d1 = sandbox(t);
  const down = tool(d1, transcript(d1, [asst(990000), user('q'), asst(100000), user('tool_result')]), W1M);
  assert.equal(stepOf(down), 0);
  const d2 = sandbox(t);
  const up = tool(d2, transcript(d2, [asst(100000), user('q'), asst(910000), user('tool_result')]), W1M);
  assert.equal(stepOf(up), 2);
});

test('субагентский (sidechain) и синтетический ответы не считаются', (t) => {
  const dir = sandbox(t);
  const synth = asst(990000);
  synth.message.model = '<synthetic>';
  const res = tool(dir, transcript(dir, [asst(100000), asst(990000, 0, 0, { isSidechain: true }), synth]), W1M);
  assert.equal(stepOf(res), 0);
});

test('после сжатия (compact_boundary) объём = postTokens', (t) => {
  const dir = sandbox(t);
  const res = prompt(dir, transcript(dir, [asst(990000), boundary(7000), user('продолжение')]), W1M);
  assert.equal(stepOf(res), 0);
  assert.deepEqual(remainOf(res), [0, 993]);
});

test('ступень запоминается: повтор — тишина, рост — только новая ступень', (t) => {
  const dir = sandbox(t);
  const recs = [user('q'), asst(820000)];
  const file = transcript(dir, recs);
  assert.equal(stepOf(tool(dir, file, W1M)), 1);
  silent(tool(dir, file, W1M));
  // На запросе — только строка остатка, без повторного предупреждения.
  const again = prompt(dir, file, W1M);
  assert.equal(stepOf(again), 0);
  assert.deepEqual(remainOf(again), [82, 180]);
  transcript(dir, [...recs, asst(860000)]);
  silent(tool(dir, file, W1M));
  transcript(dir, [...recs, asst(860000), asst(920000)]);
  const r2 = tool(dir, file, W1M);
  assert.equal(stepOf(r2), 2);
  assert.match(r2.json.systemMessage, /handoff/);
  silent(tool(dir, file, W1M));
  // Скачок через ступень — одно сообщение о высшей.
  transcript(dir, [...recs, asst(990000)]);
  assert.equal(stepOf(tool(dir, file, W1M)), 3);
  silent(tool(dir, file, W1M));
});

test('после сжатия ступень снижается и может сработать снова', (t) => {
  const dir = sandbox(t);
  const file = transcript(dir, [asst(960000)]);
  assert.equal(stepOf(tool(dir, file, W1M)), 3);
  transcript(dir, [asst(960000), boundary(5000)]);
  silent(tool(dir, file, W1M));
  transcript(dir, [asst(960000), boundary(5000), asst(810000)]);
  assert.equal(stepOf(tool(dir, file, W1M)), 1);
});

test('ступень хранится по session_id, вне репозитория — в $TMPDIR', (t) => {
  const dir = sandbox(t);
  const file = transcript(dir, [asst(910000)]);
  assert.equal(stepOf(prompt(dir, file, W1M)), 2);
  assert.equal(stepOf(prompt(dir, file, W1M, { session_id: 's2' })), 2);
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'routehub-context-watch', 's1.json'), 'utf8'));
  assert.equal(st.step, 2);
});

test('PostToolUse: hookEventName = PostToolUse', (t) => {
  const dir = sandbox(t);
  const res = tool(dir, transcript(dir, [asst(960000)]), W1M);
  assert.equal(res.json.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(stepOf(res), 3);
});

test('вызов внутри субагента (agent_id) — тишина', (t) => {
  const dir = sandbox(t);
  silent(prompt(dir, transcript(dir, [asst(960000)]), W1M, { agent_id: 'a1' }));
});

test('базовый объём — первый ответ, сообщается один раз', (t) => {
  const dir = sandbox(t);
  const file = transcript(dir, [user('q'), asst(21000), user('r'), asst(30000)]);
  const res = tool(dir, file, W1M);
  assert.equal(stepOf(res), 0);
  assert.match(ctx(res), /базовый объём сессии .* ~21 тыс\. токенов, 2 %/);
  silent(tool(dir, file, W1M));
});

test('usage не найден, а ответы есть — один сигнал «не отслеживается»', (t) => {
  const dir = sandbox(t);
  const noUsage = { type: 'assistant', message: { role: 'assistant', content: [] } };
  const file = transcript(dir, [user('q'), noUsage]);
  assert.match(ctx(prompt(dir, file, W1M)), /объём контекста не отслеживается/);
  silent(prompt(dir, file, W1M));
  // Первый запрос сессии (ответов ещё нет) — не сигнал.
  const d2 = sandbox(t);
  silent(prompt(d2, transcript(d2, [user('q')]), W1M));
});

test('битый вход, нет файла, пустой транскрипт — код 0 без вывода', (t) => {
  const dir = sandbox(t);
  silent(run(dir, 'не json'));
  silent(run(dir, ''));
  silent(run(dir, 'null'));
  silent(prompt(dir, path.join(dir, 'нет-такого.jsonl'), W1M));
  silent(prompt(dir, transcript(dir, [], 'empty.jsonl'), W1M));
  fs.writeFileSync(path.join(dir, 'zero.jsonl'), '');
  silent(prompt(dir, path.join(dir, 'zero.jsonl'), W1M));
  silent(prompt(dir, transcript(dir, ['{битая', '[1,2', user('q')], 'bad.jsonl'), W1M));
  silent(prompt(dir, transcript(dir, [asst(960000)], 'nosid.jsonl'), W1M, { session_id: undefined }));
  silent(run(dir, { hook_event_name: 'UserPromptSubmit', session_id: 's1', transcript_path: 42 }));
  silent(run(dir, { hook_event_name: 'Notification', session_id: 's1' }));
});

test('битая строка рядом с usage не мешает найти его', (t) => {
  const dir = sandbox(t);
  const res = tool(dir, transcript(dir, [asst(910000), '{"type":"assistant",обрыв', '']), W1M);
  assert.equal(stepOf(res), 2);
});

test('каталог состояния недоступен — предупреждение всё равно приходит, код 0', (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(path.join(dir, 'routehub-context-watch'), 'файл вместо каталога');
  const res = tool(dir, transcript(dir, [asst(910000)]), W1M);
  assert.equal(res.code, 0);
  assert.equal(stepOf(res), 2);
});

test('большой транскрипт: читается только хвост (разреженный файл 3 ГБ)', (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, 'big.jsonl');
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, 3 * 1024 ** 3); // целиком прочитать нельзя: > 2 ГБ
  fs.closeSync(fd);
  fs.appendFileSync(file, '\n' + [user('q'), asst(910000), user('r')].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const t0 = Date.now();
  const res = tool(dir, file, W1M);
  assert.equal(stepOf(res), 2);
  assert.ok(Date.now() - t0 < 5000, 'хвост читается быстро');
});

test('длинные строки: окно хвоста растёт, пока не найдёт usage', (t) => {
  const dir = sandbox(t);
  const big = user('x'.repeat(300 * 1024));
  const res = tool(dir, transcript(dir, [asst(910000), big, big, big]), W1M);
  assert.equal(stepOf(res), 2);
});

test('usage дальше 16 МБ от конца — не ищется (предел хвоста)', (t) => {
  const dir = sandbox(t);
  const filler = Array.from({ length: 70 }, () => user('y'.repeat(256 * 1024)));
  const res = tool(dir, transcript(dir, [asst(960000), ...filler]), W1M);
  assert.equal(res.code, 0);
  assert.equal(stepOf(res), 0);
});

// ── SessionStart ──

test('SessionStart startup → вызвать context-audit', (t) => {
  const dir = sandbox(t);
  const res = run(dir, { session_id: 's1', hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' });
  assert.equal(res.code, 0);
  assert.equal(res.json.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(ctx(res), /скилл context-audit/);
});

test('SessionStart compact → напоминание о handoff и сверке с репозиторием', (t) => {
  const dir = sandbox(t);
  const res = run(dir, { session_id: 's1', hook_event_name: 'SessionStart', source: 'compact' });
  assert.match(ctx(res), /только что сжат/);
  assert.match(ctx(res), /handoff/);
});

test('SessionStart resume/clear/fork — тишина', (t) => {
  const dir = sandbox(t);
  for (const source of ['resume', 'clear', 'fork', undefined]) {
    silent(run(dir, { session_id: 's1', hook_event_name: 'SessionStart', source }));
  }
});

// ── PreCompact ──

test('PreCompact manual: первый раз блок с объяснением (код 2), повтор проходит', (t) => {
  const dir = sandbox(t);
  const input = { session_id: 's1', hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null };
  const first = run(dir, input);
  assert.equal(first.code, 2);
  assert.equal(first.out, '');
  assert.match(first.err, /handoff/);
  assert.match(first.err, /повторите \/compact/);
  silent(run(dir, input));
  silent(run(dir, input));
  // Другая сессия — снова одно предупреждение.
  assert.equal(run(dir, { ...input, session_id: 's2' }).code, 2);
});

test('PreCompact auto — никогда не блокируется', (t) => {
  const dir = sandbox(t);
  const input = { session_id: 's1', hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null };
  silent(run(dir, input));
  silent(run(dir, input));
});

test('PreCompact manual без возможности записать отметку — не блокирует', (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(path.join(dir, 'routehub-context-watch'), 'файл вместо каталога');
  silent(run(dir, { session_id: 's1', hook_event_name: 'PreCompact', trigger: 'manual' }));
  silent(run(dir, { hook_event_name: 'PreCompact', trigger: 'manual' }));
});

// ── Регистрация ──

test('settings.json: хук на четырёх событиях, guard-prod на месте', () => {
  const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const cmds = (ev) => (s.hooks[ev] || []).flatMap((g) => g.hooks.map((h) => (h.args || []).join(' ')));
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact']) {
    assert.ok(cmds(ev).some((c) => c.endsWith('/.claude/hooks/context-watch.js')), ev);
  }
  assert.ok(cmds('PreToolUse').some((c) => c.endsWith('/.claude/hooks/guard-prod.js')));
  assert.equal(s.hooks.PreToolUse[0].matcher, 'Edit|Write|NotebookEdit');
});
