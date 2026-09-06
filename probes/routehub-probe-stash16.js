/*
 * RouteHub — ПРОБА STASH ST16. Один вопрос.
 * ===========================================================================
 * ВОПРОС: по какому адресу каждого ИИ-сервиса видно, пустит он нас или нет.
 *
 * ПОЧЕМУ ОНА НУЖНА. ST15 спрашивала `/robots.txt`. Это СТАТИЧЕСКИЙ файл: его
 * отдаёт пограничный сервер, и пускает он почти всех. Приложение живёт по
 * другому адресу и решает отдельно — поэтому Gemini у ST15 почти всегда
 * «работает», хотя в жизни он не работал. Замечание Дианы 06.09 («отказов по
 * Gemini гораздо больше») справедливо, и причина не в сервисе, а в выборе
 * адреса.
 *
 * ЧТО ПОКАЗАЛ ПОЛНЫЙ ОБХОД ПУЛА. Отличить настоящий ответ от страницы отказа
 * можно ТОЛЬКО по телу: `claude.ai` отдавал статус 200 и маркетинговую
 * страницу `websitemain.claude.com` вместо robots.txt. Значит запрос обязан
 * возвращать тело, а тело обязано быть маленьким — иначе прогон стоит
 * мегабайты. Метод HEAD не годится по той же причине: без тела не отличить.
 *
 * ЧТО ДЕЛАЕТ ПРОБА. Берёт ОДИН рабочий узел и опрашивает список
 * АДРЕСОВ-КАНДИДАТОВ, по нескольку на сервис. Для каждого показывает статус,
 * размер тела и его начало. Ничего не решает и не советует: решение
 * принимается по выгрузке, глазами, и уже оно правит список в ST15.
 *
 * ЧЕГО ЖДЁМ ОТ ХОРОШЕГО КАНДИДАТА:
 *   • тело небольшое (сотни байт — десятки килобайт, не сотни);
 *   • ответ ОТЛИЧАЕТСЯ, когда доступ есть и когда его нет, — по статусу или
 *     по узнаваемому куску тела;
 *   • адрес принадлежит хосту, покрытому нашими правилами AI, иначе запрос
 *     уйдёт мимо группы (урок ST15: нейтральный хост уводил на обход).
 * Список кандидатов — ГИПОТЕЗЫ. Часть из них наверняка ответит 404 или
 * потребует ключ; это нормальный результат разведки, а не поломка.
 *
 * ПРАВИЛО 1. Один рабочий узел, обходные исключены по имени; прогон не
 * начинается, если группа сейчас смотрит на обходной узел или молчит о выборе.
 * ПРАВИЛО 2. Только GET, к контроллеру только чтение `/proxies`.
 *
 * ЦЕНА. Один узел, столько запросов, сколько кандидатов. Главные страницы в
 * список включены сознательно — надо увидеть их размер своими глазами, —
 * поэтому прогон стоит порядка мегабайта. Это РАЗОВАЯ разведка: расписание
 * редкое, а после разбора override выключается.
 */

var REV = 'ST16';
var T0 = Date.now();

var BUDGET_MS = 90000;
var GUARD_MS = 75000;
var CTRL_SEC = 5;
var SVC_SEC = 12;
var BODY_KEEP = 220;           // сколько символов начала тела показывать

var POOL_W = 'RH-AI-W';
var POOL_C = 'RH-AI-C';
var PARENTS = ['RH-AI', 'RH-АВТО', 'RH-Звонки'];
var BYPASS = 'Обход';
var SEP = ' · ';

var UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

// Кандидаты. Первый в каждой тройке — то, что ST15 спрашивает сейчас, чтобы
// в одной выгрузке было с чем сравнивать.
var CAND = [
  { s: 'ChatGPT',    u: 'https://chatgpt.com/robots.txt' },
  { s: 'ChatGPT',    u: 'https://chatgpt.com/api/auth/csrf' },
  { s: 'ChatGPT',    u: 'https://chatgpt.com/backend-api/accounts/check' },

  { s: 'Claude',     u: 'https://claude.ai/robots.txt' },
  { s: 'Claude',     u: 'https://claude.ai/api/auth/csrf' },
  { s: 'Claude',     u: 'https://claude.ai/api/organizations' },

  { s: 'Gemini',     u: 'https://gemini.google.com/robots.txt' },
  { s: 'Gemini',     u: 'https://gemini.google.com/app' },
  { s: 'Gemini',     u: 'https://gemini.google.com/_/BardChatUi/data/batchexecute' },

  { s: 'Grok',       u: 'https://grok.com/robots.txt' },
  { s: 'Grok',       u: 'https://grok.com/api/auth/session' },
  { s: 'Grok',       u: 'https://grok.com/rest/app-chat/models' },

  { s: 'Perplexity', u: 'https://www.perplexity.ai/robots.txt' },
  { s: 'Perplexity', u: 'https://www.perplexity.ai/api/auth/session' }
];

