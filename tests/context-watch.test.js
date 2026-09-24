// Монитор контекста (`.claude/hooks/context-watch.js`).
//
// ЗАЧЕМ. Хук — единственное, что сообщает модели, сколько контекста занято:
// сама она этого не видит. Если ступени сдвинутся, предупреждение придёт
// после автосжатия и детали сессии пропадут; если сломается память ступени —
// одно и то же предупреждение будет на каждом вызове инструмента; если хук
// упадёт — сессия получит ошибку хука на каждом запросе. Тест гоняет скрипт
// как чёрный ящик, как его запускает Claude Code: JSON в stdin, ответ в
// stdout, код выхода.
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
  'CLAUDE_CODE_DISABLE_1M_CONTEXT'];
// Окно 100 000 без PCT: точка автосжатия ровно 100 000, 1 % = 1 000 токенов.
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

function run(dir, input, env = {}) {
  const base = { ...process.env };
  for (const v of CTX_VARS) delete base[v];
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  const r = spawnSync(process.execPath, [HOOK], {
    input: raw,
    encoding: 'utf8',
    env: { ...base, TMPDIR: dir, ...env },
  });
  const out = r.stdout.trim();
  return { code: r.status, out, err: r.stderr, json: out ? JSON.parse(out) : null };
}

function prompt(dir, file, env, extra = {}) {
  return run(dir, { session_id: 's1', transcript_path: file, cwd: dir,
    hook_event_name: 'UserPromptSubmit', prompt: 'дальше', ...extra }, env);
}

function ctx(res) {
  return res.json ? res.json.hookSpecificOutput.additionalContext : '';
}

function stepOf(res) {
  const m = ctx(res).match(/Ступень (\d) из 3/g);
  if (!m) return 0;
  assert.equal(m.length, 1, 'за один вызов — не больше одного сообщения о ступени');
  return Number(m[0].match(/\d/)[0]);
}

function silent(res) {
  assert.equal(res.code, 0, 'код выхода 0');
  assert.equal(res.out, '', 'stdout пуст');
  assert.equal(res.err, '', 'stderr пуст');
}

// Один свежий каталог состояния на замер: ступень определяется «с нуля».
function stepFor(t, used, env = W100K) {
  const dir = sandbox(t);
  const res = prompt(dir, transcript(dir, [user('q'), asst(used)]), env);
  assert.equal(res.code, 0);
  return stepOf(res);
}

test('границы ступеней 50/65/80 % пути до автосжатия', (t) => {
  assert.equal(stepFor(t, 49999), 0);
  assert.equal(stepFor(t, 50000), 1);
  assert.equal(stepFor(t, 64999), 1);
  assert.equal(stepFor(t, 65000), 2);
  assert.equal(stepFor(t, 79999), 2);
  assert.equal(stepFor(t, 80000), 3);
  assert.equal(stepFor(t, 99000), 3);
});

test('объём = input + cache_read + cache_creation; output не входит', (t) => {
  const dir = sandbox(t);
  const res = prompt(dir, transcript(dir, [asst(10000, 30000, 25000)]), W100K);
  assert.equal(stepOf(res), 2);
  assert.match(ctx(res), /~65 % пути до автосжатия \(~65 тыс\. токенов из ~100 тыс\.\)/);
});

test('точка автосжатия по умолчанию — ~967K (окно 1M у Opus 5.5)', (t) => {
  assert.equal(stepFor(t, 483000, {}), 0);
  assert.equal(stepFor(t, 483500, {}), 1);
});

