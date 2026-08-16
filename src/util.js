// routehub — модуль util.js
// Чистые функции: разбор и сборка имён узлов, баллы, коды ответов.
// Разделён из routehub-worker.js 2026-08-15 (v1.9.5). Логика не менялась.
// Здесь только то, что от клиента не зависит: разбор строки [Remote Proxy]
// уехал в clients/loon.js (v1.9.6, ADR-01).
// История версий — CHANGELOG.md в корне репозитория.

import { BLK, CELL_HINTS, DEAD, FLAG_RE, FLAG_START_RE, FLOOR_BL, FLOOR_JIT, FLOOR_RTT, METRIC_SEP, PROX, REGION_AM, REGION_EU, REGION_RU, RH_ICON_SVG, SCORE_WB, SCORE_WJ, SCORE_WR, SCORE_WS, SUP_DIG, SUP_PLUS, VOICE, VOICE_BL, VOICE_JIT, VOICE_MED } from './const.js';

function proxOf(fl) { return (fl in PROX) ? PROX[fl] : 99; }

// РЕГИОНЫ (v1.8.1) — порядок предпочтения для ИИ и обычного трафика:
// 0 Европа, 1 Америка, 2 Россия/СНГ, 3 прочие (незнакомый флаг -> 3).
// Списки синхронны с региональными фильтрами routehub.conf (C-draft-36).

function regionOf(fl) {
  if (REGION_EU.indexOf(fl) >= 0) return 0;
  if (REGION_AM.indexOf(fl) >= 0) return 1;
  if (REGION_RU.indexOf(fl) >= 0) return 2;
  return 3;
}

function speedBlock(down) {
  if (down < 1) return BLK[0];
  if (down < 2) return BLK[1];
  if (down < 5) return BLK[2];
  if (down < 15) return BLK[3];
  if (down < 25) return BLK[4];
  return BLK[4] + SUP_PLUS;
}

function supNum(n) {
  n = Math.round(n); if (n < 0) n = 0; if (n > 999) n = 999;
  return String(n).split('').map(function (d) { return SUP_DIG[+d]; }).join('');
}

function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

function scoreOf(m, maxDown) {
  if (!m || m.dead) return -1;
  const sN = maxDown > 0 ? clamp01((+m.down || 0) / maxDown) : 0;
  const lat = (m.med != null) ? (+m.med || 0) : (+m.rtt || 0);
  const rN = clamp01(FLOOR_RTT / Math.max(lat, FLOOR_RTT));
  const jit = (m.jit == null) ? null : (+m.jit || 0);
  const jN = (jit == null) ? 1 : clamp01(FLOOR_JIT / Math.max(jit, FLOOR_JIT));
  if (m.bl == null) {
    const tot = SCORE_WS + SCORE_WR + SCORE_WJ;
    return (SCORE_WS * sN + SCORE_WR * rN + SCORE_WJ * jN) / tot;
  }
  const bl = +m.bl || 0;
  const bN = clamp01(FLOOR_BL / Math.max(bl, FLOOR_BL));
  return SCORE_WS * sN + SCORE_WR * rN + SCORE_WJ * jN + SCORE_WB * bN;
}

function voiceOk(m) {
  if (!m || m.dead) return false;
  const jit = (m.jit == null) ? null : (+m.jit || 0);
  const bl = (m.bl == null) ? null : (+m.bl || 0);
  const lat = (m.med != null) ? (+m.med || 0) : (+m.rtt || 0);
  if (jit == null || jit > VOICE_JIT) return false;
  if (bl != null && bl > VOICE_BL) return false;
  if (lat > VOICE_MED) return false;
  return true;
}

function parseUserinfo(meta) {
  const u = meta && meta['subscription-userinfo'];
  if (!u) return null;
  const o = {};
  String(u).split(';').forEach(function (kv) {
    const p = kv.split('='); if (p.length === 2) o[p[0].trim()] = +p[1];
  });
  if (o.total == null) return null;
  const used = (o.upload || 0) + (o.download || 0);
  const left = Math.max(0, o.total - used);
  const GB = 1024 * 1024 * 1024;
  return {
    total_gb: +(o.total / GB).toFixed(1),
    used_gb: +(used / GB).toFixed(1),
    left_gb: +(left / GB).toFixed(1),
    expire: o.expire || null,
  };
}

