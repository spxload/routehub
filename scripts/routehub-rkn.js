// =============================================================
// routehub-rkn.js v0.2.1 — детект режима сети по доступности узлов.
// Тип: cron (раз в 10 мин). Ловит whitelist РКН в любой момент.
//
// v0.2.1: + запись в общий журнал rh_runlog (кольцо 50) ПРИ СМЕНЕ режима
//   ({s:'rkn', m:<режим>}); видно во вкладке «История» дашборда.
//   Каждый цикл НЕ пишем — иначе журнал забивается (смотрим только смены).
//
// ФИКС v0.2.0 (было ложное срабатывание на Wi-Fi):
//   * НЕСКОЛЬКО ПРОБ вместо одной. VPN считается живым, если ответила
//     ХОТЯ БЫ ОДНА из PROBES проб (одиночный таймаут/моргание VPN больше
//     не даёт ложный "whitelist").
//   * ПОДТВЕРЖДЕНИЕ: ненормальный режим (whitelist/block) объявляется
//     только если повторился CONFIRM раз подряд. Иначе остаётся normal.
//     Счётчик хранится в rh_rkn (pend/pendN).
//
// ВНИМАНИЕ (T1, 2026-06-12): $httpClient ИГНОРИРУЕТ параметр node на k1.
//   Пробы probeOnce(group) фактически идут НЕ через указанную группу.
//   Детект whitelist работал в полевом тесте Этапа F — механизм требует
//   перепроверки на устройстве (см. ЭТАП_DASH_ПРОГРЕСС.md, открытый вопрос).
//
// Таблица вердикта (после проб):
//   VPN ответил хоть раз            -> normal
//   VPN молчит все пробы, обход жив -> whitelist (после подтверждения)
//   VPN молчит, обход молчит        -> block     (после подтверждения)
//
// Пробы через группы:
//   RH-Проба-VPN  — fallback ТОЛЬКО VPN-узлы (без обходного хвоста).
//   RH-Обход      — fallback обходных узлов.
//
// Результат: $persistentStore["rh_rkn"] = {mode,ts,pend,pendN,hist[]}.
//   hist — последние смены режима (для дашборда). POST на Worker /rkn.
//   Пуш — при СМЕНЕ подтверждённого режима.
//
// argument = "<key>|<origin>" (Worker подставляет: tag=RH-RKN).
// =============================================================

var KEY = "k1", ORIGIN = "";
try {
  var a = (typeof $argument !== "undefined" && $argument) ? String($argument) : "";
  if (a) { var p = a.split("|"); if (p[0]) KEY = p[0]; if (p[1]) ORIGIN = p[1]; }
} catch (e) {}

var TEST_URL = "http://cp.cloudflare.com/generate_204";
var VPN_GROUP = "RH-Проба-VPN";
var BYPASS_GROUP = "RH-Обход";
var PROBES = 3;        // проб на группу
var PROBE_TIMEOUT = 5000;
var CONFIRM = 2;       // подряд циклов для смены на ненормальный режим
var HIST_MAX = 20;     // хранить последних смен режима

var K_RUNLOG = "rh_runlog";
var RUNLOG_MAX = 50;
var GAP_MS = 25 * 60 * 1000;

function readJSON(k, d) { try { var s = $persistentStore.read(k); return s ? JSON.parse(s) : d; } catch (e) { return d; } }
function writeJSON(k, o) { try { $persistentStore.write(JSON.stringify(o), k); } catch (e) {} }

// общий журнал rh_runlog (тот же формат, что у speedtest/netwatch)
function hb(ev) {
  try {
    var lg = readJSON(K_RUNLOG, []);
    if (!Array.isArray(lg)) lg = [];
    var prev = lg.length ? lg[lg.length - 1] : null;
    ev.t = Date.now();
    if (prev && prev.t && (ev.t - prev.t) > GAP_MS) ev.gap = Math.round((ev.t - prev.t) / 60000);
    lg.push(ev);
    if (lg.length > RUNLOG_MAX) lg = lg.slice(-RUNLOG_MAX);
    writeJSON(K_RUNLOG, lg);
  } catch (e) {}
}

// одна проба: callback(alive bool)
function probeOnce(group, cb) {
  $httpClient.get({ url: TEST_URL, node: group, timeout: PROBE_TIMEOUT }, function (err, resp) {
    if (err) { cb(false); return; }
    var st = resp && resp.status;
    cb(st >= 200 && st < 400);
  });
}

// несколько проб: alive, если ответила ХОТЯ БЫ ОДНА. callback(aliveAny bool)
function probeGroup(group, n, cb) {
  var done = 0, any = false;
  function next() {
    if (done >= n) { cb(any); return; }
    probeOnce(group, function (ok) {
      done++;
      if (ok) any = true;
      // ранний выход: VPN жив — дальше не пробуем
      if (any) { cb(true); return; }
      next();
    });
  }
  next();
}

function readPrev() {
  try { var s = $persistentStore.read("rh_rkn"); if (s) return JSON.parse(s); } catch (e) {}
  return null;
}

function modeLabel(m) {
  if (m === "normal") return "Норма — узлы работают";
  if (m === "whitelist") return "Режим РКН (whitelist) — на обходе";
  if (m === "block") return "Полная блокировка";
  return m;
}

// raw — сырой вердикт текущего цикла; применяем гистерезис подтверждения
function finish(raw) {
  var now = new Date().toISOString();
  var prev = readPrev() || {};
  var cur = prev.mode || "normal";       // текущий ПОДТВЕРЖДЁННЫЙ режим
  var pend = prev.pend || null;          // какой ненорм. режим "копится"
  var pendN = prev.pendN || 0;
  var hist = Array.isArray(prev.hist) ? prev.hist : [];

  var confirmed = cur;                   // что станет подтверждённым по итогу

  if (raw === "normal") {
    // норма применяется сразу, копление сбрасывается
    confirmed = "normal";
    pend = null; pendN = 0;
  } else {
    // ненормальный сырой вердикт — копим подтверждение
    if (pend === raw) { pendN++; }
    else { pend = raw; pendN = 1; }
    if (pendN >= CONFIRM) {
      confirmed = raw;       // подтвердилось
    }
    // иначе остаёмся в текущем подтверждённом (обычно normal)
  }

  var changed = confirmed !== cur;
  if (changed) {
    hist.unshift({ mode: confirmed, ts: now });
    if (hist.length > HIST_MAX) hist = hist.slice(0, HIST_MAX);
  }

  var rec = { mode: confirmed, ts: now, pend: pend, pendN: pendN, hist: hist, raw: raw };
  try { $persistentStore.write(JSON.stringify(rec), "rh_rkn"); } catch (e) {}

  if (changed) {
    hb({ s: "rkn", m: confirmed });
    $notification.post("RouteHub", "Сменился режим сети", modeLabel(confirmed));
  }

  if (ORIGIN && ORIGIN.indexOf("http") === 0) {
    var body = JSON.stringify({ key: KEY, mode: confirmed, ts: now, hist: hist });
    $httpClient.post({ url: ORIGIN + "/rkn", timeout: 6000, headers: { "Content-Type": "application/json" }, body: body },
      function () { $done(); });
  } else {
    $done();
  }
}

// цикл: VPN (несколько проб) -> если жив, норма; иначе обход -> вердикт
probeGroup(VPN_GROUP, PROBES, function (vpnAlive) {
  if (vpnAlive) { finish("normal"); return; }
  probeGroup(BYPASS_GROUP, PROBES, function (bypassAlive) {
    finish(bypassAlive ? "whitelist" : "block");
  });
});
