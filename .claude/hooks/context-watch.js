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
//     модели «alongside the submitted prompt» / «next to the tool result».
//     На КАЖДОМ UserPromptSubmit — строка остатка («N % до точки сжатия,
//     осталось ~X тыс.») для планирования задачи по объёму; ступени — по разу.
//     PostToolUse нужен, чтобы ступень сработала посреди длинной задачи, где
//     новых запросов нет; строку остатка он не пишет. Stop не используется:
//     его `additionalContext` продолжает ход принудительно — лишний ход.
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
//   окно_автосжатия = CLAUDE_CODE_AUTO_COMPACT_WINDOW, иначе настройка
//     `autoCompactWindow` (её пишет `/autocompact`) из .claude/settings.local.json,
//     .claude/settings.json, ~/.claude/settings.json — по старшинству
//     (https://code.claude.com/docs/en/settings-reference#autocompactwindow);
//     флаг `--autocompact` и управляемые настройки хуку не видны. Диапазон
//     100 000…1 000 000, не больше окна модели; по умолчанию ~967 000 для 1M
//     («compact … at about 967K tokens by default» —
//     https://code.claude.com/docs/en/model-config#default-auto-compact-thresholds);
//   окно модели — 1 000 000 у Opus 5.5 (platform context-windows, ссылка
//     выше), 200 000 при CLAUDE_CODE_DISABLE_1M_CONTEXT=1 (model-config);
//   PCT = CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (1…100) — облако выставляет его само
//     (https://code.claude.com/docs/en/claude-code-on-the-web#manage-context),
//     значение документация не называет; в облачной сессии 24.09 наблюдалось
//     80. Хук наследует окружение Claude Code (hooks, «Common input fields»).
//
// СТУПЕНИ 80/90/95 (решение Дианы 24.09 — как можно ближе к сжатию).
// Остаток на 95 % должен вместить саму передачу дел. Оценка (не замер):
// скилл ~1,5 тыс. токенов, git log/diff ~2–5, файл передачи ~2,5 (пишется)
// + ~2,5 (заливка), рассуждение и ответ ~3–5 — итого ~12–17 тыс.; плюс один
// крупный шаг (чтение файла, вывод тестов) до ~10 тыс. Резерв — 25 тыс.
// При облачной точке ~773 600 (PCT 80) 5 % = ~38 700 — хватает; при малом
// окне (100 000 → 5 % = 5 000) не хватит, поэтому ступень 3 сдвигается
// так, чтобы остаток был не меньше резерва, а ступени 1–2 — не выше неё.
// Если формат транскрипта сменится и usage не найдётся, модель один раз
// получает сигнал «объём не отслеживается».
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
const STEPS = [80, 90, 95];
const HANDOFF_RESERVE = 25000;      // токенов на передачу дел, см. выше
const MODEL_WINDOW = 1000000;       // Opus 5.5 — 1M
const MODEL_WINDOW_NO_1M = 200000;  // CLAUDE_CODE_DISABLE_1M_CONTEXT=1
const AC_WINDOW_DEFAULT = 967000;   // «about 967K tokens by default»
const AC_WINDOW_MIN = 100000;
const AC_WINDOW_MAX = 1000000;
const TAIL_START = 256 * 1024;
const TAIL_MAX = 16 * 1024 * 1024;
const HEAD_MAX = 4 * 1024 * 1024;
const STATE_DIR = 'routehub-context-watch';

// Если у скилла стоит `disable-model-invocation: true`
// (https://code.claude.com/docs/en/skills), модель его вызвать не может —
// тогда Диане предлагается команда.
const SAY_START = '«Контекст подходит к концу — запускаю передачу дел (handoff)»';
const SAY_NEXT = '«Откройте новую сессию Code с репозиторием routehub и напишите: '
  + 'Продолжи по studio/handoff/<файл>»';
const HANDOFF = `Диане — ${SAY_START}; скилл handoff (если модели он недоступен — Диане `
  + `команда \`/handoff <чем займётся следующая сессия>\`); после записи файла — ${SAY_NEXT}`;

// Как у Claude Code: `500k` читается как 500 и поднимается до минимума (env-vars).
function int(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : NaN;
}

// autoCompactWindow из файлов настроек: локальные > проекта > пользователя.
function settingsWindow(env, cwd) {
  const proj = env.CLAUDE_PROJECT_DIR || cwd;
  const files = [];
  if (proj) {
    files.push(path.join(proj, '.claude', 'settings.local.json'));
    files.push(path.join(proj, '.claude', 'settings.json'));
  }
  if (env.HOME) files.push(path.join(env.HOME, '.claude', 'settings.json'));
  for (const file of files) {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8')).autoCompactWindow;
      if (Number.isFinite(v)) return v;
    } catch (e) { /* нет файла или не JSON — следующий */ }
  }
  return NaN;
}

