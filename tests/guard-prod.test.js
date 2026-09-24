// Хук-предохранитель правила 5 (`.claude/hooks/guard-prod.js`).
//
// ЗАЧЕМ. Хук — единственное, что заставляет облачную сессию спросить Диану
// перед правкой боевого контура. Если сопоставление путей сломается, правка
// `routehub.conf` или `src/*.js` пройдёт без вопроса, и никто этого не
// заметит до автодеплоя. Тест гоняет скрипт как чёрный ящик — ровно так,
// как его запускает Claude Code: JSON в stdin, решение в stdout, код выхода.
//
// Формат входа и выхода — https://code.claude.com/docs/en/hooks (PreToolUse):
// `tool_input.file_path`, `cwd`, CLAUDE_PROJECT_DIR; решение
// `hookSpecificOutput.permissionDecision`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..', '.claude', 'hooks', 'guard-prod.js');
const ROOT = '/work/routehub';

function run(filePath, { tool = 'Edit', cwd = ROOT, raw } = {}) {
  const input = raw !== undefined ? raw : JSON.stringify({
    session_id: 't',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' },
    tool_use_id: 'toolu_t',
  });
  const r = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
  });
  const out = r.stdout.trim();
  return { code: r.status, out, json: out ? JSON.parse(out) : null };
}

function assertAsk(res) {
  assert.equal(res.code, 0, 'код выхода 0: код 2 заблокировал бы, а нужен вопрос');
  assert.ok(res.json, 'для боевого пути ожидается JSON-решение');
  const h = res.json.hookSpecificOutput;
  assert.equal(h.hookEventName, 'PreToolUse');
  assert.equal(h.permissionDecision, 'ask');
  assert.match(h.permissionDecisionReason, /^Правило 5: правка боевого контура — только с согласия Дианы/);
}

function assertPass(res) {
  assert.equal(res.code, 0);
  assert.equal(res.out, '', 'вне боевого контура хук молчит — обычный порядок разрешений');
}

test('routehub.conf → ask', () => assertAsk(run(`${ROOT}/routehub.conf`)));
test('routehub-worker.js → ask', () => assertAsk(run(`${ROOT}/routehub-worker.js`)));
test('wrangler.toml → ask', () => assertAsk(run(`${ROOT}/wrangler.toml`)));
test('src/api.js → ask', () => assertAsk(run(`${ROOT}/src/api.js`)));
test('src/clients/… (вложенный) → ask', () => assertAsk(run(`${ROOT}/src/clients/x.js`)));
test('scripts/routehub-rkn.js → ask', () => assertAsk(run(`${ROOT}/scripts/routehub-rkn.js`)));
test('plugins/*.plugin → ask', () => assertAsk(run(`${ROOT}/plugins/RouteHub-Dash.plugin`, { tool: 'Write' })));

test('путь с ../ к routehub.conf → ask', () => {
  assertAsk(run(`${ROOT}/tests/../routehub.conf`));
  assertAsk(run(`${ROOT}/docs/../src/api.js`));
});
test('относительный путь → ask (разрешается от корня проекта)', () => {
  assertAsk(run('routehub.conf'));
  assertAsk(run('./tests/../src/api.js'));
});
test('обратные слэши → ask', () => assertAsk(run(`${ROOT}\\src\\api.js`)));
test('рабочее дерево .claude/worktrees/<имя>/ → ask', () => {
  assertAsk(run(`${ROOT}/.claude/worktrees/feat/routehub.conf`));
});
test('рабочее дерево вне корня: путь берётся от cwd (по документации cwd следует за Claude)', () => {
  assertAsk(run('/wt/feat/src/api.js', { cwd: '/wt/feat' }));
});
test('cwd в подкаталоге не мешает: корень берётся из CLAUDE_PROJECT_DIR', () => {
  assertAsk(run(`${ROOT}/src/api.js`, { cwd: `${ROOT}/src` }));
});

test('tests/x.test.js → пропуск', () => assertPass(run(`${ROOT}/tests/x.test.js`)));
test('docs/x.md → пропуск', () => assertPass(run(`${ROOT}/docs/x.md`)));
test('studio, probes, .claude → пропуск', () => {
  assertPass(run(`${ROOT}/studio/tasks/T-x.md`));
  assertPass(run(`${ROOT}/probes/routehub-probe-context.js`));
  assertPass(run(`${ROOT}/.claude/skills/handoff/SKILL.md`));
});
test('похожие имена не путаются с боевыми', () => {
  assertPass(run(`${ROOT}/tests/src/x.js`));
  assertPass(run(`${ROOT}/srcx/a.js`));
  assertPass(run(`${ROOT}/docs/routehub.conf`));
  assertPass(run(`${ROOT}/routehub.conf.bak`));
});
test('файл вне проекта → пропуск', () => assertPass(run('/tmp/other/routehub.conf', { cwd: '/tmp/other2' })));

test('неразобранный вход → ask (безопаснее спросить)', () => assertAsk(run(null, { raw: 'не json' })));
test('вход без file_path → пропуск', () => {
  assertPass(run(null, { raw: JSON.stringify({ tool_name: 'Edit', tool_input: {}, cwd: ROOT }) }));
});
