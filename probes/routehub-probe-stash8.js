/*
 * RouteHub — ПРОБА STASH ST8. Один вопрос, по схеме ST7.
 * ===========================================================================
 * ВОПРОС: доехали ли наши двенадцать `rule-providers` до ядра Stash, и
 * сколько правил в каждом.
 *
 * ПОЧЕМУ ИМЕННО ЭТОТ. Из открытых неизвестностей профиля Stash эта — самая
 * опасная. Stash отбрасывает непонятый набор БЕЗ сообщения: профиль остаётся
 * синтаксически верным, приложение не жалуется, а РКН-whitelist при этом не
 * работает, и банки с госуслугами уходят в обход. По замеру 2026-06-12 это
 * ровно тот сценарий, где включается анти-VPN и «выключите ВПН».
 * Десять наборов из двенадцати лежат в текстовом формате Loon/Shadowrocket
 * (`behavior: classical`, `format: text`), и съест ли его Stash — не
 * проверено ничем, кроме документации.
 *
 * ЧЕМ ЭТО НЕ ЯВЛЯЕТСЯ. Проба НЕ говорит, что правило сработало на конкретном
 * домене, — только что набор загружен и в нём столько-то записей. Пустой или
 * отсутствующий набор — приговор; непустой — ещё не гарантия верной политики.
 *
 * ТОЛЬКО ЧТЕНИЕ. Ни PUT, ни PATCH, ни смены политики, ни обновления наборов:
 * `PUT /providers/rules/{имя}` существует, но это запись, а пробам запись
 * запрещена жёстким правилом 2 проекта.
 *
 * КАК ЗАПУСКАТЬ. Расписанием `cron` — плитка на Stash 3.4.1 нажатием скрипт
 * не запускает (проверено 24.08). Туннель должен быть поднят.
 * Выгрузка уходит двумя путями: в буфер обмена уведомлением и в «Журналы →
 * Журналы сценариев» через console.log — второй канал найден по снимкам
 * интерфейса 25.08 и удобнее для длинного вывода.
 */

var REV = 'ST8';
var T0 = Date.now();
var BUDGET_MS = 8000;                 // настоящие миллисекунды, через Date.now()
var rep = { rev: REV, ts: new Date().toISOString(), ans: {}, err: [] };
var G = (typeof globalThis !== 'undefined') ? globalThis : this;

// Имена ровно те, что кладёт src/clients/stash-sets.js. Держатся списком,
// потому что набор, которого ядро не знает, и набор, который мы неверно
// назвали, снаружи выглядят одинаково.
// 02.09: `rh-refilter` снят (Stash брал его пустым, 81 758 строк), вместо
// него точечные `rh-discord` и `rh-youtube` плюс эксперимент на порог
// `rh-rkn-domains` — тот же список голыми доменами, вдвое меньше по байтам
// при том же числе строк. Его `ruleCount` и есть ответ на вопрос, во что
// упирается Stash: в строки или в объём.
var WANT = [
  'rh-ads', 'rh-ads-domains', 'rh-mylist',
  'rh-wl-domains', 'rh-wl-mobile', 'rh-wl-ips',
  'rh-ru-banks', 'rh-apple', 'rh-banks-cbr',
  'rh-ai-catchall', 'rh-telegram',
  'rh-discord', 'rh-youtube', 'rh-rkn-domains',
];
// Три набора, дающие ЖЁСТКИЙ DIRECT под whitelist. Если не доехали они —
// профиль опасен, остальное неважно.
var CRITICAL = ['rh-wl-domains', 'rh-wl-mobile', 'rh-wl-ips'];

var CTRL = 'http://127.0.0.1:9090', AUTH = '';
try {
  CTRL = ($environment && $environment['controller-url']) || CTRL;
  AUTH = ($environment && $environment['controller-authorization']) || '';
  rep.ans.stash = ($environment && $environment['stash-version']) || '?';
} catch (e) { rep.err.push('нет $environment'); }
CTRL = String(CTRL).replace(/\/+$/, '');

function get(path, cb) {
  var o = { url: CTRL + path, timeout: 3 };
  if (AUTH) o.headers = { Authorization: AUTH };
  var done = false;
  function once(body, e) { if (done) return; done = true; cb(body, e); }
  try {
    G.$httpClient.get(o, function (e, r, body) {
      once(e ? null : body, e ? String(e) : (r && r.status >= 400 ? 'HTTP ' + r.status : null));
    });
  } catch (e2) { once(null, String(e2)); }
}

// Число правил в наборе клиенты называют по-разному; перебираем известные
// имена, а не гадаем одно. `ruleCount` — имя из Clash, `count` и `size` —
// встречались у форков.
function countOf(p) {
  if (!p || typeof p !== 'object') return null;
  var keys = ['ruleCount', 'rule_count', 'count', 'size', 'length'];
  for (var i = 0; i < keys.length; i++) {
    if (typeof p[keys[i]] === 'number') return p[keys[i]];
  }
  if (Array.isArray(p.rules)) return p.rules.length;
  return null;
}

