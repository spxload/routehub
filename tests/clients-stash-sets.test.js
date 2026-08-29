// Тесты удалённых наборов правил Stash (clients/stash-sets.js) и их места в
// профиле: секция rule-providers и строки RULE-SET секции rules.
//
// Что здесь проверяется и почему именно это:
//   * ЭТАЛОН БЕРЁТСЯ ИЗ routehub.conf, а не из ожиданий автора теста. Секции
//     [Rule] и [Remote Rule] боевого конфига читаются с диска и сравниваются
//     с выдачей построчно: разойдётся маршрутизация — упадёт тест, а не
//     телефон;
//   * порядок несущий. Первое совпавшее правило побеждает и у Loon, и у
//     Stash, поэтому перестановка строк — это смена поведения;
//   * у каждого набора заданы behavior и format: без них Stash разберёт
//     набор не так, как задумано, и сделает это молча;
//   * RULE-SET ссылается только на существующее имя поставщика;
//   * MATCH ровно один и последний — всё после него недостижимо;
//   * ключей benchmark-* в профиле нет: имена придуманы по аналогии с Clash
//     и документацией Stash не подтверждены.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { T, DE, NL } from './harness.js';
import { nodeLine } from './mock-d1.js';
import { buildRules } from '../src/clients/stash-rules.js';

const CFG = T.CLIENTS.pickClient({ CLIENT: 'stash' }).config;
const CONF = fs.readFileSync(path.join(import.meta.dirname, '..', 'routehub.conf'), 'utf8');

const BASE = 'https://w.invalid/t/' + 'a'.repeat(32);
const LINES = [nodeLine('[VPN] ' + DE + ' Германия #1'), nodeLine('[Обход] ' + NL + ' Нидерланды #7')];
const TEXT = CFG.renderProfile({ key: 'k1', base: BASE, masterLines: LINES, state: {} });

// ── ЭТАЛОН: ЧТО ЛЕЖИТ В БОЕВОМ КОНФИГЕ ──────────────────────────────────
// Секция конфига Loon по имени: строки до следующего заголовка [..].
function confSection(name) {
  const out = [];
  let inside = false;
  CONF.split('\n').forEach(function (raw) {
    const s = raw.trim();
    if (s.charAt(0) === '[' && s.charAt(s.length - 1) === ']') { inside = s === '[' + name + ']'; return; }
    if (inside && s) out.push(s);
  });
  return out;
}

// [Rule]: значащие строки без комментариев, FINAL заменён на MATCH.
const CONF_LOCAL = confSection('Rule')
  .filter(function (s) { return s.charAt(0) !== '#'; })
  .map(function (s) { return s.replace(/^FINAL,/, 'MATCH,'); });

