/*
 * RouteHub — ПРОБА STASH ST12. Сплошная опись среды С ХАРАКТЕРИСТИКАМИ.
 * ===========================================================================
 * ВОПРОС: что УМЕЕТ каждое имя в среде Stash, а не только какие имена есть.
 *
 * ПОЧЕМУ ИМЕННО ЭТОТ. Опись ST1/ST5 сняла 1066 глобальных имён — но это
 * СПИСОК, а не карта: он говорит «имя есть» и молчит про то, функция это или
 * объект, сколько у неё аргументов и что внутри. Половина находок проекта
 * (`$httpClient.globalProxy`, `getSubPolicys` в Loon, порт 13991 в Egern)
 * нашлась именно разглядыванием состава, а не списка имён. Значит стоит
 * пройти по описи ещё раз и снять с каждого имени характеристику.
 *
 * ⛔ НИЧЕГО НЕ ВЫЗЫВАЕТСЯ. Ни одной функции, ни одного метода. Опись идёт
 * ТОЛЬКО чтением свойств, потому что среди 1066 имён заведомо есть пишущие
 * (`PUT /proxies` мы уже знаем, и это лишь один пример), а правило 2 проекта
 * запрещает пробам менять боевую маршрутизацию. Перебор с вызовами — это не
 * разведка, а лотерея. Даже чтение обёрнуто в try: у свойства может стоять
 * геттер с побочным эффектом.
 *
 * ⛔ ЗНАЧЕНИЯ СТРОК НЕ ВЫГРУЖАЮТСЯ, только длина. В среде лежит секрет
 * контроллера (`$environment['controller-authorization']`), и выгрузка
 * уходит в буфер обмена и в журнал. Числа и логические отдаются как есть —
 * они не секретны, а именно они и интересны.
 *
 * ЧТО В ОТЧЁТЕ:
 *   1. Сколько имён всего и сколько из них НЕ стандартные для JS. Стандартные
 *      (Object, Math, JSON…) отсеиваются списком: они известны и место в
 *      выгрузке занимают зря.
 *   2. Подробная опись каждого `$`-объекта: ключи, типы, для функций —
 *      число аргументов. Это главный интерес.
 *   3. Имена, в которых встречается значащее слово (proxy, policy, config,
 *      network, dns, rule, node, traffic, speed, bench, tun, vpn, stash) —
 *      с типом и арностью. Так находки не тонут в тысяче имён.
 *   4. Остальные нестандартные имена — просто списком, с обрезкой.
 *
 * КАК ЗАПУСКАТЬ. Расписанием `cron`, туннель поднят. Выгрузка длинная:
 * читать удобнее в «Журналы → Журналы сценариев», а не из уведомления.
 */

var REV = 'ST12';
var T0 = Date.now();
var BUDGET_MS = 10000;
var LIST_CAP = 160;                   // сколько имён показывать списком

var rep = { rev: REV, ts: new Date().toISOString(), ans: {}, err: [] };
var G = (typeof globalThis !== 'undefined') ? globalThis : this;

try { rep.ans.stash = ($environment && $environment['stash-version']) || '?'; }
catch (e) { rep.err.push('нет $environment'); }

// Стандартные глобали JS. Список нарочно ЩЕДРЫЙ: лучше отсеять лишнее и
// недосчитаться пары известных имён, чем утопить находки в шуме. Если что-то
// отсеялось зря — оно всё равно попадёт в разбор по ключевым словам.
var STD = ('Object Function Array Number Boolean String Symbol Date Promise RegExp Error ' +
  'EvalError RangeError ReferenceError SyntaxError TypeError URIError AggregateError ' +
  'globalThis JSON Math Reflect Proxy Map Set WeakMap WeakSet WeakRef FinalizationRegistry ' +
  'ArrayBuffer SharedArrayBuffer DataView Atomics BigInt BigInt64Array BigUint64Array ' +
  'Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array ' +
  'Float32Array Float64Array Intl eval isFinite isNaN parseFloat parseInt decodeURI ' +
  'decodeURIComponent encodeURI encodeURIComponent escape unescape undefined NaN Infinity ' +
  'setTimeout clearTimeout setInterval clearInterval queueMicrotask console ' +
  'TextEncoder TextDecoder URL URLSearchParams AbortController AbortSignal Event EventTarget ' +
  'crypto performance structuredClone atob btoa fetch Headers Request Response FormData Blob ' +
  'File FileReader ReadableStream WritableStream TransformStream WebSocket XMLHttpRequest ' +
  'localStorage sessionStorage navigator location self window this').split(' ');
var isStd = {};
for (var si = 0; si < STD.length; si++) isStd[STD[si]] = true;

var WORDS = ['proxy', 'policy', 'config', 'network', 'dns', 'rule', 'node',
  'traffic', 'speed', 'bench', 'tun', 'vpn', 'stash', 'script', 'group',
  'delay', 'connect', 'store', 'log'];

