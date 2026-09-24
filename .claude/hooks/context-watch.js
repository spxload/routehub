#!/usr/bin/env node
// Монитор контекста сессии: передача дел (`handoff`) вместо сжатия.
//
// ЗАЧЕМ. Сжатие (`/compact` или автосжатие) пересказывает раннюю часть сессии
// и теряет детали без следа; файл передачи `studio/handoff/…` остаётся в
// репозитории. Модель сама заполненность своего контекста не видит: у Opus 5.5
// нет «context awareness» (в списке моделей с ней его нет —
// https://platform.claude.com/docs/en/build-with-claude/context-windows#context-awareness),
// `/context` показывает её только пользователю. Хук считает объём по
// транскрипту и сообщает модели ступень.
//
// ОДИН ФАЙЛ — ЧЕТЫРЕ СОБЫТИЯ (https://code.claude.com/docs/en/hooks):
//   UserPromptSubmit, PostToolUse — монитор. `additionalContext` доходит до
//     модели «alongside the submitted prompt» / «next to the tool result»;
//     PostToolUse нужен, чтобы ступень 3 сработала посреди длинной задачи,
//     где новых запросов нет. Stop не используется: его `additionalContext`
//     продолжает ход принудительно — лишний ход ради предупреждения.
//   SessionStart — `source` = "startup": вызвать скилл `context-audit`;
//     "compact": напомнить, что контекст уже сжат (вывод SessionStart с
//     источником compact добавляется в сжатый контекст —
//     https://code.claude.com/docs/en/context-window#what-survives-compaction).
//   PreCompact — может заблокировать сжатие (код 2), но добавить инструкции
//     к пересказу не может: его stdout модели не передаётся. Что сохранять —
//     раздел «Compact instructions» в CLAUDE.md
//     (https://code.claude.com/docs/en/costs#manage-context-proactively).
//     Автосжатие НЕ блокируется: вход различает только `trigger` auto/manual,
//     а блокировка сжатия, запущенного после ошибки переполнения, роняет
//     запрос. Ручной `/compact` блокируется ОДИН раз за сессию с объяснением
//     (для manual stderr показывается Диане); повтор проходит — выбор за ней.
//
// ОБЪЁМ. Сумма `input_tokens + cache_creation_input_tokens +
// cache_read_input_tokens` последнего ответа — та же формула, что у
// `used_percentage` строки состояния (https://code.claude.com/docs/en/statusline#context-window-fields).
// Процент считается от ТОЧКИ АВТОСЖАТИЯ, а не от окна модели: так ступени
// всегда раньше сжатия, какой бы процент ни выставило облако.
//   точка = окно_автосжатия × PCT / 100, где
//   окно_автосжатия = CLAUDE_CODE_AUTO_COMPACT_WINDOW (100 000…1 000 000, не
//     больше окна модели) или ~967 000 по умолчанию для моделей с окном 1M
//     («compact … at about 967K tokens by default» —
//     https://code.claude.com/docs/en/model-config#default-auto-compact-thresholds);
//   окно модели — 1 000 000 у Opus 5.5 (platform context-windows, ссылка
//     выше), 200 000 при CLAUDE_CODE_DISABLE_1M_CONTEXT=1 (model-config);
//   PCT = CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (1…100) — облако выставляет его само
//     (https://code.claude.com/docs/en/claude-code-on-the-web#manage-context),
//     значение документация не называет; в облачной сессии 24.09 наблюдалось
//     80. Хук наследует окружение Claude Code (hooks, «Common input fields»).
//
// НАДЁЖНОСТЬ. Транскрипт читается с хвоста (256 КБ, при нужде ×4 до 16 МБ):
// строки бывают по 250 КБ, файл — десятки МБ. Любой сбой — тихий выход с
// кодом 0: монитор не должен ломать сессию. Ступень запоминается в
// $TMPDIR/routehub-context-watch/<session_id>.json (вне репозитория) и
// сообщается только при переходе на более высокую; после сжатия объём
// падает, ступень снижается и может сработать снова. Сети нет.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Ступени, % пути до автосжатия. Сообщение — только при переходе вверх.
const STEPS = [50, 65, 80];
const MODEL_WINDOW = 1000000;       // Opus 5.5 — 1M
const MODEL_WINDOW_NO_1M = 200000;  // CLAUDE_CODE_DISABLE_1M_CONTEXT=1
const AC_WINDOW_DEFAULT = 967000;   // «about 967K tokens by default»
const AC_WINDOW_MIN = 100000;
const AC_WINDOW_MAX = 1000000;
const TAIL_START = 256 * 1024;
const TAIL_MAX = 16 * 1024 * 1024;
const HEAD_MAX = 4 * 1024 * 1024;
const STATE_DIR = 'routehub-context-watch';

