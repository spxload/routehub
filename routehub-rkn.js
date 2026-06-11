// =============================================================
// routehub-rkn.js v0.1.0 — детект режима сети по доступности узлов.
// Тип: cron (раз в 10 мин). Ловит whitelist РКН в любой момент,
// не только при смене сети (в отличие от netwatch).
//
// Таблица (проба generate_204 через группы):
//   VPN отвечает                      -> normal     (всё работает)
//   VPN молчит, Обход отвечает         -> whitelist  (РКН: основные узлы режут)
//   VPN молчит, Обход молчит           -> block      (полная блокировка)
//   (VPN отвечает, обход не проверяем — норма)
//
// Пробы идут через:
//   RH-Проба-VPN  — fallback ТОЛЬКО из VPN-узлов (без обходного хвоста),
//                   иначе падение VPN маскируется уходом в обход.
//   RH-Обход      — fallback из обходных узлов.
//
// Результат: $persistentStore["rh_rkn"] = {"mode","ts"} и POST на
// Worker /rkn (если задан origin) -> KV rkn:<kN> -> дашборд показывает.
// Пуш при СМЕНЕ режима (не на каждый цикл).
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

// проба через указанную группу: callback(alive bool)
function probe(group, cb) {
  $httpClient.get({ url: TEST_URL, node: group, timeout: 6000 }, function (err, resp) {
    if (err) { cb(false); return; }
    var st = resp && resp.status;
    // generate_204 -> 204; принимаем любой 2xx/3xx как «живой»
    cb(st >= 200 && st < 400);
  });
}

function decide(vpnAlive, bypassAlive) {
  if (vpnAlive) return "normal";
  if (bypassAlive) return "whitelist";
  return "block";
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

function finish(mode) {
  var prev = readPrev();
  var prevMode = prev && prev.mode;
  var rec = { mode: mode, ts: new Date().toISOString() };
  try { $persistentStore.write(JSON.stringify(rec), "rh_rkn"); } catch (e) {}

  // пуш только при смене режима
  if (prevMode && prevMode !== mode) {
    $notification.post("RouteHub", "Сменился режим сети", modeLabel(mode));
  } else if (!prevMode && mode !== "normal") {
    $notification.post("RouteHub", "Режим сети", modeLabel(mode));
  }

  // отправка на Worker (если origin задан и достижим)
  if (ORIGIN && ORIGIN.indexOf("http") === 0) {
    var body = JSON.stringify({ key: KEY, mode: mode, ts: rec.ts });
    $httpClient.post({ url: ORIGIN + "/rkn", timeout: 6000, headers: { "Content-Type": "application/json" }, body: body },
      function () { $done(); });
  } else {
    $done();
  }
}

// сначала пробуем VPN; если жив — норма без проверки обхода
probe(VPN_GROUP, function (vpnAlive) {
  if (vpnAlive) { finish("normal"); return; }
  probe(BYPASS_GROUP, function (bypassAlive) {
    finish(decide(false, bypassAlive));
  });
});