// Характеристика значения БЕЗ вызова и без выдачи строк.
function describe(v) {
  var t = typeof v;
  if (v === null) return 'null';
  if (t === 'function') {
    var nm = '';
    try { nm = String(v.name || ''); } catch (e) {}
    var ar = '?';
    try { ar = v.length; } catch (e2) {}
    return 'функция(' + ar + ')' + (nm ? ' ' + nm : '');
  }
  if (t === 'string') return 'строка(' + v.length + ')';
  if (t === 'number' || t === 'boolean') return t + ' ' + String(v);
  if (t === 'object') {
    if (Object.prototype.toString.call(v) === '[object Array]') return 'список[' + v.length + ']';
    var keys = [];
    try { for (var k in v) { keys.push(k); if (keys.length > 40) break; } } catch (e3) {}
    return 'объект{' + keys.join(',') + '}';
  }
  return t;
}

// Опись объекта на один уровень вглубь: ключ -> характеристика.
function inner(o) {
  var out = {};
  try {
    for (var k in o) {
      var v;
      try { v = o[k]; } catch (e) { out[k] = 'чтение упало'; continue; }
      out[k] = describe(v);
    }
  } catch (e2) { out['(перебор упал)'] = String(e2).slice(0, 60); }
  return out;
}

function stepScan(next) {
  var all = [];
  try { for (var k in G) all.push(k); }
  catch (e) { rep.err.push('перебор globalThis упал: ' + String(e).slice(0, 60)); }
  rep.ans.имён_всего = all.length;

  var byType = {}, nonStd = [], dollars = {}, hits = {};
  for (var i = 0; i < all.length; i++) {
    var name = all[i], val;
    try { val = G[name]; } catch (e2) { byType['чтение упало'] = (byType['чтение упало'] || 0) + 1; continue; }
    var t = (val === null) ? 'null' : typeof val;
    byType[t] = (byType[t] || 0) + 1;

    // $-объекты — подробно, это главный интерес.
    if (name.charAt(0) === '$') {
      dollars[name] = (val && typeof val === 'object') ? inner(val) : describe(val);
      continue;
    }
    if (isStd[name]) continue;
    nonStd.push(name);

    var low = name.toLowerCase();
    for (var w = 0; w < WORDS.length; w++) {
      if (low.indexOf(WORDS[w]) >= 0) { hits[name] = describe(val); break; }
    }
  }

  rep.ans.по_типам = byType;
  rep.ans.долларовые = dollars;
  rep.ans.нестандартных = nonStd.length;
  rep.ans.по_ключевым_словам = hits;
  rep.ans.имена = nonStd.slice(0, LIST_CAP);
  if (nonStd.length > LIST_CAP) rep.ans.имена_обрезано = nonStd.length - LIST_CAP;
  next();
}

function verdict() {
  var a = rep.ans;
  var hits = 0;
  for (var k in (a.по_ключевым_словам || {})) hits++;
  var dol = 0;
  for (var d in (a.долларовые || {})) dol++;
  if (!a.имён_всего) return 'НЕ ВЫШЛО: перебор среды ничего не дал';
  return 'ОПИСЬ СНЯТА: имён ' + a.имён_всего + ', нестандартных ' + a.нестандартных +
    ', $-объектов ' + dol + ', по ключевым словам ' + hits;
}

var FINISHED = false;
function finish() {
  if (FINISHED) return;
  FINISHED = true;
  rep.ans.ВЕРДИКТ = verdict();
  rep.ms = Date.now() - T0;
  var a = rep.ans;
  var lines = [
    a.ВЕРДИКТ,
    'по типам: ' + JSON.stringify(a.по_типам || {}),
    'ключевые слова: ' + JSON.stringify(a.по_ключевым_словам || {}).slice(0, 300),
    'Stash ' + (a.stash || '?') + ', ' + rep.ms + ' мс',
  ];
  // Полная опись — в журнал: она длинная, и в уведомление не влезет.
  console.log('[' + REV + '] ' + JSON.stringify(rep));
  try {
    $notification.post('RouteHub ' + REV, lines[0], lines.slice(1).join('\n'),
      { clipboard: JSON.stringify(rep) });
  } catch (e) {}
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'),
            icon: 'list.bullet.indent', backgroundColor: '#0b6bcb' });
  } catch (e2) { try { $done(); } catch (e3) {} }
}

// Сторож. Номинал делится на 3,6 — во столько раз Stash растягивает таймеры
// по замеру ST5. Точность не нужна: он обязан сработать РАНЬШЕ лимита.
setTimeout(function () {
  if (!FINISHED) { rep.err.push('сторож: бюджет ' + BUDGET_MS + ' мс исчерпан'); finish(); }
}, Math.round(BUDGET_MS / 3.6));

stepScan(finish);
