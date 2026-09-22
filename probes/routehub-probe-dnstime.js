/*
 * routehub-probe-dnstime.js — проба L12 «время резолва DNS» (пункт 44)
 * ------------------------------------------------------------------
 * ЗАЧЕМ. Вывод 33: под whitelist из четырёх резолверов `[General]` живы два
 * (`system`, `77.88.8.8`), оба DoH (`cloudflare-dns.com`, `dns.google`)
 * недоступны. Документация Loon (раздел DNS, nsloon.app/en/docs/DNS и
 * docs/ДОКУМЕНТАЦИЯ_LOON_RU.md §8.2, §8.4): если заданы и шифрованные, и
 * обычные серверы, Loon шлёт ТОЛЬКО шифрованные запросы и лишь при их отказе
 * уходит на обычные. Сколько он ждёт отказа DoH — в документации НЕ указано.
 * Эта проба меряет именно это: сколько стоит резолв нового имени сейчас.
 *
 * МЕТОД (косвенный — прямого DNS-API у Loon нет):
 *   T_имя − T_IP. Оба запроса идут node:'DIRECT' на ОДИН И ТОТ ЖЕ сервер:
 *   один по IP, другой по СВЕЖЕМУ имени вида `rh<случайное>-a-b-c-d.nip.io`
 *   (и `.sslip.io`), которое сервис-«зеркало» разрешает в тот же a.b.c.d.
 *   Имя каждый раз новое, поэтому его нет ни в кэше Loon, ни у апстрима:
 *   каждый холодный замер проходит путь DNS целиком. Цель — адрес из
 *   `whitelist-ips.list` (под whitelist жив), берётся первый ответивший.
 *
 * ЧТО МЕРЯЕТ: полное время, за которое DIRECT-исходящий Loon получает адрес
 * для нового имени — попытка DoH, откат на plain, рекурсия апстрима до
 * авторитетных серверов nip.io / sslip.io.
 * ЧЕГО НЕ МЕРЯЕТ:
 *   - раздельно DoH и plain: видна только сумма; «сколько ждали DoH»
 *     получается СРАВНЕНИЕМ прогона под whitelist с прогоном без него;
 *   - резолв по классам доменов (РФ / иностранный / AI): в `[Host]` боевого
 *     конфига нет ни одного `server:`-маппинга, путь DNS у всех имён один,
 *     различается только рекурсия апстрима. Реальные домены повторно не
 *     холодные (кэш), а иностранные под whitelist недостижимы по TCP —
 *     разницу «имя − IP» для них снять нельзя;
 *   - поведение приложений в туннеле (fake-IP, `real-ip`, `hijack-dns`):
 *     меряется исходящий Loon, а не резолвер приложения.
 * ДОПУЩЕНИЕ (не проверено): `$httpClient` с node:'DIRECT' резолвит через
 * DNS-модуль Loon, а не мимо него. Прогон без whitelist это не опровергнет;
 * опровергнет только одинаковый результат под whitelist и без него при
 * мёртвом DoH (тогда метод не видит DoH и выводом служить не может).
 * ШУМ: разница «имя − IP» включает различие ответа сервера на чужой Host.
 * Контроль — повтор уже разрешённого имени (из кэша): он обязан совпасть с
 * T_IP; расхождение > 150 мс помечается «шумно». Везде `Connection: close`
 * и `auto-redirect: false`, чтобы переиспользование соединения и редирект
 * не давали асимметрии.
 *
 * КОНТЕКСТ (без него замер не читается): тот же признак, что у L10 — пять
 * иностранных маяков node:'DIRECT' — плюс иностранный маяк ПО IP
 * (1.1.1.1, его нет в whitelist-ips.list): имена маяков под whitelist сами
 * упираются в DNS, а IP-маяк от DNS не зависит. Российская сторона — цели
 * по IP из whitelist-ips.list. Вердикт по обеим сторонам.
 *
 * ⛔ ОБХОДНЫЕ УЗЛЫ НЕ ИСПОЛЬЗУЮТСЯ: каждый запрос идёт node:'DIRECT', ни
 * одного узла подписки. ⛔ В МАРШРУТИЗАЦИЮ НЕ ПИШЕТ: ни setSelectPolicy,
 * ни setRunningModel, ни $persistentStore — только GET.
 *
 * ХУДШИЙ ЧЕСТНЫЙ ПУТЬ: WORST_MS ниже (60 с); сторож WATCHDOG_MS = 80 с;
 * тайм-аут в манифесте 120 с. Сторож гасит пробу ровно одним $done.
 *
 * ПОДКЛЮЧЕНИЕ: плагин plugins/RouteHub-DNS-L12.plugin (боевой конфиг не
 * трогается). Запускать кнопкой RH-L12 ДВАЖДЫ: без whitelist (база) и под
 * whitelist (замер). Одиночный прогон — не вывод.
 */