// [Remote Rule]: строки с policy=. Личный список закомментирован (Worker
// подставляет URL вместо плейсхолдера), но он такой же элемент порядка.
const CONF_REMOTE = confSection('Remote Rule')
  .filter(function (s) { return s.indexOf('policy=') >= 0; })
  .map(function (s) {
    const body = s.replace(/^#\s*/, '');
    return { src: body.split(',')[0].trim(), policy: (body.match(/policy=([^,\s]+)/) || [])[1] };
  });

// Соответствие «строка [Remote Rule] -> поставщик правил Stash». Файл,
// откуда берётся набор, у Stash может отличаться от Loon-версии: у
// blackmatrix7 есть родной каталог rule/Clash с .yaml, и берём его.
const EXPECT = [
  { set: 'rh-ads', policy: 'REJECT-DROP', conf: 'Loon/Privacy/Privacy.list',
    url: 'rule/Clash/Privacy/Privacy_No_Resolve.yaml', behavior: 'classical', format: 'yaml' },
  { set: 'rh-ads-domains', policy: 'REJECT-DROP', conf: 'Loon/Privacy/Privacy_Domain.list',
    url: 'rule/Clash/Privacy/Privacy_Domain.yaml', behavior: 'domain', format: 'yaml' },
  { set: 'rh-mylist', policy: 'RH-RU', conf: '__RH_MYLIST_URL__',
    url: BASE + '/mylist?key=k1', behavior: 'classical', format: 'text' },
  { set: 'rh-wl-domains', policy: 'DIRECT', conf: 'lists/whitelist-domains.list',
    url: 'lists/whitelist-domains.list', behavior: 'classical', format: 'text' },
  { set: 'rh-wl-mobile', policy: 'DIRECT', conf: 'lists/hxehex-whitelist.list',
    url: 'lists/hxehex-whitelist.list', behavior: 'classical', format: 'text' },
  { set: 'rh-wl-ips', policy: 'DIRECT', conf: 'lists/whitelist-ips.list',
    url: 'lists/whitelist-ips.list', behavior: 'classical', format: 'text' },
  { set: 'rh-ru-banks', policy: 'RH-RU', conf: 'lists/category-ru.list',
    url: 'lists/category-ru.list', behavior: 'classical', format: 'text' },
  { set: 'rh-apple', policy: 'RH-RU', conf: 'lists/apple.list',
    url: 'lists/apple.list', behavior: 'classical', format: 'text' },
  { set: 'rh-banks-cbr', policy: 'RH-RU', conf: 'rules/domains_banking.list',
    url: 'rules/domains_banking.list', behavior: 'classical', format: 'text' },
  { set: 'rh-ai-catchall', policy: 'RH-AI', conf: 'Loon/OverseasAI/OverseasAI.list',
    url: 'rule/Clash/OverseasAI/OverseasAI.list', behavior: 'classical', format: 'text' },
  { set: 'rh-telegram', policy: 'RH-АВТО', conf: 'Loon/Telegram/Telegram.list',
    url: 'rule/Clash/Telegram/Telegram_No_Resolve.yaml', behavior: 'classical', format: 'yaml' },
  { set: 'rh-refilter', policy: 'RH-АВТО', conf: 'rules/domains_refilter.list',
    url: 'rules/domains_refilter.list', behavior: 'classical', format: 'text' },
];

// ── РАЗБОР ВЫДАЧИ ───────────────────────────────────────────────────────
// Разбирать профиль ГОТОВЫМ парсером здесь нечем: зависимостей у проекта
// нет. Поэтому берётся ровно та раскладка, которую пишет stash-yaml.js:
// ключ верхнего уровня без отступа, элементы списка «  - », поля вложенной
// карты — с отступом 4.
function listOf(key) {
  const lines = TEXT.split('\n');
  const at = lines.indexOf(key + ':');
  assert.ok(at >= 0, 'в профиле нет секции ' + key);
  const out = [];
  for (let i = at + 1; i < lines.length; i++) {
    const m = lines[i].match(/^ {2}- '(.*)'$/);
    if (!m) break;
    out.push(m[1].replace(/''/g, "'"));
  }
  return out;
}

function providersOf() {
  const lines = TEXT.split('\n');
  const at = lines.indexOf('rule-providers:');
  assert.ok(at >= 0, 'в профиле нет секции rule-providers');
  const out = {}, order = [];
  let cur = null;
  for (let i = at + 1; i < lines.length; i++) {
    const head = lines[i].match(/^ {2}([\w-]+):$/);
    if (head) { cur = {}; out[head[1]] = cur; order.push(head[1]); continue; }
    const field = lines[i].match(/^ {4}([\w-]+): (.*)$/);
    if (field && cur) {
      const v = field[2];
      cur[field[1]] = v.charAt(0) === "'" ? v.slice(1, -1).replace(/''/g, "'") : Number(v);
      continue;
    }
    break;
  }
  return { map: out, order: order };
}

const RULES = listOf('rules');
const PROV = providersOf();
const SETRULES = RULES.filter(function (r) { return r.indexOf('RULE-SET,') === 0; });

// ── ТЕСТЫ ───────────────────────────────────────────────────────────────

test('эталон читается: в боевом конфиге 24 локальных правила и 12 удалённых наборов', () => {
  assert.equal(CONF_LOCAL.length, 24, '[Rule] боевого конфига изменилась — сверить перенос');
  assert.equal(CONF_REMOTE.length, EXPECT.length, '[Remote Rule] боевого конфига изменилась');
  CONF_REMOTE.forEach(function (r, i) {
    assert.ok(r.src.indexOf(EXPECT[i].conf) >= 0, 'строка ' + i + ' [Remote Rule]: ' + r.src);
    assert.equal(r.policy, EXPECT[i].policy, 'политика строки ' + i);
  });
});

test('все одиннадцать наборов и личный список есть в rule-providers, порядок как в [Remote Rule]', () => {
  assert.equal(PROV.order.length, EXPECT.length);
  assert.deepEqual(PROV.order, EXPECT.map(function (e) { return e.set; }));
});

test('у каждого набора заданы behavior и format, и оба из допустимых значений', () => {
  const BEH = ['domain', 'ipcidr', 'classical'], FMT = ['yaml', 'text'];
  EXPECT.forEach(function (e) {
    const p = PROV.map[e.set];
    assert.ok(p, 'нет поставщика ' + e.set);
    assert.ok(BEH.indexOf(p.behavior) >= 0, e.set + ': behavior ' + p.behavior);
    assert.ok(FMT.indexOf(p.format) >= 0, e.set + ': format ' + p.format);
    assert.equal(p.behavior, e.behavior, e.set + ': behavior');
    assert.equal(p.format, e.format, e.set + ': format');
    // Ключи ровно документированные: url, path, interval, behavior, format.
    assert.deepEqual(Object.keys(p).sort(), ['behavior', 'format', 'interval', 'path', 'url'], e.set);
  });
});

test('URL набора ведёт туда, куда решено, а расширение пути следует формату', () => {
  EXPECT.forEach(function (e) {
    const p = PROV.map[e.set];
    assert.ok(p.url.indexOf(e.url) >= 0, e.set + ': url ' + p.url);
    assert.equal(p.path, './rules/' + e.set + (e.format === 'yaml' ? '.yaml' : '.list'), e.set + ': path');
  });
});

test('личный список берёт URL из base и key, как в Loon', () => {
  assert.equal(PROV.map['rh-mylist'].url, BASE + '/mylist?key=k1');
  const other = CFG.renderProfile({ key: 'k3', base: 'https://x.invalid/t/b', masterLines: LINES, state: {} });
  assert.ok(other.indexOf("url: 'https://x.invalid/t/b/mylist?key=k3'") >= 0, 'URL не пересобрался под ключ');
});

test('интервал обновления: сутки у внешних наборов, 60 с у личного списка', () => {
  EXPECT.forEach(function (e) {
    assert.equal(PROV.map[e.set].interval, e.set === 'rh-mylist' ? 60 : 86400, e.set);
  });
});

test('локальные правила профиля построчно повторяют [Rule] боевого конфига', () => {
  assert.deepEqual(RULES.filter(function (r) { return r.indexOf('RULE-SET,') < 0; }), CONF_LOCAL);
});

test('наборы стоят ниже всех локальных правил и выше MATCH — как [Remote Rule] после [Rule]', () => {
  const first = RULES.findIndex(function (r) { return r.indexOf('RULE-SET,') === 0; });
  const last = RULES.length - 1 - RULES.slice().reverse().findIndex(function (r) { return r.indexOf('RULE-SET,') === 0; });
  assert.equal(first, CONF_LOCAL.length - 1, 'наборы начались не там, где кончились локальные правила');
  assert.equal(last, RULES.length - 2, 'между последним набором и MATCH что-то вклинилось');
  assert.deepEqual(SETRULES, EXPECT.map(function (e) { return 'RULE-SET,' + e.set + ',' + e.policy; }));
});

test('RULE-SET ссылается только на существующее имя поставщика', () => {
  assert.equal(SETRULES.length, EXPECT.length);
  SETRULES.forEach(function (r) {
    const parts = r.split(',');
    assert.ok(Object.prototype.hasOwnProperty.call(PROV.map, parts[1]), 'нет поставщика ' + parts[1]);
    assert.ok(parts.length === 3, 'у classical/domain-набора no-resolve не ставится: ' + r);
  });
});

test('MATCH ровно один и последний', () => {
  assert.equal(RULES.filter(function (r) { return r.indexOf('MATCH,') === 0; }).length, 1);
  assert.equal(RULES[RULES.length - 1], 'MATCH,RH-Главный');
});

test('без аргумента buildRules наборов не добавляет — RULE-SET не встроен в правила', () => {
  const bare = buildRules();
  assert.deepEqual(bare, CONF_LOCAL);
  assert.equal(bare.filter(function (r) { return r.indexOf('RULE-SET,') === 0; }).length, 0);
});

test('ключей benchmark-* в профиле больше нет', () => {
  assert.equal(TEXT.indexOf('benchmark'), -1, 'benchmark-* вернулись в выдачу');
  const prox = TEXT.split('proxy-providers:')[1].split('rule-providers:')[0];
  assert.deepEqual(prox.match(/^ {4}([\w-]+):/gm).map(function (s) { return s.trim(); }),
    ['url:', 'path:', 'interval:'], 'у поставщика прокси лишний ключ');
});