var rep = { rev: REV, ts: new Date().toISOString(), ans: {}, err: [] };
var G = (typeof globalThis !== 'undefined') ? globalThis : this;

var CTRL = 'http://127.0.0.1:9090', AUTH = '';
try {
  CTRL = ($environment && $environment['controller-url']) || CTRL;
  AUTH = ($environment && $environment['controller-authorization']) || '';
  rep.ans.stash = ($environment && $environment['stash-version']) || '?';
} catch (e) { rep.err.push('нет $environment'); }
CTRL = String(CTRL).replace(/\/+$/, '');

var FINISHED = false;
function left() { return BUDGET_MS - (Date.now() - T0); }
function isBypass(n) { return String(n).indexOf(BYPASS) >= 0; }
function shortName(n) {
  var s = String(n), i = s.indexOf(SEP);
  return (i >= 0 ? s.slice(0, i) : s).replace(/^\s+|\s+$/g, '');
}
function looksLikeNode(n) { return typeof n === 'string' && n.length >= 5 && n.indexOf('[') >= 0; }
function isGroup(p) {
  if (!p) return false;
  if (p.all || p.All || p.now !== undefined || p.Now !== undefined) return true;
  var t = String((p.type || p.Type) || '').toLowerCase();
  return t === 'selector' || t === 'fallback' || t === 'urltest' || t === 'url-test' ||
    t === 'loadbalance' || t === 'load-balance' || t === 'relay';
}

function ctl(path, cb) {
  var o = { url: CTRL + path, timeout: CTRL_SEC };
  if (AUTH) o.headers = { Authorization: AUTH };
  var done = false;
  function once(b, st, e) { if (done) return; done = true; cb(b, st, e); }
  try {
    G.$httpClient.get(o, function (e, r, body) {
      once(e ? null : body, (r && r.status) || 0, e ? String(e) : null);
    });
  } catch (e2) { once(null, 0, String(e2)); }
}

function through(full, url, cb) {
  var o = {
    url: url, timeout: SVC_SEC,
    headers: {
      'X-Stash-Selected-Proxy': encodeURIComponent(full),
      'User-Agent': UA,
      'Accept': '*/*'
    }
  };
  var t0 = Date.now(), done = false;
  function once(st, body, e) { if (done) return; done = true; cb(st, body, e, Date.now() - t0); }
  try {
    G.$httpClient.get(o, function (e, r, body) {
      once((r && r.status) || 0, body || '', e ? String(e) : null);
    });
  } catch (e2) { once(0, '', String(e2)); }
}

// ── ВЫБОР УЗЛА ───────────────────────────────────────────────────────
var NODE = null, out = [];

function stepPool(next) {
  ctl('/proxies', function (body, st, e) {
    if (!body) { rep.ans.ВЕРДИКТ = 'контроллер не ответил: ' + (e || ('статус ' + st)); next(); return; }
    var d = null;
    try { d = JSON.parse(body); } catch (e2) { rep.ans.ВЕРДИКТ = 'ответ /proxies не разобран'; next(); return; }
    var MAP = (d && (d.proxies || d.Proxies)) || d || {};
    var nets = {}, seenP = 0;
    for (var pi = 0; pi < PARENTS.length; pi++) {
      var pp = MAP[PARENTS[pi]];
      if (!pp) continue;
      seenP++;
      var cur = String(pp.now || pp.Now || ''), tail = cur.slice(-2);
      if (tail === '-W') nets.wifi = 1; else if (tail === '-C') nets.cell = 1; else if (cur) nets.other = 1;
    }
    var ks = []; for (var nk in nets) ks.push(nk);
    var NET = (ks.length === 1 && ks[0] === 'wifi') ? 'wifi' : ((ks.length === 1 && ks[0] === 'cell') ? 'cell' : '');
    if (!NET) { rep.ans.ВЕРДИКТ = 'СЕТЬ НЕ ОПРЕДЕЛЕНА (родителей ' + seenP + ')'; next(); return; }
    rep.ans.сеть = (NET === 'wifi') ? 'Wi-Fi' : 'сотовая';
    var poolName = (NET === 'wifi') ? POOL_W : POOL_C;
    var g = MAP[poolName];
    if (!g) { rep.ans.ВЕРДИКТ = 'группы ' + poolName + ' нет в /proxies'; next(); return; }
    rep.ans.группа = poolName;
    var now = String(g.now || g.Now || '');
    if (!now || isBypass(now)) {
      rep.ans.ВЕРДИКТ = 'НЕ НАЧАЛИ: группа ' + poolName + ' сейчас ' +
        (now ? ('на обходном узле (' + shortName(now) + ')') : 'не сообщила выбранный узел');
      next(); return;
    }
    // Берём узел, который группа выбрала САМА: разведка должна идти по тому
    // пути, по которому реально ходит трафик, а не по случайному члену.
    var p = MAP[now];
    if (!p || isGroup(p) || !looksLikeNode(now)) {
      var members = g.all || g.All || [];
      for (var i = 0; i < members.length && !NODE; i++) {
        var nm = members[i];
        if (isBypass(nm) || !looksLikeNode(nm)) continue;
        var q = MAP[nm];
        if (!q || isGroup(q)) continue;
        NODE = nm;
      }
    } else NODE = now;
    if (!NODE) { rep.ans.ВЕРДИКТ = 'в группе нет ни одного рабочего узла'; next(); return; }
    rep.ans.узел = shortName(NODE);
    next();
  });
}

