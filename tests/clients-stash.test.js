// Тесты клиентского слоя Stash: группы политик (ADR-02, вариант В) и
// развилка клиентов по env.CLIENT (ADR-01).
//
// Что здесь проверяется и почему именно это:
//   * порядок в -W и -C РАЗНЫЙ — ради этого вся схема и затевалась;
//   * ssid-policy с обоими зарезервированными значениями — без них родитель
//     не переключится, а поломка будет молчаливой;
//   * обе формы членства (явные имена и поставщик + filter);
//   * метка узла с обеими метриками;
//   * netwatch в выдаче не появляется — в контур Stash он не переносится;
//   * развилка: без переменной и с мусорным значением работает Loon.

import test from 'node:test';
import assert from 'node:assert/strict';
import { T, worker, req, DE, NL, US, KZ } from './harness.js';
import { makeEnv, nodeLine } from './mock-d1.js';

assert.equal(typeof T.STASH.buildGroups, 'function', 'неймспейс STASH пропал из __test');
assert.equal(typeof T.CLIENTS.pickClient, 'function', 'неймспейс CLIENTS пропал из __test');

const S = T.STASH;

// Подписка: два узла Германии, один Нидерландов, один США, один СНГ,
// игровой и обходной. Метрики подобраны так, чтобы порядок по Wi-Fi и по
// сотовой заведомо не совпал.
const NAMES = {
  de1: '[VPN] ' + DE + ' Германия #1',
  de2: '[VPN] ' + DE + ' Германия #2',
  nl: '[VPN] ' + NL + ' Нидерланды #1',
  us: '[VPN] ' + US + ' США #1',
  kz: '[VPN] ' + KZ + ' Казахстан #1',
  game: '[Игры] ' + DE + ' Германия #9',
  byp: '[Обход] ' + NL + ' Нидерланды #7',
};
const LINES = Object.keys(NAMES).map(function (k) { return nodeLine(NAMES[k]); });

function m(down, rtt, jit, bl) { return { down: down, rtt: rtt, jit: jit, bl: bl }; }
// de1 быстрее по Wi-Fi, de2 — по сотовой: пара -W/-C обязана разойтись.
const STATE = {
  [NAMES.de1]: { w: m(90, 40, 5, 10), c: m(5, 200, 25, 40) },
  [NAMES.de2]: { w: m(10, 150, 20, 40), c: m(80, 35, 4, 8) },
  [NAMES.nl]: { w: m(50, 60, 8, 15), c: m(40, 70, 9, 16) },
  [NAMES.us]: { w: m(70, 90, 10, 20), c: m(60, 95, 11, 22) },
  [NAMES.kz]: { w: m(95, 20, 3, 5), c: m(95, 20, 3, 5) },
  [NAMES.game]: { w: m(30, 50, 6, 12), c: m(30, 50, 6, 12) },
};

function groups(opts) {
  const out = {};
  S.buildGroups(LINES, STATE, opts).forEach(function (g) { out[g.name] = g; });
  return out;
}

test('на каждую функцию три группы: родитель select и пара fallback', () => {
  const list = S.buildGroups(LINES, STATE);
  assert.deepEqual(list.map(function (g) { return g.name; }), [
    'RH-AI', 'RH-AI-W', 'RH-AI-C',
    'RH-АВТО', 'RH-АВТО-W', 'RH-АВТО-C',
    'RH-Звонки', 'RH-Звонки-W', 'RH-Звонки-C',
  ]);
  list.forEach(function (g) {
    assert.equal(g.type, /-[WC]$/.test(g.name) ? 'fallback' : 'select');
  });
});

test('ssid-policy у родителя задан обоими зарезервированными значениями', () => {
  const g = groups();
  ['RH-AI', 'RH-АВТО', 'RH-Звонки'].forEach(function (n) {
    assert.deepEqual(g[n].proxies, [n + '-W', n + '-C']);
    assert.deepEqual(g[n]['ssid-policy'], { cellular: n + '-C', default: n + '-W' });
  });
  // У детей ssid-policy быть не должно: переключает только родитель.
  assert.equal(g['RH-АВТО-W']['ssid-policy'], undefined);
});

test('порядок в -W и -C разный, состав одинаковый', () => {
  const g = groups();
  ['RH-AI', 'RH-АВТО', 'RH-Звонки'].forEach(function (n) {
    const w = g[n + '-W'].proxies, c = g[n + '-C'].proxies;
    assert.deepEqual(w.slice().sort(), c.slice().sort(), n + ': состав пары разошёлся');
    assert.notDeepEqual(w, c, n + ': порядок в -W и -C совпал');
  });
  // Конкретно: по Wi-Fi выше Германия #1, по сотовой — Германия #2.
  const w = g['RH-АВТО-W'].proxies, c = g['RH-АВТО-C'].proxies;
  assert.ok(w[0].indexOf('Германия #1') >= 0, 'Wi-Fi: первым не Германия #1');
  assert.ok(c[0].indexOf('Германия #2') >= 0, 'сотовая: первым не Германия #2');
});

