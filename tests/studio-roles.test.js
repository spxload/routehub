// Формат ролей и скиллов Claude Code (`.claude/agents/*.md`,
// `.claude/skills/*/SKILL.md`).
//
// ЗАЧЕМ. Роль или скилл с битым frontmatter не падает с ошибкой — Claude Code
// молча грузит его без полей, и он перестаёт срабатывать сам
// (code.claude.com/docs/en/skills, «Skill not triggering»: «If YAML between
// the markers doesn't parse, the skill still loads with no fields set»).
// Роль без `model: opus` уходит на модель по умолчанию; роль-наблюдатель с
// `Write` в `tools` получает право править репозиторий. Ни то, ни другое
// глазами не видно — поэтому тест.
//
// Поля — по документации: code.claude.com/docs/en/sub-agents (таблица
// «Supported frontmatter fields») и code.claude.com/docs/en/skills
// («Frontmatter reference»). Лимит 1 536 символов на `description` +
// `when_to_use` — там же: сверх него текст обрезается в списке скиллов.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const AGENTS = path.join(ROOT, '.claude', 'agents');
const SKILLS = path.join(ROOT, '.claude', 'skills');

// Роли без права записи: только читают и выносят вердикт или идеи.
const READ_ONLY = ['reviewer', 'tester', 'researcher', 'ideator'];
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
// Должны вызываться моделью сами — в этом их смысл.
const AUTO_SKILLS = ['prove-blocked', 'ideas'];
const AUTO_AGENTS = ['ideator'];

const AGENT_KEYS = new Set([
  'name', 'description', 'tools', 'disallowedTools', 'model', 'permissionMode',
  'maxTurns', 'skills', 'mcpServers', 'hooks', 'memory', 'background',
  'omitClaudeMd', 'effort', 'isolation', 'color', 'initialPrompt', 'experimental',
]);
const SKILL_KEYS = new Set([
  'name', 'description', 'when_to_use', 'argument-hint', 'arguments',
  'disable-model-invocation', 'user-invocable', 'allowed-tools',
  'disallowed-tools', 'model', 'effort', 'context', 'agent', 'background',
  'hooks', 'paths', 'shell', 'metadata', 'license', 'compatibility',
]);
const DESC_CAP = 1536;

// Минимальный разбор YAML-frontmatter: `key: value`, списки `- item`,
// блочные `|`/`>`. Вложенные карты (hooks, metadata) принимаются как есть.
export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  const fm = {};
  let key = null;
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const top = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (top && !/^\s/.test(line)) {
      key = top[1];
      let v = (top[2] ?? '').trim();
      if (/^['"].*['"]$/.test(v)) v = v.slice(1, -1);
      if (v === '|' || v === '>' || v === '|-' || v === '>-') v = '';
      fm[key] = v === '' ? [] : v;
      continue;
    }
    if (!key) return null; // строка до первого ключа — битый YAML
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (Array.isArray(fm[key])) fm[key].push(item ? item[1].trim() : line.trim());
    else fm[key] += ' ' + line.trim();
  }
  for (const k of Object.keys(fm)) {
    // Блочный скаляр (строки без «- ») склеить обратно в строку.
    if (Array.isArray(fm[k]) && k !== 'tools' && k !== 'disallowedTools' && k !== 'skills') {
      fm[k] = fm[k].join(' ');
    }
  }
  return fm;
}

function toolList(v) {
  if (v === undefined) return undefined;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\(.*\)$/, ''));
}

export function checkAgent(text, base) {
  const errs = [];
  const fm = parseFrontmatter(text);
  if (!fm) return ['нет frontmatter между строками ---'];
  for (const k of Object.keys(fm)) if (!AGENT_KEYS.has(k)) errs.push(`неизвестное поле ${k}`);
  if (!fm.name || typeof fm.name !== 'string') errs.push('пустой name');
  else if (fm.name !== base) errs.push(`name ${fm.name} ≠ имени файла ${base}`);
  if (!fm.description || !String(fm.description).trim()) errs.push('пустой description');
  if (fm.model !== 'opus') errs.push(`model должен быть opus, а не ${fm.model ?? 'пусто'}`);
  const tools = toolList(fm.tools);
  if (READ_ONLY.includes(base)) {
    if (!tools || !tools.length) errs.push('роль без записи обязана перечислить tools (иначе наследует Write)');
    else for (const t of WRITE_TOOLS) if (tools.includes(t)) errs.push(`роль без записи имеет ${t}`);
  }
  if (AUTO_AGENTS.includes(base) && !/use proactively/i.test(String(fm.description))) {
    errs.push('авто-роль без «Use proactively» в description');
  }
  const body = text.split(/\r?\n/).slice(text.split(/\r?\n/).indexOf('---', 1) + 1).join('\n');
  if (!body.trim()) errs.push('пустое тело роли');
  return errs;
}

