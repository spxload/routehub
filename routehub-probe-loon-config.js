// RouteHub — ПРОБА LOON. Ревизия L8: что на самом деле отдаёт $config и $loon.
// ОСНОВАНИЕ (L7, 2026-08-12):
//   — локального контроллера у Loon НЕТ (9 портов, все ECONNREFUSED);
//   — `$environment` в Loon ОТСУТСТВУЕТ;
//   — но `getConfig()` отдаёт ключи `all_buildin_nodes` и `all_policy_groups`,
//     а в СТАРТ.md записано, что список узлов оттуда не достать;
//   — есть неописанный объект `$loon`, чьи члены ни разу не описывались.
//
// ЗАДАЧА: узнать, может ли скрипт САМ видеть все узлы и группы. Если да —
// отпадает главный костыль RouteHub: управление выбором через порядок
// узлов, который задаёт Worker.
//
// ТОЛЬКО ЧТЕНИЕ. НИ ОДНОГО вызова setSelectPolicy, setPluginEnable,
// setScriptEnable, setRunningModel. Боевая маршрутизация не трогается.
//
// ТИП: generic — запуск вручную. ОТЧЁТ: буфер обмена + консоль.
// Отчёт может быть крупным (69+ узлов): имена выводятся целиком,
// структура — только на трёх первых образцах.

var REV = 'L8';
var G = (typeof globalThis !== 'undefined') ? globalThis : this;
var T0 = Date.now();
var rep = { rev: REV, ts: new Date().toISOString(), steps: {}, errors: [] };

function has(n) { try { return typeof G[n]; } catch (e) { return 'error'; } }
function safe(name, fn) {
  var t = Date.now();
  try { rep.steps[name] = fn(); }
  catch (e) { rep.errors.push(name + ': ' + String((e && e.message) || e)); }
  rep.steps['_ms_' + name] = Date.now() - t;
}
function shape(v, depth) {
  // Краткое описание значения без вываливания всего содержимого.
  var t = Object.prototype.toString.call(v);
  if (v === null || v === undefined) return String(v);
  if (t === '[object Array]') {
    return { array: true, length: v.length, sample: v.slice(0, 3).map(function (x) { return (depth > 0) ? shape(x, depth - 1) : typeof x; }) };
  }
  if (typeof v === 'object') {
    var k = [];
    try { k = Object.keys(v).sort(); } catch (e) {}
    return { object: true, keys: k.slice(0, 30), count: k.length };
  }
  var s = String(v);
  return (s.length > 120) ? (s.slice(0, 120) + '\u2026[' + s.length + ']') : s;
}

// ШАГ 1. Опись $loon — ни разу не делалась.
safe('loon_object', function () {
  var t = has('$loon');
  if (t === 'undefined') return { available: false };
  var r = { available: true, type: t, members: {} };
  try {
    var o = G.$loon, m = Object.getOwnPropertyNames(o);
    try {
      var pp = Object.getPrototypeOf(o);
      if (pp && pp !== Object.prototype) m = m.concat(Object.getOwnPropertyNames(pp));
    } catch (e) {}
    m.sort();
    r.names = m;
    for (var i = 0; i < m.length && i < 60; i++) {
      try { r.members[m[i]] = (typeof o[m[i]] === 'function') ? 'function' : shape(o[m[i]], 1); }
      catch (e) { r.members[m[i]] = 'error'; }
    }
  } catch (e) { r.error = String(e); }
  return r;
});

// ШАГ 2. getConfig() целиком — структура каждого ключа.
var CFG = null;
safe('config_shape', function () {
  if (has('$config') === 'undefined') return { available: false };
  var raw = G.$config.getConfig();
  var o = (typeof raw === 'string') ? JSON.parse(raw) : raw;
  CFG = o;
  var keys = Object.keys(o).sort(), r = { raw_type: typeof raw, raw_len: String(raw).length, keys: keys, shapes: {} };
  for (var i = 0; i < keys.length; i++) r.shapes[keys[i]] = shape(o[keys[i]], 2);
  return r;
});

// ШАГ 3. ГЛАВНОЕ: список узлов целиком.
safe('nodes', function () {
  if (!CFG) return { skipped: 'нет выдачи getConfig' };
  var n = CFG.all_buildin_nodes;
  if (!n) return { present: false };
  var r = { present: true, shape: shape(n, 2) };
  try {
    if (Object.prototype.toString.call(n) === '[object Array]') {
      r.count = n.length;
      r.names = n.map(function (x) {
        if (typeof x === 'string') return x;
        return (x && (x.name || x.title || x.node)) || JSON.stringify(x).slice(0, 80);
      });
      r.first_full = JSON.stringify(n[0]).slice(0, 400);
    } else {
      var k = Object.keys(n);
      r.count = k.length;
      r.names = k;
      r.first_full = JSON.stringify(n[k[0]]).slice(0, 400);
    }
  } catch (e) { r.error = String(e); }
  return r;
});