// Скилл handoff вызывает только Диана (`disable-model-invocation: true` —
// https://code.claude.com/docs/en/skills), поэтому модель предлагает команду.
const HANDOFF = 'Диане предлагается команда `/handoff <чем займётся следующая сессия>` '
  + '(аргумент модель пишет готовым; скилл вызывает только Диана), после неё — новая '
  + 'сессия Code с репозиторием routehub и первым сообщением «Продолжи по studio/handoff/<файл>»';

// Как у Claude Code: `500k` читается как 500 и поднимается до минимума (env-vars).
function int(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : NaN;
}

function compactPoint(env) {
  const model = env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1' ? MODEL_WINDOW_NO_1M : MODEL_WINDOW;
  let acw = int(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  acw = Number.isNaN(acw) ? AC_WINDOW_DEFAULT : Math.min(Math.max(acw, AC_WINDOW_MIN), AC_WINDOW_MAX);
  const pct = int(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
  return Math.min(acw, model) * (pct >= 1 && pct <= 100 ? pct : 100) / 100;
}

// Объём контекста по записи транскрипта: число, 0 после сжатия, null — не та запись.
function usedOf(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (rec.type === 'system' && rec.subtype === 'compact_boundary') {
    const post = rec.compactMetadata && rec.compactMetadata.postTokens;
    return Number.isFinite(post) ? post : 0;
  }
  if (rec.type !== 'assistant' || rec.isSidechain === true) return null;
  const m = rec.message;
  if (!m || !m.usage || m.model === '<synthetic>') return null;
  const u = m.usage;
  const sum = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0)
    + (Number(u.cache_read_input_tokens) || 0);
  return sum > 0 ? sum : null;
}

function parse(line) {
  try { return JSON.parse(line); } catch (e) { return null; }
}

function readRange(fd, start, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, start);
  return buf.toString('utf8', 0, n);
}

// Последний объём: с конца файла, окно растёт, пока не найдена запись.
function lastUsed(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    for (let len = TAIL_START; ; len *= 4) {
      const start = Math.max(0, size - Math.min(len, TAIL_MAX));
      const lines = readRange(fd, start, size - start).split('\n');
      if (start > 0) lines.shift(); // первая строка обрезана
      for (let i = lines.length - 1; i >= 0; i--) {
        const used = usedOf(parse(lines[i]));
        if (used !== null) return used;
      }
      if (start === 0 || len >= TAIL_MAX) return null;
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Базовый объём — первый ответ сессии; -1: в начале файла ответа нет и не будет.
function firstUsed(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const lines = readRange(fd, 0, Math.min(size, HEAD_MAX)).split('\n');
    if (size > HEAD_MAX) lines.pop();
    for (const line of lines) {
      const rec = parse(line);
      const used = rec && rec.type === 'assistant' ? usedOf(rec) : null;
      if (used) return used;
    }
    return size > HEAD_MAX ? -1 : null;
  } finally {
    fs.closeSync(fd);
  }
}

function stateFile(sid) {
  const name = String(sid).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
  return name ? path.join(os.tmpdir(), STATE_DIR, name + '.json') : null;
}

function readState(file) {
  try {
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    return st && typeof st === 'object' ? st : {};
  } catch (e) {
    return {};
  }
}

function writeState(file, st) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(st));
    return true;
  } catch (e) {
    return false;
  }
}

const k = (n) => Math.round(n / 1000);

function stepText(step, pct, used, point) {
  const head = `Монитор контекста: контекст ~${Math.round(pct)} % пути до автосжатия `
    + `(~${k(used)} тыс. токенов из ~${k(point)} тыс.). `;
  if (step === 1) {
    return head + 'Ступень 1 из 3: по правилу CLAUDE.md («Контекст») текущая задача '
      + 'доводится до конца, новая большая задача в этой сессии не начинается.';
  }
  if (step === 2) {
    return head + 'Ступень 2 из 3: по правилу CLAUDE.md на ближайшей границе задачи '
      + `${HANDOFF}.`;
  }
  return head + 'Ступень 3 из 3, СРОЧНО: сейчас же, даже посреди задачи, пока '
    + `автосжатие не стёрло детали, ${HANDOFF}.`;
}

