// =============================================================
// routehub-viewer.js — RouteHub, ручной просмотр метрик узлов (Этап E/H)
var VERSION = 'viewer v0.6.2 (2026-06-10)';
//
// Тип: generic (запуск ВРУЧНУЮ из Loon). Читает rh_speed_wifi/rh_speed_cell,
//   считает ТОТ ЖЕ балл, что Worker (задержка = med, фолбэк rtt):
//     - console.log: таблица (балл/скорость+%/rtt/med/jit/bl/дата скорости +
//       возраст пинга «п:»);
//     - ИСТОРИЯ ЗАПУСКОВ (rh_runlog): cron/net/свип, разрывы >25 мин;
//     - $notification: сводка.
//   v0.6.2: возраст пинг-свипа (tsp) в таблице; свип в истории. Синхронно с
//   Worker/speedtest — меняешь там, меняй тут.
//
// Метрики: down(Мбит/с, кэш 24ч), rtt(мин из 3), med(медиана — балл по ней),
//   jit, bl. med/rtt/jit обновляются пинг-свипом (~каждые 20 мин). Цель пинга —
//   cp.cloudflare.com/generate_204 (как у групп Loon); скорость — speed.cloudflare.com.
// =============================================================

var SCORE_WS = 0.40, SCORE_WR = 0.30, SCORE_WJ = 0.20, SCORE_WB = 0.10;
var FLOOR_RTT = 30, FLOOR_JIT = 10, FLOOR_BL = 20;
var MAX_FAILS = 5;
var BLK = ['\u2581', '\u2583', '\u2585', '\u2587', '\u2588']; // ▁▃▅▇█
var SUP_PLUS = '\u207A';
var K_RUNLOG = 'rh_runlog';

function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
function readJSON(key) { try { var s = $persistentStore.read(key); return s ? JSON.parse(s) : {}; } catch (e) { return {}; } }
function isDead(e) { return (e.fails || 0) >= MAX_FAILS; }
function speedBlock(d) {
  if (d < 1) return BLK[0]; if (d < 2) return BLK[1]; if (d < 5) return BLK[2];
  if (d < 15) return BLK[3]; if (d < 25) return BLK[4]; return BLK[4] + SUP_PLUS;
}
function scoreOf(m, maxDown) {
  if (isDead(m)) return -1;
  var sN = maxDown > 0 ? clamp01((+m.down || 0) / maxDown) : 0;
  var lat = (m.med != null) ? (+m.med || 0) : (+m.rtt || 0);
  var rN = clamp01(FLOOR_RTT / Math.max(lat, FLOOR_RTT));
  var jit = (m.jit == null) ? null : (+m.jit || 0);
  var jN = (jit == null) ? 1 : clamp01(FLOOR_JIT / Math.max(jit, FLOOR_JIT));
  if (m.bl == null) {
    var tot = SCORE_WS + SCORE_WR + SCORE_WJ;
    return (SCORE_WS * sN + SCORE_WR * rN + SCORE_WJ * jN) / tot;
  }
  var bl = +m.bl || 0;
  var bN = clamp01(FLOOR_BL / Math.max(bl, FLOOR_BL));
  return SCORE_WS * sN + SCORE_WR * rN + SCORE_WJ * jN + SCORE_WB * bN;
}

function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
function padL(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }
function two(n) { return n < 10 ? '0' + n : '' + n; }
function fmtDate(ts) { if (!ts) return '\u2014'; var d = new Date(ts); return two(d.getDate()) + '.' + two(d.getMonth() + 1) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes()); }
function fmtAge(ts) {
  if (!ts) return '\u2014';
  var s = Math.floor((Date.now() - ts) / 1000);
  if (s < 3600) return Math.floor(s / 60) + '\u043C';
  if (s < 86400) return Math.floor(s / 3600) + '\u0447';
  return Math.floor(s / 86400) + '\u0434';
}
function shortName(n) { return String(n).replace(/^\[Lastdep\]\s*/, ''); }

function buildBlock(cache, title) {
  var rows = [], maxDown = 0;
  for (var nm in cache) {
    if (!cache.hasOwnProperty(nm)) continue;
    var e = cache[nm];
    if (!isDead(e) && (+e.down || 0) > maxDown) maxDown = +e.down || 0;
    rows.push({ name: nm, e: e });
  }
  for (var i = 0; i < rows.length; i++) rows[i].score = isDead(rows[i].e) ? -1 : scoreOf(rows[i].e, maxDown);
  rows.sort(function (a, b) { return b.score - a.score; });

  var lines = [];
  lines.push('===== ' + title + ' =====  (узлов: ' + rows.length + ', макс ' + maxDown + ' \u041C\u0431\u0438\u0442/\u0441)');
  lines.push(' #  балл |  скорость   | rtt | med | jit |  bl | скорость обн. | пинг | узел');
  var tested = 0, deadN = 0, newest = 0, oldest = 0, best = null;
  for (var j = 0; j < rows.length; j++) {
    var r = rows[j], en = r.e;
    if (isDead(en)) {
      deadN++;
      lines.push(padL(j + 1, 2) + ' \u26D4DEAD fails=' + (en.fails || 0) + '  ' + fmtDate(en.ts) + ' (' + fmtAge(en.ts) + ')  ' + shortName(r.name));
      continue;
    }
    tested++;
    if (en.ts) { if (!newest || en.ts > newest) newest = en.ts; if (!oldest || en.ts < oldest) oldest = en.ts; }
    if (!best || r.score > best.score) best = r;
    var pct = maxDown > 0 ? Math.round(en.down / maxDown * 100) : 0;
    var sc = Math.round(r.score * 100);
    lines.push(
      padL(j + 1, 2) + '  ' +
      padL(sc, 3) + ' | ' +
      padL(en.down, 4) + '\u041C\u0431 ' + speedBlock(en.down) + padL(pct, 3) + '% | ' +
      padL(en.rtt, 3) + ' | ' +
      padL(en.med == null ? '-' : en.med, 3) + ' | ' +
      padL(en.jit == null ? '-' : en.jit, 3) + ' | ' +
      padL(en.bl == null ? '-' : en.bl, 3) + ' | ' +
      pad(fmtDate(en.ts) + ' (' + fmtAge(en.ts) + ')', 14) + ' | ' +
      padL(en.tsp ? fmtAge(en.tsp) : '\u2014', 4) + ' | ' +
      shortName(r.name)
    );
  }
  return { lines: lines, tested: tested, dead: deadN, newest: newest, oldest: oldest, best: best, title: title };
}

