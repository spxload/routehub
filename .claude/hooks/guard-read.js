#!/usr/bin/env node
// Сторож контекста: не даёт инструменту Read залить в контекст большой кусок.
//
// ЗАЧЕМ. 28.09 сессия умерла на сыром результате ST24 (3,9 МБ, ~1,3 млн
// токенов — больше всего окна). Встроенный предел Read — 256 КБ на файл
// целиком, но с offset/limit он пропускает любой кусок: проверено 28.09 —
// 1500 строк (~94 КБ, ~30 тыс. токенов) прочитаны без вопроса. Вывод Bash
// Claude Code сам уводит в файл, когда он велик (там же, 386 КБ → превью
// 2 КБ), — сторожить нужно только Read.
//
// КОНТРАКТ (https://code.claude.com/docs/en/hooks, PreToolUse):
//   вход  — JSON в stdin: `tool_input.file_path`, `offset`, `limit`;
//   выход — код 0; кусок дороже порога → в stdout
//           {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//             "permissionDecision":"deny","permissionDecisionReason":"…"}}
//           — причину видит Claude и читает уже́ или скриптом; иначе пусто.
//   Любая ошибка — молча пропустить: это экономия, а не защита; у Read
//   остаётся свой предел 256 КБ.
//
// ОЦЕНКА. Токенов ≈ байты UTF-8 / 3 + число строк (номер строки в выводе
// Read). Грубо и с запасом: кириллица — 2 байта на букву, JSON и латиница —
// 3–4 символа на токен. Точный счёт требует API подсчёта токенов, ключа в
// сессии нет. Порог — 20 000 токенов (переменная RH_READ_MAX_TOKENS).
//
// КОМАНДА. `node .claude/hooks/guard-read.js --estimate <файл> [offset limit]`
// печатает оценку без чтения в контекст: байты, строки, токены.
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX = 20000;
const READ_DEFAULT_LIMIT = 2000; // Read без limit берёт до 2000 строк
const WHOLE_MAX_BYTES = 32 * 1024 * 1024; // больше — не читаем и сами
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
  '.ico', '.pdf', '.ipynb']);

function maxTokens(env) {
  const n = Number(env.RH_READ_MAX_TOKENS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX;
}

// Оценка куска [offset, offset+limit) по строкам; offset — с 1, как у Read.
function estimate(file, offset, limit) {
  const st = fs.statSync(file);
  if (!st.isFile()) return null;
  if (st.size > WHOLE_MAX_BYTES) {
    return { fileBytes: st.size, bytes: st.size, lines: null, tokens: Math.ceil(st.size / 3), huge: true };
  }
  const text = fs.readFileSync(file, 'utf8');
  const all = text.split('\n');
  if (all.length && all[all.length - 1] === '') all.pop();
  const from = Math.max(1, Number(offset) || 1) - 1;
  const lim = Number(limit) > 0 ? Number(limit) : READ_DEFAULT_LIMIT;
  const part = all.slice(from, from + lim);
  const bytes = part.reduce((s, l) => s + Buffer.byteLength(l, 'utf8') + 1, 0);
  return {
    fileBytes: st.size,
    fileLines: all.length,
    bytes,
    lines: part.length,
    tokens: Math.ceil(bytes / 3) + part.length,
  };
}

function kb(n) {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : Math.round(n / 1024) + ' КБ';
}

function reason(e, max) {
  const t = Math.round(e.tokens / 1000);
  if (e.huge) {
    return `Сторож контекста: файл ${kb(e.fileBytes)}, ~${t} тыс. токенов — через Read не читать. ` +
      'Сводку снимать скриптом (node/grep/awk, вывод — короткий).';
  }
  const perLine = e.lines ? e.tokens / e.lines : 1;
  const fit = Math.max(1, Math.floor(max / perLine));
  return `Сторож контекста: кусок ${e.lines} строк, ${kb(e.bytes)}, ~${t} тыс. токенов ` +
    `(порог ${Math.round(max / 1000)} тыс.; файл ${kb(e.fileBytes)}, ${e.fileLines} строк). ` +
    `Уже: limit ≈ ${fit} строк, Grep по нужному месту или скрипт со сводкой.`;
}

function decide(input, env) {
  const ti = (input && input.tool_input) || {};
  const file = ti.file_path;
  if (!file || SKIP_EXT.has(path.extname(file).toLowerCase())) return null;
  const e = estimate(file, ti.offset, ti.limit);
  const max = maxTokens(env);
  if (!e || e.tokens <= max) return null;
  return reason(e, max);
}

function cli(args) {
  const [file, offset, limit] = args;
  const e = estimate(file, offset, limit || (offset ? undefined : Infinity));
  process.stdout.write(JSON.stringify(e) + '\n');
}

if (process.argv[2] === '--estimate') {
  try { cli(process.argv.slice(3)); } catch (err) {
    process.stderr.write(err.message + '\n');
    process.exit(1);
  }
} else {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let why = null;
    try { why = decide(JSON.parse(raw), process.env); } catch (_) { why = null; }
    if (why) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: why,
        },
      }));
    }
    process.exit(0);
  });
}