test('каскад RH-АВТО: регион, потом игры, потом обход', () => {
  const p = groups()['RH-АВТО-W'].proxies;
  const at = function (s) { return p.findIndex(function (n) { return n.indexOf(s) >= 0; }); };
  assert.ok(at('Германия') < at('США'), 'Европа должна стоять выше Америки');
  assert.ok(at('США') < at('Казахстан'), 'Америка должна стоять выше СНГ');
  assert.ok(at('Казахстан') < at('[Игры]'), 'СНГ должен стоять выше игровых');
  assert.ok(at('[Игры]') < at('[Обход]'), 'обходной узел должен быть последним');
  assert.equal(p.length, 7, 'в RH-АВТО должны войти все узлы подписки');
});

test('RH-AI: СНГ и игровые исключены, обходной последний', () => {
  const p = groups()['RH-AI-W'].proxies;
  assert.ok(!p.some(function (n) { return n.indexOf('Казахстан') >= 0; }), 'СНГ попал в AI');
  assert.ok(!p.some(function (n) { return n.indexOf('[Игры]') >= 0; }), 'игровой узел попал в AI');
  assert.ok(p[p.length - 1].indexOf('[Обход]') >= 0, 'обходной узел не последний');
  assert.ok(p[0].indexOf('Германия') >= 0, 'тир DE должен открывать каскад AI');
});

test('RH-Звонки: годные для голоса выше остальных', () => {
  const p = groups()['RH-Звонки-W'].proxies;
  const at = function (s) { return p.findIndex(function (n) { return n.indexOf(s) >= 0; }); };
  // Германия #2 по Wi-Fi имеет jit 20 / bl 40 / rtt 150 — голосовой маркер
  // ей не положен, а Нидерландам положен.
  assert.ok(at('Нидерланды #1') < at('Германия #2'), 'узел без ☎ оказался выше годного');
  assert.ok(at('[Обход]') === p.length - 1, 'обходной узел не последний');
});

test('метка узла несёт обе метрики: сначала Wi-Fi, потом сотовая', () => {
  assert.equal(S.nodeLabel('X', m(21, 68), m(7, 96)), 'X · 21↓68 / 7↓96');
  assert.equal(S.nodeLabel('X', { dead: true }, m(7, 96)), 'X · ⛔ / 7↓96');
  assert.equal(S.nodeLabel('X', null, null), 'X', 'без замеров имя должно остаться чистым');
  const p = groups()['RH-АВТО-W'].proxies;
  assert.ok(p.some(function (n) { return n.indexOf(' · 90↓40 / 5↓200') >= 0; }), 'метка не доехала до группы');
  // Обходной узел не тестируется (жёсткое правило 1) — метки у него нет.
  assert.ok(p.some(function (n) { return n === NAMES.byp; }), 'имя обходного узла изменилось');
});

test('метку можно выключить одним флагом', () => {
  const p = S.buildGroups(LINES, STATE, { label: false })
    .find(function (g) { return g.name === 'RH-АВТО-W'; }).proxies;
  assert.ok(p.indexOf(NAMES.de1) >= 0, 'без метки должно остаться голое имя узла');
  assert.ok(!p.some(function (n) { return n.indexOf('↓') >= 0; }), 'метка осталась при label: false');
});

test('форма членства (Б): use + filter вместо явных имён', () => {
  const g = S.buildGroups(LINES, STATE, { membership: 'provider', provider: 'RH-Sub' })
    .find(function (x) { return x.name === 'RH-АВТО-W'; });
  assert.equal(g.proxies, undefined, 'в форме (Б) явных имён быть не должно');
  assert.deepEqual(g.use, ['RH-Sub']);
  const re = new RegExp(g.filter);
  assert.ok(re.test(NAMES.byp), 'filter не ловит имя своего узла');
  assert.ok(!re.test('чужой узел'), 'filter ловит постороннее имя');
  // Спецсимволы имени ([VPN], #) экранируются, а не работают как регексп.
  assert.ok(!re.test('xVPNx Германия #1'), 'скобки имени не экранированы');
});