test('PCT облака сдвигает точку: 80 % от 967K = 773 600', (t) => {
  const env = { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' };
  assert.equal(stepFor(t, 386700, env), 0);
  assert.equal(stepFor(t, 386800, env), 1);
  // Ступень 3 наступает раньше точки сжатия: 80 % от 773 600 = 618 880.
  assert.equal(stepFor(t, 618880, env), 3);
});

test('PCT вне 1…100 не действует', (t) => {
  assert.equal(stepFor(t, 50000, { ...W100K, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '150' }), 1);
  assert.equal(stepFor(t, 50000, { ...W100K, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '0' }), 1);
});

test('окно автосжатия: `500k` читается как 500 → минимум 100 000; не больше окна модели', (t) => {
  assert.equal(stepFor(t, 50000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500k' }), 1);
  assert.equal(stepFor(t, 100000, { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' }), 1);
  assert.equal(stepFor(t, 99000, { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' }), 0);
  assert.equal(stepFor(t, 100000, { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900000' }), 1);
});

test('берётся ПОСЛЕДНИЙ usage, а не первый и не наибольший', (t) => {
  const d1 = sandbox(t);
  const down = prompt(d1, transcript(d1, [asst(90000), user('q'), asst(10000), user('tool_result')]), W100K);
  assert.equal(stepOf(down), 0);
  const d2 = sandbox(t);
  const up = prompt(d2, transcript(d2, [asst(10000), user('q'), asst(66000), user('tool_result')]), W100K);
  assert.equal(stepOf(up), 2);
});

test('субагентский (sidechain) и синтетический ответы не считаются', (t) => {
  const dir = sandbox(t);
  const synth = asst(95000);
  synth.message.model = '<synthetic>';
  const res = prompt(dir, transcript(dir, [asst(10000), asst(95000, 0, 0, { isSidechain: true }), synth]), W100K);
  assert.equal(stepOf(res), 0);
});

test('после сжатия (compact_boundary) объём = postTokens', (t) => {
  const dir = sandbox(t);
  const res = prompt(dir, transcript(dir, [asst(95000), boundary(7000), user('продолжение')]), W100K);
  assert.equal(stepOf(res), 0);
});

test('ступень запоминается: повтор — тишина, рост — только новая ступень', (t) => {
  const dir = sandbox(t);
  const recs = [user('q'), asst(52000)];
  const file = transcript(dir, recs);
  assert.equal(stepOf(prompt(dir, file, W100K)), 1);
  silent(prompt(dir, file, W100K));
  silent(prompt(dir, file, W100K));
  transcript(dir, [...recs, asst(58000)]);
  silent(prompt(dir, file, W100K));
  transcript(dir, [...recs, asst(58000), asst(70000)]);
  const r2 = prompt(dir, file, W100K);
  assert.equal(stepOf(r2), 2);
  assert.match(r2.json.systemMessage, /handoff/);
  silent(prompt(dir, file, W100K));
  // Скачок через ступень — одно сообщение о высшей.
  transcript(dir, [...recs, asst(99000)]);
  assert.equal(stepOf(prompt(dir, file, W100K)), 3);
  silent(prompt(dir, file, W100K));
});

test('после сжатия ступень снижается и может сработать снова', (t) => {
  const dir = sandbox(t);
  const file = transcript(dir, [asst(81000)]);
  assert.equal(stepOf(prompt(dir, file, W100K)), 3);
  transcript(dir, [asst(81000), boundary(5000)]);
  silent(prompt(dir, file, W100K));
  transcript(dir, [asst(81000), boundary(5000), asst(51000)]);
  assert.equal(stepOf(prompt(dir, file, W100K)), 1);
});

test('ступень хранится по session_id, вне репозитория — в $TMPDIR', (t) => {
  const dir = sandbox(t);
  const file = transcript(dir, [asst(66000)]);
  assert.equal(stepOf(prompt(dir, file, W100K)), 2);
  assert.equal(stepOf(prompt(dir, file, W100K, { session_id: 's2' })), 2);
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'routehub-context-watch', 's1.json'), 'utf8'));
  assert.equal(st.step, 2);
});

test('PostToolUse: тот же монитор, hookEventName = PostToolUse', (t) => {
  const dir = sandbox(t);
  const file = transcript(dir, [asst(81000)]);
  const res = run(dir, { session_id: 's1', transcript_path: file, hook_event_name: 'PostToolUse',
    tool_name: 'Bash', tool_input: {}, tool_response: {} }, W100K);
  assert.equal(res.json.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(stepOf(res), 3);
});

test('вызов внутри субагента (agent_id) — тишина', (t) => {
  const dir = sandbox(t);
  silent(prompt(dir, transcript(dir, [asst(81000)]), W100K, { agent_id: 'a1' }));
});

test('базовый объём — первый ответ, сообщается один раз', (t) => {
  const dir = sandbox(t);
  const file = transcript(dir, [user('q'), asst(21000), user('r'), asst(30000)]);
  const res = prompt(dir, file, W100K);
  assert.equal(stepOf(res), 0);
  assert.match(ctx(res), /базовый объём сессии .* ~21 тыс\. токенов, 21 %/);
  silent(prompt(dir, file, W100K));
});

test('битый вход, нет файла, пустой транскрипт — код 0 без вывода', (t) => {
  const dir = sandbox(t);
  silent(run(dir, 'не json'));
  silent(run(dir, ''));
  silent(run(dir, 'null'));
  silent(prompt(dir, path.join(dir, 'нет-такого.jsonl'), W100K));
  silent(prompt(dir, transcript(dir, [], 'empty.jsonl'), W100K));
  fs.writeFileSync(path.join(dir, 'zero.jsonl'), '');
  silent(prompt(dir, path.join(dir, 'zero.jsonl'), W100K));
  silent(prompt(dir, transcript(dir, ['{битая', '[1,2', user('q')], 'bad.jsonl'), W100K));
  silent(prompt(dir, transcript(dir, [asst(81000)], 'nosid.jsonl'), W100K, { session_id: undefined }));
  silent(run(dir, { hook_event_name: 'UserPromptSubmit', session_id: 's1', transcript_path: 42 }));
  silent(run(dir, { hook_event_name: 'Notification', session_id: 's1' }));
});

test('битая строка рядом с usage не мешает найти его', (t) => {
  const dir = sandbox(t);
  const res = prompt(dir, transcript(dir, [asst(66000), '{"type":"assistant",обрыв', '']), W100K);
  assert.equal(stepOf(res), 2);
});

test('каталог состояния недоступен — предупреждение всё равно приходит, код 0', (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(path.join(dir, 'routehub-context-watch'), 'файл вместо каталога');
  const res = prompt(dir, transcript(dir, [asst(66000)]), W100K);
  assert.equal(res.code, 0);
  assert.equal(stepOf(res), 2);
});

test('большой транскрипт: читается только хвост (разреженный файл 3 ГБ)', (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, 'big.jsonl');
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, 3 * 1024 ** 3); // целиком прочитать нельзя: > 2 ГБ
  fs.closeSync(fd);
  fs.appendFileSync(file, '\n' + [user('q'), asst(66000), user('r')].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const t0 = Date.now();
  const res = prompt(dir, file, W100K);
  assert.equal(stepOf(res), 2);
  assert.ok(Date.now() - t0 < 5000, 'хвост читается быстро');
});

test('длинные строки: окно хвоста растёт, пока не найдёт usage', (t) => {
  const dir = sandbox(t);
  const big = user('x'.repeat(300 * 1024));
  const res = prompt(dir, transcript(dir, [asst(66000), big, big, big]), W100K);
  assert.equal(stepOf(res), 2);
});

test('usage дальше 16 МБ от конца — не ищется (предел хвоста)', (t) => {
  const dir = sandbox(t);
  const filler = Array.from({ length: 70 }, () => user('y'.repeat(256 * 1024)));
  const res = prompt(dir, transcript(dir, [asst(81000), ...filler]), W100K);
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