function confVersion(conf) {
  const m = String(conf).match(/C-draft-\d+/);
  return m ? m[0] : null;
}

function iconResp() {
  return new Response(RH_ICON_SVG, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' } });
}

function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
}

// ХРАНИЛИЩЕ — Cloudflare D1 (таблица kv: key/value/updated_at), эмуляция KV.
// Модель прежняя: один ключ = один JSON-блок (metrics:<kN> — ВСЕ узлы одним
// объектом, не строка на узел). Одна запись = одна строка -> расход как у KV,
// но лимит в 100 раз выше (100 000 строк/сутки против 1000 записей/сутки).

function b64ToUtf8(s) {
  try {
    let n = (s || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    n += '='.repeat((4 - n.length % 4) % 4);
    const bin = atob(n);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e) { return ''; }
}

function utf8ToB64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fragOf(line) { const i = line.indexOf('#'); return i >= 0 ? line.slice(i + 1) : ''; }

function withFrag(line, frag) { const i = line.indexOf('#'); const head = i >= 0 ? line.slice(0, i) : line; return head + '#' + frag; }

function decodeName(frag) { try { return decodeURIComponent(frag); } catch (e) { return frag; } }

function stripMetric(name) { const i = name.indexOf(METRIC_SEP); return (i >= 0 ? name.slice(0, i) : name); }

function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

function matchKey(name) { return norm(stripMetric(name)); }

function flagOf(name) { const m = String(name).match(FLAG_RE); return m ? m[0] : ''; }

function startFlag(name) { const m = String(name).match(FLAG_START_RE); return m ? m[1] : null; }
// Тег узла по имени. Провайдер часто меняет значки ВНУТРИ скобок
// ([VPN] -> [🌀 VPN] и т.п.), поэтому критерий — слово в скобочном теге,
// а не точная подстрока '[VPN]'. Порядок: обход -> игры -> VPN (обход строго
// первым: у него скобка тоже может однажды получить слово VPN).

function tagOf(name) {
  if (name.indexOf('[Обход') >= 0) return 'bypass';
  if (name.indexOf('Игры') >= 0) return 'game';
  if (name.indexOf('VPN]') >= 0) return 'vpn';
  return 'other';
}

function classifyNet(asOrg) {
  const s = (asOrg || '').toLowerCase();
  for (const h of CELL_HINTS) if (s.indexOf(h) >= 0) return 'cell';
  return 'wifi';
}

function metricOf(s) {
  if (s.dead) return { dead: true };
  const o = {
    down: Math.max(0, Math.round(+s.down || 0)),
    rtt: Math.max(0, Math.round(+s.rtt || 0)),
    jit: Math.max(0, Math.round(+s.jit || 0)),
    bl: (s.bl == null ? null : Math.max(0, Math.round(+s.bl))),
  };
  if (s.med != null) o.med = Math.max(0, Math.round(+s.med));
  return o;
}

function labelOf(icon, m, max, showRtt) {
  if (m.dead) return icon + DEAD;
  const pct = max > 0 ? Math.round(m.down / max * 100) : 0;
  const v = voiceOk(m) ? VOICE : '';
  return icon + speedBlock(m.down) + ' ' + supNum(pct) + v + (showRtt ? (' ' + m.down + '↓' + m.rtt) : '');
}

export { b64ToUtf8, clamp01, classifyNet, confVersion, decodeName, flagOf, fragOf, iconResp, jsonResp, labelOf, matchKey, metricOf, norm, parseUserinfo, proxOf, regionOf, scoreOf, speedBlock, startFlag, stripMetric, supNum, tagOf, utf8ToB64, voiceOk, withFrag };