function compactPoint(env, cwd) {
  const model = env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1' ? MODEL_WINDOW_NO_1M : MODEL_WINDOW;
  let acw = int(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  if (Number.isNaN(acw)) acw = settingsWindow(env, cwd);
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
// Возвращает { used: число | null, blind: ответы есть, а объёма нет }.
function lastUsed(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let answers = false;
    for (let len = TAIL_START; ; len *= 4) {
      const start = Math.max(0, size - Math.min(len, TAIL_MAX));
      const lines = readRange(fd, start, size - start).split('\n');
      if (start > 0) lines.shift(); // первая строка обрезана
      for (let i = lines.length - 1; i >= 0; i--) {
        const rec = parse(lines[i]);
        const used = usedOf(rec);
        if (used !== null) return { used, blind: false };
        if (rec && rec.type === 'assistant') answers = true;
      }
      if (start === 0 || len >= TAIL_MAX) return { used: null, blind: answers || size > TAIL_START };
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

// Пороги в %: ступень 3 — не позже, чем остаётся резерв; 1–2 — не выше 3.
function thresholds(point) {
  const t3 = Math.min(STEPS[2], 100 - HANDOFF_RESERVE / point * 100);
  const t2 = Math.min(STEPS[1], t3);
  return [Math.min(STEPS[0], t2), t2, t3];
}

function remainText(pct, used, point) {
  return `Контекст: ${Math.floor(pct)} % до точки сжатия, осталось `
    + `~${k(Math.max(0, point - used))} тыс. токенов.`;
}

function stepText(step, pct, used, point) {
  const head = `Монитор контекста: ${Math.floor(pct)} % пути до автосжатия `
    + `(~${k(used)} тыс. токенов из ~${k(point)} тыс., осталось ~${k(Math.max(0, point - used))} тыс.). `
    + 'По правилу CLAUDE.md («Контекст») ';
  if (step === 1) {
    return head + 'ступень 1 из 3 — планируй конец: текущая задача доделывается, если '
      + 'влезает в остаток; новая большая не начинается; после завершения — передача '
      + `дел: ${HANDOFF}.`;
  }
  if (step === 2) {
    return head + 'ступень 2 из 3 — завершай: доделать, только если осталось немного, '
      + `иначе промежуточная передача дел в ближайшей безопасной точке: ${HANDOFF}.`;
  }
  return head + `ступень 3 из 3 — критично: передача дел сейчас: ${HANDOFF}.`;
}

function userText(step, pct) {
  const head = `Контекст ${Math.floor(pct)} % до точки сжатия. `;
  if (step === 1) return head + 'Текущая задача доводится, новая большая — в новой сессии.';
  return head + 'Контекст подходит к концу — передача дел (handoff). Затем откройте '
    + 'новую сессию Code с репозиторием routehub и напишите: Продолжи по studio/handoff/<файл>.';
}

function monitor(input, env) {
  if (input.agent_id) return null; // субагент дела сессии не передаёт
  const file = input.transcript_path;
  const sf = input.session_id ? stateFile(input.session_id) : null;
  if (!file || !sf || !fs.existsSync(file)) return null;
  const point = compactPoint(env, input.cwd);
  const prompt = input.hook_event_name === 'UserPromptSubmit';
  const st = readState(sf);
  const parts = [];
  let sys = null;
  let changed = false;

  const { used, blind } = lastUsed(file);
  if (used !== null) {
    const pct = used / point * 100;
    const step = thresholds(point).filter((s) => pct >= s).length;
    const prev = Number(st.step) || 0;
    if (prompt) parts.push(remainText(pct, used, point));
    if (step > prev) {
      parts.push(stepText(step, pct, used, point));
      sys = userText(step, pct);
    }
    if (step !== prev) { st.step = step; changed = true; }
  } else if (blind && prompt && !st.blindWarned) {
    st.blindWarned = true;
    changed = true;
    parts.push('Монитор контекста: в транскрипте нет данных usage — формат мог смениться, '
      + 'объём контекста не отслеживается. Сказать Диане; остаток — только по /context.');
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
      + `(git log, diff); на ближайшей границе задачи — передача дел: ${HANDOFF}.`;
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
  return 'RouteHub: вместо /compact — передача дел: выполните /handoff, затем откройте '
    + 'новую сессию Code с репозиторием routehub и напишите: Продолжи по studio/handoff/<файл>. '
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