export function checkSkill(text, dir) {
  const errs = [];
  const fm = parseFrontmatter(text);
  if (!fm) return ['нет frontmatter между строками ---'];
  for (const k of Object.keys(fm)) if (!SKILL_KEYS.has(k)) errs.push(`неизвестное поле ${k}`);
  if (!fm.name || typeof fm.name !== 'string') errs.push('пустой name');
  else if (fm.name !== dir) errs.push(`name ${fm.name} ≠ имени папки ${dir}`);
  if (!fm.description || !String(fm.description).trim()) errs.push('пустой description');
  const listed = `${fm.description ?? ''} ${fm.when_to_use ?? ''}`.trim();
  if ([...listed].length > DESC_CAP) errs.push(`description + when_to_use длиннее ${DESC_CAP} символов`);
  if (AUTO_SKILLS.includes(dir) && String(fm['disable-model-invocation']) === 'true') {
    errs.push('авто-скилл закрыт от модели (disable-model-invocation: true)');
  }
  return errs;
}

const agentFiles = fs.readdirSync(AGENTS).filter((f) => f.endsWith('.md'));
const skillDirs = fs.readdirSync(SKILLS).filter((d) => fs.existsSync(path.join(SKILLS, d, 'SKILL.md')));

test('роли и скиллы на месте', () => {
  for (const r of [...READ_ONLY, ...AUTO_AGENTS]) assert.ok(agentFiles.includes(`${r}.md`), `нет роли ${r}`);
  for (const s of AUTO_SKILLS) assert.ok(skillDirs.includes(s), `нет скилла ${s}`);
  for (const d of fs.readdirSync(SKILLS)) {
    assert.ok(fs.existsSync(path.join(SKILLS, d, 'SKILL.md')), `в ${d} нет SKILL.md (имя чувствительно к регистру)`);
  }
});

for (const f of agentFiles) {
  test(`роль ${f}: формат`, () => {
    const text = fs.readFileSync(path.join(AGENTS, f), 'utf8');
    assert.deepEqual(checkAgent(text, f.replace(/\.md$/, '')), []);
  });
}

for (const d of skillDirs) {
  test(`скилл ${d}: формат`, () => {
    const text = fs.readFileSync(path.join(SKILLS, d, 'SKILL.md'), 'utf8');
    assert.deepEqual(checkSkill(text, d), []);
  });
}

// Встроенные мутации: проверка обязана ловить каждую порчу.
const read = (p) => fs.readFileSync(p, 'utf8');

test('мутация: роль без model — ошибка', () => {
  const t = read(path.join(AGENTS, 'ideator.md')).replace(/^model:.*\n/m, '');
  assert.ok(checkAgent(t, 'ideator').some((e) => e.includes('model')));
});

test('мутация: Write у роли-наблюдателя — ошибка', () => {
  for (const r of READ_ONLY) {
    const t = read(path.join(AGENTS, `${r}.md`)).replace(/^tools:\s*(.*)$/m, 'tools: $1, Write');
    assert.ok(checkAgent(t, r).some((e) => e.includes('Write')), r);
  }
});

test('мутация: наблюдатель без tools наследует запись — ошибка', () => {
  const t = read(path.join(AGENTS, 'reviewer.md')).replace(/^tools:.*\n/m, '');
  assert.ok(checkAgent(t, 'reviewer').some((e) => e.includes('tools')));
});

test('мутация: авто-скилл закрыт от модели — ошибка', () => {
  const t = read(path.join(SKILLS, 'prove-blocked', 'SKILL.md'))
    .replace(/^name:.*$/m, '$&\ndisable-model-invocation: true');
  assert.ok(checkSkill(t, 'prove-blocked').some((e) => e.includes('disable-model-invocation')));
});

test('мутация: подчёркивание вместо дефиса, пустой description, битый frontmatter', () => {
  const s = read(path.join(SKILLS, 'ideas', 'SKILL.md'));
  assert.ok(checkSkill(s.replace(/^name:/m, 'disable_model_invocation: true\nname:'), 'ideas').length);
  assert.ok(checkSkill(s.replace(/^description:.*$/m, 'description:'), 'ideas').some((e) => e.includes('description')));
  assert.deepEqual(checkSkill(s.replace(/^---\n/, ''), 'ideas'), ['нет frontmatter между строками ---']);
  assert.ok(checkSkill(s.replace(/^description:.*$/m, `description: ${'я'.repeat(DESC_CAP)}`), 'ideas').length);
});