// ── ОПРОС КАНДИДАТОВ ─────────────────────────────────────────────────
// По одному, а не пачкой: пачка через один узел искажает время, а здесь
// время — часть ответа (тяжёлый адрес виден по нему и по размеру).
function ask(i, next) {
  if (FINISHED || !NODE || i >= CAND.length || left() < 15000) {
    if (NODE && i < CAND.length) rep.ans.не_успели = CAND.length - i;
    next(); return;
  }
  var c = CAND[i];
  through(NODE, c.u, function (st, body, e, ms) {
    var s = String(body || '');
    var rec = { сервис: c.s, адрес: c.u, статус: st, мс: ms, байт: s.length };
    if (e) rec.ошибка = String(e).slice(0, 160);
    if (s.length) rec.начало = s.replace(/\s+/g, ' ').slice(0, BODY_KEEP);
    out.push(rec);
    ask(i + 1, next);
  });
}

// ── ЗАВЕРШЕНИЕ ───────────────────────────────────────────────────────
var GUARD = null;
function finish() {
  if (FINISHED) return;
  FINISHED = true;
  try { clearTimeout(GUARD); } catch (e) {}
  var lines, color = '#FF9F0A';
  try {
    if (!rep.ans.ВЕРДИКТ) {
      var ok = 0, heavy = 0;
      for (var i = 0; i < out.length; i++) {
        if (out[i].статус >= 200 && out[i].статус < 400) ok++;
        if (out[i].байт > 50000) heavy++;
      }
      rep.ans.ВЕРДИКТ = 'опрошено ' + out.length + ' из ' + CAND.length +
        ' адресов, ответили ' + ok + ', тяжёлых (>50 КБ) ' + heavy +
        (rep.ans.не_успели ? ', не успели ' + rep.ans.не_успели : '');
    }
    rep.ans.адреса = out;
    rep.ms = Date.now() - T0;
    lines = [
      rep.ans.ВЕРДИКТ,
      'узел ' + (rep.ans.узел || '?') + ', сеть ' + (rep.ans.сеть || '?') +
        ', группа ' + (rep.ans.группа || '?'),
      'адреса: ' + JSON.stringify(out),
      'Stash ' + (rep.ans.stash || '?') + ', ' + rep.ms + ' мс'
    ];
  } catch (e0) {
    rep.err.push('сборка вывода упала: ' + String(e0));
    lines = ['СБОЙ ПРОБЫ: ' + String(e0)];
    color = '#FF3B30';
  }
  try { console.log('[' + REV + '] ' + JSON.stringify(rep)); } catch (e2) {}
  try {
    $notification.post('RouteHub ' + REV, lines[0], lines.slice(1).join('\n'),
      { clipboard: JSON.stringify(rep) });
  } catch (e3) {}
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'),
            icon: 'magnifyingglass.circle', backgroundColor: color });
  } catch (e4) { try { $done(); } catch (e5) {} }
}

GUARD = setTimeout(function () {
  if (!FINISHED) { rep.err.push('сторож: цепочка не завершилась'); finish(); }
}, GUARD_MS);

stepPool(function () { ask(0, finish); });
// конец файла — хвостовой страж (вывод 49)