function buildHistory() {
  var lg = readJSON(K_RUNLOG);
  if (!Array.isArray(lg) || !lg.length) return ['===== ИСТОРИЯ ЗАПУСКОВ =====', 'Журнал пуст (rh_runlog). Появится после первых срабатываний RH-Speed/RH-Net.'];
  var lines = ['===== ИСТОРИЯ ЗАПУСКОВ ===== (последние ' + lg.length + ', разрыв >25 мин помечен)'];
  var gaps = 0;
  for (var i = lg.length - 1; i >= 0; i--) {
    var e = lg[i];
    var src = (e.s === 'net') ? '\uD83D\uDCF6 net ' : '\u23F0 cron';
    var parts = [fmtDate(e.t), src, pad(e.n || '?', 4)];
    if (e.s === 'cron') {
      if (e.x) parts.push('-> ' + e.x);
      else {
        var d = 'пул=' + (e.p == null ? '?' : e.p) + ' нужно=' + (e.d == null ? '?' : e.d) + ' ок=' + (e.m == null ? '?' : e.m) + ' сбой=' + (e.f == null ? '?' : e.f);
        if (e.sw != null) d += ' свип=' + e.sw;
        if (e.c) d += ' ДОГОН';
        parts.push(d);
      }
    } else {
      if (e.w) parts.push('WHITELIST');
      if (e.o) parts.push(e.o);
    }
    if (e.gap) { parts.push('\u26A0 РАЗРЫВ ' + e.gap + ' мин до этого'); gaps++; }
    lines.push(parts.join('  '));
  }
  lines.push(gaps ? ('\u26A0 Разрывов: ' + gaps + ' (Loon/VPN не работал или iOS усыпил расширение)') : 'Разрывов нет — расписание шло непрерывно.');
  return lines;
}

function main() {
  var wifi = readJSON('rh_speed_wifi');
  var cell = readJSON('rh_speed_cell');
  var hasW = Object.keys(wifi).length > 0;
  var hasC = Object.keys(cell).length > 0;

  var head = [];
  head.push('RouteHub viewer \u2014 ' + VERSION);
  head.push('БАЛЛ: нормировка 0..1, веса down 0.40 / задержка 0.30 / jit 0.20 / bl 0.10.');
  head.push('Задержка для балла = med; rtt (min) — для метки \u2193. med/rtt/jit обновляются пинг-свипом (~20 мин), скорость — раз в 24ч.');
  head.push('Floor: rtt ' + FLOOR_RTT + ' / jit ' + FLOOR_JIT + ' / bl ' + FLOOR_BL + ' мс. Балл 0..100, выше = лучше \u2014 по нему порядок узлов.');
  head.push('Пинг: cp.cloudflare.com/generate_204 (та же цель, что у групп Loon). Скорость: speed.cloudflare.com.');
  head.push('Метка в имени узла = скорость% (НЕ балл). Порядок в подписке = балл.');
  console.log(head.join('\n'));

  console.log('\n' + buildHistory().join('\n'));

  if (!hasW && !hasC) {
    console.log('\nНет данных спидтеста. Запусти RH-Speed или дождись окна (cron 20 мин).');
    $notification.post('RouteHub viewer', 'Нет данных спидтеста', 'История запусков \u2014 в логе Loon.');
    $done(); return;
  }

  var parts = [], sum = [];
  if (hasW) {
    var bw = buildBlock(wifi, 'Wi-Fi \uD83D\uDEDC');
    parts.push(bw.lines.join('\n'));
    sum.push('\uD83D\uDEDC ' + bw.tested + ' ок/' + bw.dead + ' мёртв; свежесть ' + fmtAge(bw.newest) + '\u2026' + fmtAge(bw.oldest) + (bw.best ? ('; топ ' + Math.round(bw.best.score * 100) + ' ' + shortName(bw.best.name)) : ''));
  }
  if (hasC) {
    var bc = buildBlock(cell, 'Сотовая \uD83D\uDCF1');
    parts.push(bc.lines.join('\n'));
    sum.push('\uD83D\uDCF1 ' + bc.tested + ' ок/' + bc.dead + ' мёртв; свежесть ' + fmtAge(bc.newest) + '\u2026' + fmtAge(bc.oldest) + (bc.best ? ('; топ ' + Math.round(bc.best.score * 100) + ' ' + shortName(bc.best.name)) : ''));
  }

  console.log('\n' + parts.join('\n\n'));
  $notification.post('RouteHub \u2014 метрики узлов', sum.join('   '), 'Таблица узлов + история запусков (разрывы) \u2014 в логе Loon.');
  $done();
}

main();