function userText(step, pct) {
  const head = `Контекст ~${Math.round(pct)} % пути до автосжатия. `;
  if (step === 1) return head + 'Текущую задачу доводим; новую большую — в новой сессии.';
  return head + 'Пора передать дела: выполните /handoff (Claude подскажет аргумент), затем '
    + 'откройте новую сессию с первым сообщением «Продолжи по studio/handoff/<файл>».';
}

function monitor(input, env) {
  if (input.agent_id) return null; // субагент дела сессии не передаёт
  const file = input.transcript_path;
  const sf = input.session_id ? stateFile(input.session_id) : null;
  if (!file || !sf || !fs.existsSync(file)) return null;
  const point = compactPoint(env);
  const st = readState(sf);
  const parts = [];
  let sys = null;
  let changed = false;

  const used = lastUsed(file);
  if (used !== null) {
    const pct = used / point * 100;
    const step = STEPS.filter((s) => pct >= s).length;
    const prev = Number(st.step) || 0;
    if (step > prev) {
      parts.push(stepText(step, pct, used, point));
      sys = userText(step, pct);
    }
    if (step !== prev) { st.step = step; changed = true; }
  }
  if (st.base === undefined) {
    const base = firstUsed(file);
    if (base !== null) {
      st.base = base;
      changed = true;
      if (base > 0) {
        parts.push(`Монитор контекста: базовый объём сессии (входные токены первого ответа) — `
          + `~${k(base)} тыс. токенов, ${Math.round(base / point * 100)} % пути до автосжатия: `
          + 'системный промпт, инструменты, скиллы, CLAUDE.md и первый запрос. '
          + 'Число — для отчёта скилла context-audit.');
      }
    }
  }
  if (changed) writeState(sf, st);
  if (!parts.length) return null;
  const out = {
    hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: parts.join('\n') },
  };
  if (sys) out.systemMessage = sys;
  return out;
}

function sessionStart(input) {
  let text = null;
  if (input.source === 'startup') {
    text = 'Новая сессия RouteHub. По правилу CLAUDE.md («Контекст») до ответа на первый '
      + 'запрос Дианы выполняется скилл context-audit — один раз за сессию.';
  } else if (input.source === 'compact') {
    text = 'Контекст сессии только что сжат: ранняя часть сохранилась лишь пересказом. '
      + 'По правилу CLAUDE.md («Контекст») факты перед действием сверяются с репозиторием '
      + `(git log, diff); на ближайшей границе задачи ${HANDOFF}.`;
  }
  return text ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } } : null;
}

// Возвращает текст для stderr, если ручной /compact надо остановить.
function preCompact(input) {
  if (input.trigger !== 'manual' || !input.session_id) return null;
  const sf = stateFile(input.session_id);
  if (!sf) return null;
  const st = readState(sf);
  if (st.compactWarned) return null;
  st.compactWarned = true;
  // Не записали отметку — не блокируем: иначе повтор тоже упрётся в блок.
  if (!writeState(sf, st)) return null;
  return 'RouteHub: вместо /compact — передача дел: выполните /handoff и '
    + 'откройте новую сессию с первым сообщением «Продолжи по studio/handoff/<файл>». '
    + 'Если сжать всё же нужно — повторите /compact: второй раз он пройдёт.';
}

function main(raw, env) {
  const input = JSON.parse(raw);
  const ev = input && input.hook_event_name;
  if (ev === 'UserPromptSubmit' || ev === 'PostToolUse') return { out: monitor(input, env) };
  if (ev === 'SessionStart') return { out: sessionStart(input) };
  if (ev === 'PreCompact') return { block: preCompact(input) };
  return {};
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let res;
  try {
    res = main(raw, process.env);
  } catch (e) {
    return; // монитор не ломает сессию: молча, код 0
  }
  if (res.out) process.stdout.write(JSON.stringify(res.out));
  if (res.block) {
    process.stderr.write(res.block);
    process.exitCode = 2; // PreCompact: код 2 блокирует сжатие
  }
});