var REV = 'L12';

var T_CTX = 3000;      // мс: маяк, IP-маяк, цель — фаза контекста (параллельно)
var T_IP = 3000;       // мс: замер цели по IP
var T_NAME = 6000;     // мс: замер по свежему имени (потолок; выше — «≥»)
var T_DOH = 3000;      // мс: прямая проверка доступности DoH
var N_IP = 4;          // замеров цели по IP
var N_NAMES = 6;       // свежих имён (первый — холодный, отдельно)
var NOISE_MS = 150;    // допуск контроля «повтор имени ≈ IP»

// Худший честный путь: контекст + N_IP + (N_NAMES + 1 повтор) + DoH.
var WORST_MS = T_CTX + N_IP * T_IP + (N_NAMES + 1) * T_NAME + T_DOH;
var WATCHDOG_MS = 80000;

var BEACONS = [
  ['gstatic', 'http://connectivitycheck.gstatic.com/generate_204'],
  ['clients3', 'http://clients3.google.com/generate_204'],
  ['cloudflare', 'http://cp.cloudflare.com/generate_204'],
  ['apple', 'http://captive.apple.com/hotspot-detect.html'],
  ['msft', 'http://www.msftconnecttest.com/connecttest.txt'],
];
var IP_BEACON = ['1.1.1.1', 'http://1.1.1.1/'];

// Цели — адреса из whitelist-ips.list (сверено 22.09): Яндекс DNS и два
// адреса Яндекса. Нужен любой HTTP-ответ, код не важен.
var TARGETS = ['77.88.8.8', '87.250.250.242', '213.180.193.1'];
var MIRRORS = ['nip.io', 'sslip.io'];

var DOH = [
  ['cloudflare-dns.com', 'https://cloudflare-dns.com/dns-query?name=ya.ru&type=A'],
  ['dns.google', 'https://dns.google/resolve?name=ya.ru&type=A'],
];

var rep = { rev: REV, ts: new Date().toISOString(), errors: [] };
var finished = false;

function req(url, timeout, cb) {
  var t0 = Date.now();
  var p = {
    url: url, timeout: timeout, node: 'DIRECT', 'auto-redirect': false,
    headers: { Connection: 'close', 'Cache-Control': 'no-cache' },
  };
  if (url.indexOf('dns-query') >= 0) p.headers.Accept = 'application/dns-json';
  try {
    $httpClient.get(p, function (err, resp) {
      var ms = Date.now() - t0;
      if (err) cb({ ok: false, ms: ms, to: ms >= timeout - 100, err: String(err).slice(0, 60) });
      else cb({ ok: true, ms: ms, status: resp ? resp.status : null });
    });
  } catch (e) {
    cb({ ok: false, ms: Date.now() - t0, to: false, err: 'throw: ' + String(e).slice(0, 50) });
  }
}