function stepProviders(next) {
  get('/providers/rules', function (body, e) {
    if (e || !body) {
      rep.ans.providers = 'не ответил: ' + (e || 'пусто');
      next();
      return;
    }
    var d = null;
    try { d = JSON.parse(body); } catch (e2) {
      rep.ans.providers = 'не разобрался: ' + String(body).slice(0, 120);
      next();
      return;
    }
    var map = (d && (d.providers || d.Providers)) || d || {};
    var seen = {}, all = [];
    for (var k in map) { seen[k] = map[k]; all.push(k); }
    rep.ans.всего_наборов_у_ядра = all.length;
    rep.ans.чужие = [];
    for (var i = 0; i < all.length; i++) {
      if (WANT.indexOf(all[i]) < 0) rep.ans.чужие.push(all[i]);
    }
    var ok = [], bad = [], empty = [];
    var tab = {};
    for (var j = 0; j < WANT.length; j++) {
      var nm = WANT[j], p = seen[nm];
      if (!p) { bad.push(nm); tab[nm] = 'НЕТ'; continue; }
      var n = countOf(p);
      var beh = p.behavior || p.behaviour || '?';
      tab[nm] = (n === null ? '?' : n) + ' пр., ' + beh;
      if (n === 0) { empty.push(nm); } else { ok.push(nm); }
    }
    rep.ans.наборы = tab;
    rep.ans.доехали = ok.length;
    rep.ans.нет_вовсе = bad;
    rep.ans.пустые = empty;
    // Ключи одной записи — чтобы в следующий раз не гадать, что там лежит.
    if (all.length) {
      try {
        var p0 = seen[all[0]], fields = [];
        for (var f in p0) fields.push(f);
        rep.ans.поля_записи = fields;
      } catch (e3) {}
    }
    var lost = [];
    for (var c = 0; c < CRITICAL.length; c++) {
      if (bad.indexOf(CRITICAL[c]) >= 0 || empty.indexOf(CRITICAL[c]) >= 0) lost.push(CRITICAL[c]);
    }
    rep.ans.ВЕРДИКТ = lost.length
      ? ('ОПАСНО: whitelist не работает, потеряны ' + lost.join(', '))
      : (bad.length || empty.length
        ? ('ЧАСТИЧНО: доехали ' + ok.length + ' из ' + WANT.length)
        : ('ДА, все ' + WANT.length + ' доехали'));
    next();
  });
}

function stepRules(next) {
  // Второй вопрос, дешёвый и независимый: сколько правил видит ядро всего и
  // сколько из них ссылаются на наборы. Отвечает даже если /providers/rules
  // не существует — тогда это единственный признак, что наборы подхвачены.
  get('/rules', function (body, e) {
    if (e || !body) { rep.ans.правил_всего = 'не ответил: ' + (e || 'пусто'); next(); return; }
    var d = null; try { d = JSON.parse(body); } catch (e2) {}
    var list = (d && (d.rules || d.Rules)) || (Array.isArray(d) ? d : []);
    rep.ans.правил_всего = list.length;
    var sets = 0, last = null;
    for (var i = 0; i < list.length; i++) {
      var r = list[i] || {};
      var t = String(r.type || r.Type || '');
      if (t.toUpperCase().indexOf('RULESET') >= 0 || t.toUpperCase().indexOf('RULE-SET') >= 0) sets++;
      last = r;
    }
    rep.ans.правил_RULE_SET = sets;
    if (last) {
      rep.ans.последнее_правило = String(last.type || '?') + ',' +
        String(last.payload || last.Payload || '') + ',' +
        String(last.proxy || last.Proxy || '');
    }
    next();
  });
}

var FINISHED = false;
function finish() {
  if (FINISHED) return;
  FINISHED = true;
  rep.ms = Date.now() - T0;
  var a = rep.ans;
  var lines = [
    'наборы: ' + (a.ВЕРДИКТ || (a.providers || '?')),
    'правил у ядра: ' + (a.правил_всего != null ? a.правил_всего : '?') +
      ', из них RULE-SET ' + (a.правил_RULE_SET != null ? a.правил_RULE_SET : '?'),
    'последнее правило: ' + (a.последнее_правило || '?'),
    'Stash ' + (a.stash || '?') + ', ' + rep.ms + ' мс',
  ];
  console.log('[' + REV + '] ' + JSON.stringify(rep));
  try {
    $notification.post('RouteHub ' + REV, lines[0], lines.slice(1).join('\n'),
      { clipboard: JSON.stringify(rep) });
  } catch (e) {}
  var color = '#8E8E93';
  if (typeof a.ВЕРДИКТ === 'string') {
    if (a.ВЕРДИКТ.indexOf('ДА') === 0) color = '#34C759';
    else if (a.ВЕРДИКТ.indexOf('ЧАСТИЧНО') === 0) color = '#FF9F0A';
    else if (a.ВЕРДИКТ.indexOf('ОПАСНО') === 0) color = '#FF3B30';
  }
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'),
            icon: 'list.bullet.rectangle', backgroundColor: color });
  } catch (e2) { try { $done(); } catch (e3) {} }
}

// Сторож. Номинал делится на 3,6 — во столько раз Stash растягивает таймеры
// по замеру ST5. Точность не нужна: он обязан сработать РАНЬШЕ лимита.
setTimeout(function () {
  if (!FINISHED) { rep.err.push('сторож: бюджет ' + BUDGET_MS + ' мс исчерпан'); finish(); }
}, Math.round(BUDGET_MS / 3.6));

stepProviders(function () { stepRules(finish); });