test('пустой список в форме (Б) не превращается в «все узлы поставщика»', () => {
  const re = new RegExp(S.nameFilter([]));
  assert.ok(!re.test(''), 'пустой filter ловит всё подряд');
  assert.ok(!re.test('любой узел'), 'пустой filter ловит всё подряд');
});

test('renderGroups даёт разбираемый YAML и не содержит netwatch', () => {
  const y = S.renderGroups(LINES, STATE);
  assert.ok(y.startsWith('proxy-groups:\n'), 'нет ключа proxy-groups');
  assert.ok(y.indexOf('netwatch') < 0, 'скрипт-переключатель просочился в выдачу Stash');
  assert.ok(y.indexOf('script') < 0, 'в группах Stash скриптам делать нечего');
  assert.ok(y.indexOf("ssid-policy:") >= 0 && y.indexOf('cellular:') >= 0 && y.indexOf('default:') >= 0);
  assert.equal(S.renderGroups([], {}).indexOf('proxy-groups:\n'), 0);
});

// Управляющий символ в одинарной строке YAML недопустим и порвал бы разбор
// ВСЕГО профиля. Символ строится кодом, а не escape-последовательностью:
// \uXXXX в содержимом файла не переживает JSON-транспорт GitHub API.
test('управляющий символ в имени узла не рвёт YAML профиля', () => {
  const BEL = String.fromCharCode(7);
  const bad = '[VPN] ' + DE + ' Гер' + BEL + 'мания #5';
  const y = S.renderGroups([nodeLine(bad)], {});
  assert.ok(y.indexOf(BEL) < 0, 'управляющий символ доехал до YAML');
  assert.equal(S.buildGroups([nodeLine(bad)], {})[1].proxies[0], '[VPN] ' + DE + ' Гер мания #5');
});

// Граница задокументирована в шапке stash.js: без узлов у детей пустой
// список, а сериализатор пустой массив не выводит — ключа `proxies` в группе
// не будет вовсе. Боевого пути сюда нет (getSub падает, не найдя узлов
// в подписке), но поведение должно быть зафиксировано, а не «известно».
test('без узлов группы остаются, а список членов пуст', () => {
  const g = S.buildGroups([], {}).find(function (x) { return x.name === 'RH-AI-W'; });
  assert.deepEqual(g.proxies, []);
  const y = S.renderGroups([], {});
  assert.ok(y.indexOf("- name: 'RH-AI-W'\n    type: 'fallback'\n  - name:") >= 0,
    'поведение пустой группы изменилось — поправить шапку stash.js');
});

// ── РАЗВИЛКА ПО КЛИЕНТУ (ADR-01) ──────────────────────────────────────

test('без переменной CLIENT активен Loon', () => {
  assert.equal(T.CLIENTS.clientId({}), 'loon');
  assert.equal(T.CLIENTS.clientId(undefined), 'loon');
  assert.equal(T.CLIENTS.pickClient({}).config.renderConfig, T.LOON.renderConfig);
});

test('мусорное значение CLIENT не отключает боевой конфиг, а даёт Loon', () => {
  ['', ' ', 'stach', 'egern', '../loon', '0', 'undefined'].forEach(function (v) {
    assert.equal(T.CLIENTS.clientId({ CLIENT: v }), 'loon', 'значение ' + JSON.stringify(v));
  });
  // __proto__ не должен пролезть через поиск по объекту реестра.
  assert.equal(T.CLIENTS.clientId({ CLIENT: '__proto__' }), 'loon');
});

test('CLIENT=stash выбирает слой Stash, регистр и пробелы не важны', () => {
  ['stash', 'Stash', ' STASH '].forEach(function (v) {
    const c = T.CLIENTS.pickClient({ CLIENT: v });
    assert.equal(c.id, 'stash');
    assert.equal(c.groups.buildGroups, S.buildGroups);
    assert.equal(typeof c.config.renderProfile, 'function', 'слой /config у Stash есть');
  });
});

// Сквозная проверка: та же развилка на живом эндпоинте /config.
const TOKEN = 'a'.repeat(32);
const CONF = ['# RouteHub C-draft-41', 'Lastdep = https://old.invalid/n, udp=true',
  '# __RH_AI_FILTERS__', '# __RH_AI_GROUPS__', '# __RH_MYLIST_URL__'].join('\n');

function envFor(client) {
  return makeEnv({
    sub_cache: { ts: Date.now(), n: 1, text: nodeLine(NAMES.de1), meta: {} },
    devices: { k1: { status: 'bound', token: TOKEN } },
  }, client === undefined ? {} : { CLIENT: client });
}