// ШАГ 4. Список групп и текущий выбор.
safe('groups', function () {
  if (!CFG) return { skipped: 'нет выдачи getConfig' };
  return {
    all_policy_groups: shape(CFG.all_policy_groups, 2),
    groups_dump: JSON.stringify(CFG.all_policy_groups).slice(0, 1500),
    policy_select: JSON.stringify(CFG.policy_select).slice(0, 1500),
    final: CFG.final,
    global_proxy: CFG.global_proxy,
    running_model: CFG.running_model,
    ssid: CFG.ssid
  };
});

// ШАГ 5. Чтение отдельной группы тремя методами — что каждый даёт.
// Группа берётся первая из policy_select — имён не выдумываем.
safe('policy_read', function () {
  if (!CFG || has('$config') === 'undefined') return { skipped: true };
  var name = null;
  try {
    var ps = CFG.policy_select;
    if (ps && typeof ps === 'object') name = Object.keys(ps)[0];
  } catch (e) {}
  if (!name) return { skipped: 'не нашлось имени группы' };
  var r = { group: name };
  try { r.getPolicy = shape(G.$config.getPolicy(name), 2); } catch (e) { r.getPolicy_err = String(e); }
  try { r.getSelectedPolicy = shape(G.$config.getSelectedPolicy(name), 2); } catch (e) { r.getSelectedPolicy_err = String(e); }
  try { r.getSubPolicies = shape(G.$config.getSubPolicies(name), 2); } catch (e) { r.getSubPolicies_err = String(e); }
  try { r.getSubPolicys = shape(G.$config.getSubPolicys(name), 2); } catch (e) { r.getSubPolicys_err = String(e); }
  return r;
});

// ШАГ 6. Повторяемость таймеров — серия, а не один замер.
// По требованию: одиночное измерение ничего не доказывает.
var timings = [];
function timerSeries(i, cb) {
  if (i >= 6) { cb(); return; }
  var want = [0, 50, 200, 500, 1000, 2000][i];
  var t = Date.now();
  setTimeout(function () {
    timings.push({ want: want, got: Date.now() - t });
    timerSeries(i + 1, cb);
  }, want);
}

function perfSeries() {
  var runs = [];
  for (var k = 0; k < 5; k++) {
    var t = Date.now(), s = 0;
    for (var i = 0; i < 1000000; i++) s += i;
    runs.push(Date.now() - t);
  }
  var rest = runs.slice(1).sort(function (a, b) { return a - b; });
  return { runs: runs, median_wo_first: rest[Math.floor(rest.length / 2)] };
}

function finish() {
  rep.steps.timers = { series: timings };
  var got = timings.map(function (x) { return x.got - x.want; }).sort(function (a, b) { return a - b; });
  rep.steps.timers.drift_median_ms = got.length ? got[Math.floor(got.length / 2)] : null;
  rep.steps.perf = perfSeries();
  rep.total_ms = Date.now() - T0;
  var body = JSON.stringify(rep);
  try { console.log('[RH-' + REV + '] ' + body); } catch (e) {}
  var nd = rep.steps.nodes || {};
  var line = '\u0443\u0437\u043b\u043e\u0432: ' + (nd.count !== undefined ? nd.count : '\u2014') +
    ' \u00b7 $loon: ' + ((rep.steps.loon_object && rep.steps.loon_object.names) ? rep.steps.loon_object.names.length : '\u2014') +
    ' \u00b7 \u0434\u0440\u0435\u0439\u0444 \u0442\u0430\u0439\u043c\u0435\u0440\u043e\u0432 ' + rep.steps.timers.drift_median_ms + ' \u043c\u0441';
  try {
    G.$notification.post('RouteHub ' + REV, line, '\u043e\u0442\u0447\u0451\u0442 \u0432 \u0431\u0443\u0444\u0435\u0440\u0435 \u043e\u0431\u043c\u0435\u043d\u0430', { 'clipboard': body });
  } catch (e) {
    try { G.$notification.post('RouteHub ' + REV, line, '\u0441\u043c. \u043a\u043e\u043d\u0441\u043e\u043b\u044c'); } catch (e2) {}
  }
  try { G.$done({}); } catch (e) {}
}

timerSeries(0, finish);
// конец файла
