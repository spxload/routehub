#!/usr/bin/env node
// Предохранитель правила 5: правка боевого контура — только с согласия Дианы.
//
// ЗАЧЕМ. Любой коммит в `main` уходит в бой (автодеплой Worker'а), а конфиг
// и скрипты устройства Loon читает прямо из репозитория. Хук не запрещает
// правку молча, а заставляет Claude Code спросить пользователя — решение
// остаётся за человеком.
//
// КОНТРАКТ (https://code.claude.com/docs/en/hooks, PreToolUse):
//   вход  — JSON в stdin: `tool_name`, `tool_input.file_path` (у Write/Edit
//           путь всегда абсолютный), `cwd`; корень проекта — переменная
//           окружения CLAUDE_PROJECT_DIR;
//   выход — код 0; для боевого пути в stdout
//           {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//             "permissionDecision":"ask","permissionDecisionReason":"…"}};
//           для прочих путей stdout пуст — действует обычный порядок
//           разрешений, хук ничего не добавляет и ничего не разрешает.
//   Код 2 не используется: он блокирует вызов, а нужен вопрос, не запрет.
//   Любое исключение ловится и превращается в «ask»: по документации
//   падение с кодом 1 — неблокирующая ошибка, правка прошла бы без вопроса.
//
// Ограничения: хук видит только инструменты из `matcher` в settings.json;
// правка через Bash (`sed -i`, `git apply`) его обходит — это предохранитель,
// а не замок. Хуки `.claude/settings.json` действуют только в сессии с одним
// репозиторием (code.claude.com/docs/en/cloud-environments, «What carries
// over»). Сетевых вызовов и записи на диск нет.
'use strict';

const fs = require('fs');
const path = require('path');

const REASON = 'Правило 5: правка боевого контура — только с согласия Дианы';

// Боевой контур: отдельные файлы в корне и каталоги целиком.
const PROD_FILES = ['routehub.conf', 'routehub-worker.js', 'wrangler.toml'];
const PROD_DIRS = ['src/', 'scripts/', 'plugins/'];

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

// Реальный путь: симлинки раскрыты, чтобы `docs/x -> ../routehub.conf` не
// прошёл мимо. Файла ещё нет (Write создаёт новый) — раскрывается ближайший
// существующий родитель, хвост дописывается как есть. Прочие ошибки
// (например, нулевой байт в пути) не глушатся — их ловит обработчик ниже.
function real(p) {
  const tail = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const up = path.dirname(cur);
      if (up === cur) return p;
      tail.unshift(path.basename(cur));
      cur = up;
    }
  }
}

// Путь файла относительно корня. `../` и относительная запись схлопываются
// через resolve; файл вне корня получает префикс `../` и боевым не считается;
// рабочее дерево `.claude/worktrees/<имя>/` сводится к пути внутри него.
function relTo(root, file) {
  const base = path.resolve(toPosix(root));
  const abs = path.resolve(base, toPosix(file));
  const rel = toPosix(path.relative(real(base), real(abs)));
  const wt = rel.match(/^\.claude\/worktrees\/[^/]+\/(.+)$/);
  return wt ? wt[1] : rel;
}

function isProd(rel) {
  return PROD_FILES.includes(rel) || PROD_DIRS.some((d) => rel.startsWith(d));
}

// Возвращает относительный боевой путь или null.
function classify(input, env) {
  const ti = (input && input.tool_input) || {};
  const file = ti.file_path || ti.notebook_path;
  if (!file) return null;
  const roots = [env.CLAUDE_PROJECT_DIR, input.cwd].filter(Boolean);
  for (const root of roots) {
    const rel = relTo(root, file);
    if (isProd(rel)) return rel;
  }
  return null;
}

function ask(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  }));
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let rel;
  try {
    rel = classify(JSON.parse(raw), process.env);
  } catch (e) {
    // Вход не разобран или сбой внутри — путь не проверен; безопаснее спросить.
    ask(REASON + ' (хук не смог проверить путь: ' + e.message + ')');
    process.exit(0);
  }
  if (rel) ask(REASON + '. Файл: ' + rel);
  process.exit(0);
});