async function configWith(client) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(CONF, { status: 200 });
  try {
    return await worker.fetch(req('https://w.invalid/t/' + TOKEN + '/config?key=k1'), envFor(client));
  } finally { globalThis.fetch = real; }
}

test('/config без переменной и с мусорным значением отдаёт конфиг Loon', async () => {
  for (const v of [undefined, 'нечто']) {
    const r = await configWith(v);
    assert.equal(r.status, 200, 'значение ' + v);
    const text = await r.text();
    assert.ok(text.indexOf('RH-AI = select, RH-AI-W, RH-AI-C') >= 0, 'группы Loon не собрались');
    assert.ok(text.indexOf('__RH_') < 0, 'плейсхолдеры остались');
  }
});

test('/config при CLIENT=stash отдаёт профиль Stash, а не синтаксис Loon', async () => {
  const r = await configWith('stash');
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(text.indexOf('proxy-groups:') >= 0, 'секции proxy-groups нет');
  assert.ok(text.indexOf('proxies:') >= 0, 'секции proxies нет');
  assert.ok(text.indexOf('RH-AI = select') < 0, 'просочился синтаксис Loon');
  assert.ok(text.indexOf('__RH_') < 0, 'плейсхолдеры остались');
});

// Регрессия: имена в выдаче поставщика и в членах групп обязаны совпадать.
// Если они разойдутся, Stash молча выбросит членов и МАРШРУТИЗАЦИИ НЕ БУДЕТ,
// а профиль при этом останется синтаксически верным — отказ тихий. Проверка
// добавлена после того, как пустые группы были получены живьём на выдаче.
test('имена узлов в /nodes и в членах групп совпадают, списки не пусты', () => {
  const lines = Object.keys(NAMES).map(function (k) { return nodeLine(NAMES[k]); });
  const state = {};
  const yaml = S.renderNodes(lines, state, {});
  const fromNodes = [];
  yaml.split('\n').forEach(function (l) {
    const m = /^\s*-\s+name:\s+'(.*)'\s*$/.exec(l);
    if (m) fromNodes.push(m[1].split("''").join("'"));
  });
  assert.ok(fromNodes.length > 0, 'поставщик отдал пустой список узлов');

  const inGroups = Object.create(null);
  S.buildGroups(lines, state, {}).forEach(function (g) {
    if (!Array.isArray(g.proxies)) return;
    g.proxies.forEach(function (n) { if (n.indexOf('RH-') !== 0) inGroups[n] = true; });
  });
  const members = Object.keys(inGroups);
  assert.ok(members.length > 0, 'все группы оказались пустыми');

  members.forEach(function (n) {
    assert.ok(fromNodes.indexOf(n) >= 0, 'член группы отсутствует в /nodes: ' + n);
  });
});

// ── ЗАМЕР ЗАДЕРЖКИ ЯДРОМ (S-draft-3) ────────────────────────────────
// Правило 1 проекта («обходные узлы не тестировать — платный трафик») до
// S-draft-3 держалось только на дисциплине проб. Но обходные узлы стоят
// членами КАЖДОЙ рабочей группы, а группа с умолчанием interval 600 с гоняет
// замер по всем членам, — то есть профиль тратил бы платный трафик каждые
// десять минут сам, без всяких проб. Теперь правило исполняет само ядро:
// у обходного узла `benchmark-disabled: true`, у остальных — свой адрес
// теста. Тест сторожит обе половины: появление адреса у обходного узла и
// исчезновение его у обычного одинаково означают утечку.
test('обходной узел помечен benchmark-disabled и без адреса теста', () => {
  const yaml = S.renderNodes(LINES, STATE, {});
  const blocks = yaml.split(/\n(?=\s*- name:)/);
  let seenBypass = 0, seenNormal = 0;
  blocks.forEach(function (b) {
    if (b.indexOf('name:') < 0) return;
    const bypass = b.indexOf('Обход') >= 0;
    if (bypass) {
      seenBypass++;
      assert.ok(b.indexOf('benchmark-disabled: true') >= 0,
        'у обходного узла нет benchmark-disabled — ядро будет жечь платный трафик');
      assert.ok(b.indexOf('benchmark-url') < 0,
        'обходному узлу задан адрес теста — замер через него пойдёт');
    } else {
      seenNormal++;
      assert.ok(b.indexOf('benchmark-url:') >= 0, 'у обычного узла нет адреса теста');
      assert.ok(b.indexOf('benchmark-timeout:') >= 0, 'у обычного узла нет тайм-аута теста');
      assert.ok(b.indexOf('benchmark-disabled') < 0,
        'обычному узлу выключили замер — сортировать будет нечем');
    }
  });
  assert.ok(seenBypass > 0, 'в наборе не оказалось обходного узла — тест ничего не проверил');
  assert.ok(seenNormal > 0, 'в наборе не оказалось обычного узла — тест ничего не проверил');
});