function median(a) {
  if (!a.length) return null;
  var s = a.slice().sort(function (x, y) { return x - y; });
  var m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function label(i) {
  return 'rh' + Date.now().toString(36) + i + Math.random().toString(36).slice(2, 6);
}

function fmt(r) { return r.ok ? r.ms + 'мс' : (r.to ? 'таймаут' : 'ошибка ' + r.ms + 'мс'); }

// ---------- шаги ----------

function stepContext(next) {
  var jobs = [];
  BEACONS.forEach(function (b) { jobs.push({ kind: 'b', name: b[0], url: b[1] }); });
  jobs.push({ kind: 'ipb', name: IP_BEACON[0], url: IP_BEACON[1] });
  TARGETS.forEach(function (ip) { jobs.push({ kind: 't', name: ip, url: 'http://' + ip + '/' }); });
  var left = jobs.length;
  rep.beacons = {}; rep.targets_ctx = {};
  jobs.forEach(function (j) {
    req(j.url, T_CTX, function (r) {
      j.r = r;
      if (j.kind === 't') rep.targets_ctx[j.name] = fmt(r);
      else rep.beacons[j.name] = fmt(r);
      if (--left === 0) {
        var bOk = 0, ipbOk = false;
        jobs.forEach(function (x) {
          if (x.kind === 'b' && x.r.ok) bOk++;
          if (x.kind === 'ipb' && x.r.ok) ipbOk = true;
        });
        var target = null;
        for (var i = 0; i < jobs.length; i++) {
          if (jobs[i].kind === 't' && jobs[i].r.ok) { target = jobs[i].name; break; }
        }
        var foreign = bOk + (ipbOk ? 1 : 0);
        rep.target = target;
        rep.foreign_ok = foreign + '/' + (BEACONS.length + 1);
        // Иностранный IP-маяк жив = whitelist точно выключен (от DNS не
        // зависит). Иначе решают маяки по имени, как в L10.
        if (!target && foreign === 0) rep.mode = 'НЕТ ИНТЕРНЕТА';
        else if (!ipbOk && bOk === 0) rep.mode = 'whitelist ВКЛ';
        else if (!ipbOk && bOk <= 1) rep.mode = 'похоже на whitelist';
        else rep.mode = 'whitelist ВЫКЛ';
        if (bOk === 0 && ipbOk) rep.note_ctx = 'маяки по имени мертвы, по IP жив — сбой DNS, а не whitelist';
        next();
      }
    });
  });
}

function stepSeq(n, make, timeout, out, next) {
  var i = 0;
  (function go() {
    if (finished) return;
    if (i >= n) { next(); return; }
    var url = make(i);
    req(url, timeout, function (r) { r.url = url; out.push(r); i++; go(); });
  })();
}

function stepDoh(next) {
  var left = DOH.length;
  rep.doh = {};
  DOH.forEach(function (d) {
    req(d[1], T_DOH, function (r) {
      rep.doh[d[0]] = r.ok ? { ok: true, ms: r.ms, status: r.status } : { ok: false, ms: r.ms, err: r.err };
      if (--left === 0) next();
    });
  });
}

// ---------- сводка ----------

function summarize() {
  // Первый замер по IP холодный (вывод проекта: первый систематически
  // отличается) — база считается без него; первый хранится отдельно.
  var okMs = function (r) { return r.ok; };
  var ipAll = (rep.ip || []).filter(okMs).map(function (r) { return r.ms; });
  var ipRest = (rep.ip || []).slice(1).filter(okMs).map(function (r) { return r.ms; });
  var base = median(ipRest.length ? ipRest : ipAll);
  rep.ip_first = rep.ip && rep.ip[0] && rep.ip[0].ok ? rep.ip[0].ms : null;
  rep.ip_median = base;

  var cold = rep.names || [];
  var est = cold.map(function (r) {
    // Потолок: таймаут — цензурированное значение «≥ T_NAME».
    var ms = r.ok ? r.ms : (r.to ? T_NAME : null);
    return ms === null || base === null ? null : ms - base;
  });
  rep.dns_est = est;
  // Для чтения: быструю ошибку показываем с её временем — отказ резолва
  // через N мс сам по себе данные (например, откат на plain выключен).
  rep.dns_view = cold.map(function (r, i) {
    if (est[i] === null) return 'ош' + r.ms;
    return (!r.ok && r.to ? '≥' : '') + est[i];
  });
  rep.dns_first = est.length ? est[0] : null;
  var rest = est.slice(1).filter(function (x) { return x !== null; });
  rep.dns_median_rest = median(rest);
  rep.names_timeout = cold.filter(function (r) { return !r.ok && r.to; }).length;
  rep.rest_timeout = cold.slice(1).filter(function (r) { return !r.ok && r.to; }).length;
  if (base === null && cold.length) rep.skip = 'цель по IP перестала отвечать — замер не читается';
  rep.names_error = cold.filter(function (r) { return !r.ok && !r.to; }).length;

  if (rep.warm && rep.warm.ok && base !== null) {
    rep.control_delta = rep.warm.ms - base;
    rep.noisy = Math.abs(rep.control_delta) > NOISE_MS;
  }
}

function verdictLine() {
  var v = rep.mode;
  if (rep.doh) {
    var okd = [];
    for (var k in rep.doh) if (rep.doh[k].ok) okd.push(rep.doh[k].ms);
    v += okd.length ? ' · DoH отвечает за ' + median(okd) + ' мс (' + okd.length + '/' + DOH.length + ')'
      : ' · DoH не отвечает (0/' + DOH.length + ')';
  }
  if (rep.dns_first !== null && rep.dns_first !== undefined) {
    var cap = rep.rest_timeout ? '≥' : '';
    var c1 = rep.names[0] && !rep.names[0].ok && rep.names[0].to ? '≥' : '';
    v += ' · резолв: 1-й ' + c1 + rep.dns_first + ' мс, медиана ' +
      (rep.dns_median_rest === null ? '—' : cap + rep.dns_median_rest + ' мс');
  } else if (rep.skip) {
    v += ' · ' + rep.skip;
  }
  return v;
}

function finish(reason) {
  if (finished) return;
  finished = true;
  if (reason) rep.errors.push(reason);
  try { summarize(); } catch (e) { rep.errors.push('summarize: ' + e); }
  var title = 'RouteHub ' + REV + ' — ' + verdictLine();
  var lines = [];
  lines.push('сеть: ' + (rep.net || '?') + ' · иностранное: ' + (rep.foreign_ok || '?') +
    ' · цель: ' + (rep.target || 'нет'));
  if (rep.note_ctx) lines.push('! ' + rep.note_ctx);
  if (rep.ip_median !== undefined && rep.ip_median !== null) lines.push('цель по IP: медиана ' + rep.ip_median + ' мс (1-й ' + (rep.ip_first === null ? '—' : rep.ip_first) + ')');
  if (rep.dns_view && rep.dns_view.length) lines.push('имя − IP, мс: ' + rep.dns_view.join(', '));
  if (rep.names_timeout) lines.push('таймаутов ' + rep.names_timeout + ' (потолок ' + T_NAME + ' мс — реальное время больше)');
  if (rep.names_error) lines.push('ошибок имени ' + rep.names_error + ' — зеркало не разрешилось?');
  if (rep.control_delta !== undefined) {
    lines.push('контроль (повтор имени − IP): ' + rep.control_delta + ' мс' + (rep.noisy ? ' — ШУМНО: повтор не совпал с IP (имя не кэшируется или сервер отвечает по-разному), цифры читать осторожно' : ''));
  }
  if (rep.mode === 'whitelist ВКЛ' && rep.dns_median_rest !== null && rep.dns_median_rest !== undefined) {
    if (rep.dns_median_rest >= 1000) lines.push('похоже на ожидание мёртвого DoH (вывод 33); сравнить с прогоном без whitelist');
    else if (rep.dns_median_rest < 300) lines.push('задержки резолва не видно');
  }
  if (rep.mode !== 'whitelist ВКЛ') lines.push('замер гипотезы — только под whitelist; этот прогон — база');
  if (rep.errors.length) lines.push('ошибки: ' + rep.errors.join('; '));
  try {
    $notification.post(title, lines[0], lines.slice(1).join('\n'), { clipboard: JSON.stringify(rep) });
  } catch (e) {}
  try { console.log('[' + REV + '] ' + title + ' | ' + JSON.stringify(rep)); } catch (e) {}
  $done();
}

// ---------- ход ----------

setTimeout(function () { finish('сторож ' + WATCHDOG_MS + ' мс'); }, WATCHDOG_MS);

try {
  var raw = $config.getConfig();
  var cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
  rep.net = cfg && cfg.ssid ? 'Wi-Fi' : 'сотовая';
} catch (e) { rep.net = '?'; }

stepContext(function () {
  if (finished) return;
  if (!rep.target) {
    rep.skip = rep.mode === 'НЕТ ИНТЕРНЕТА' ? 'замер невозможен' : 'нет цели из whitelist — замер невозможен';
    // Без сети DoH проверять незачем; иначе проверка доступности DoH
    // остаётся полезной и без замера резолва.
    if (rep.mode === 'НЕТ ИНТЕРНЕТА') finish();
    else stepDoh(function () { finish(); });
    return;
  }
  var dashed = rep.target.split('.').join('-');
  var names = [];
  for (var i = 0; i < N_NAMES; i++) names.push(label(i) + '-' + dashed + '.' + MIRRORS[i % MIRRORS.length]);
  rep.ip = []; rep.names = [];
  stepSeq(N_IP, function () { return 'http://' + rep.target + '/'; }, T_IP, rep.ip, function () {
    stepSeq(N_NAMES, function (k) { return 'http://' + names[k] + '/'; }, T_NAME, rep.names, function () {
      // Контроль: повтор первого имени, если оно разрешилось, — из кэша.
      var first = rep.names[0];
      var after = function () { stepDoh(function () { finish(); }); };
      if (!first || !first.ok) { after(); return; }
      req('http://' + names[0] + '/', T_NAME, function (r) {
        if (finished) return;
        rep.warm = r; after();
      });
    });
  });
});