// Адрес теста — тот же, что у групп боевого Loon и у спидтеста. Разные
// адреса сделали бы задержку ядра Stash и наш rtt несопоставимыми, а именно
// их сравнение и есть открытый хвост 8.
test('адрес теста узла совпадает с адресом проекта', () => {
  const yaml = S.renderNodes(LINES, STATE, {});
  assert.ok(yaml.indexOf('connectivitycheck.gstatic.com/generate_204') >= 0,
    'у узлов чужой адрес теста');
  assert.ok(yaml.indexOf('cp.cloudflare.com') < 0,
    'вернулся адрес, отбракованный проектом в v1.9.8');
});

// Второй рубеж поверх benchmark-disabled: пока группа обхода не нужна, ядро
// по ней вообще не ходит.
test('группа обхода помечена lazy', () => {
  const groups = T.STASH_PROFILE.profileGroups(LINES, STATE, {});
  const bypass = groups.filter(function (g) { return g.name === 'RH-Обход'; })[0];
  assert.ok(bypass, 'группы RH-Обход нет вовсе');
  assert.equal(bypass.lazy, true, 'у RH-Обход нет lazy — ядро будет её тестировать вхолостую');
});

// ── РЕГРЕССИЯ НА ОТКАЗ, ПОЛУЧЕННЫЙ НА УСТРОЙСТВЕ 31.08 ──────────────
// Stash отверг профиль целиком: «proxy group[0]: '<имя узла>' not found».
// Причина: члены групп были заданы именами, а сами узлы приезжали
// ПОСТАВЩИКОМ, и среди узлов поставщика Stash членов группы не ищет.
// Поставщик при этом работал — карточка подписки в приложении собиралась из
// заголовка subscription-userinfo нашей выдачи /nodes, то есть отказ был не
// в загрузке, а в разрешении имён.
// Тест кодирует ровно это: КАЖДЫЙ член КАЖДОЙ группы обязан разрешаться
// внутри самого профиля — среди его узлов, среди других групп или как
// встроенная политика. Проверка идёт по отрендеренному тексту, а не по
// структурам в памяти, потому что на устройство едет именно текст.
test('каждый член каждой группы разрешается внутри профиля', () => {
  const text = T.STASH_PROFILE.renderConfig(null, {
    key: 'k1', base: 'https://w.invalid/t/T', masterLines: LINES, state: STATE,
  });

  const head = text.split('proxy-groups:')[0];
  const nodes = Object.create(null);
  head.split('\n').forEach(function (l) {
    const m = /^\s*-\s+name:\s+'(.*)'\s*$/.exec(l);
    if (m) nodes[m[1].split("''").join("'")] = true;
  });
  assert.ok(Object.keys(nodes).length > 0, 'в профиле нет ни одного узла');

  const groups = T.STASH_PROFILE.profileGroups(LINES, STATE, {});
  const names = Object.create(null);
  groups.forEach(function (g) { names[g.name] = true; });

  const unresolved = [];
  groups.forEach(function (g) {
    (g.proxies || []).forEach(function (m) {
      if (nodes[m] || names[m] || m === 'DIRECT' || m === 'REJECT') return;
      unresolved.push(g.name + ' -> ' + m);
    });
  });
  assert.deepEqual(unresolved, [],
    'Stash отвергнет профиль: член группы не разрешается внутри него');
});

// Обратная сторона той же правки: пока членство задано именами, поставщика
// прокси в профиле быть НЕ ДОЛЖНО — иначе те же имена приедут из двух
// источников. Форма Б включается явно и возвращает поставщика.
test('форма членства и источник узлов согласованы', () => {
  const byName = T.STASH_PROFILE.renderConfig(null, {
    key: 'k1', base: 'https://w.invalid/t/T', masterLines: LINES, state: STATE,
  });
  assert.ok(byName.indexOf('\nproxies:') >= 0, 'узлов в профиле нет');
  assert.equal(byName.indexOf('proxy-providers:'), -1, 'лишний поставщик при явных именах');

  const byProvider = T.STASH_PROFILE.renderConfig(null, {
    key: 'k1', base: 'https://w.invalid/t/T', masterLines: LINES, state: STATE,
    membership: 'provider',
  });
  assert.ok(byProvider.indexOf('proxy-providers:') >= 0, 'в форме Б пропал поставщик');
  assert.ok(byProvider.indexOf('use:') >= 0, 'в форме Б группы не ссылаются на поставщика');
});
