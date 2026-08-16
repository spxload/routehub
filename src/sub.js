// routehub — модуль sub.js
// Подписка Lastdep: загрузка, кэш, сортировка, выдача двух наборов.
// Разделён из routehub-worker.js 2026-08-15 (v1.9.5). Логика не менялась.
// История версий — CHANGELOG.md в корне репозитория.

import { DE, FRESH_MS, ICON_CELL, ICON_WIFI, META_HEADERS, METRIC_SEP, NODATA, NODE_PREFIXES } from './const.js';
import { kvGetJSON, kvPutJSON } from './store.js';
import { b64ToUtf8, decodeName, flagOf, fragOf, labelOf, matchKey, norm, proxOf, scoreOf, startFlag, stripMetric, tagOf, withFrag } from './util.js';

async function fetchUpstream(env) {
  if (!env.SUBSCRIPTION_URL) throw new Error('SUBSCRIPTION_URL не задан (секрет CF)');
  const r = await fetch(env.SUBSCRIPTION_URL, {
    headers: {
      'X-HWID': env.SUB_HWID || '',
      'User-Agent': 'Shadowrocket/3274 CFNetwork/3860.400.51 Darwin/25.3.0 iPhone14,7',
      'X-VER-OS': '26.3.1', 'X-DEVICE-MODEL': 'iPhone', 'X-DEVICE-OS': 'iOS',
      'Accept': '*/*', 'Accept-Language': 'ru',
    },
  });
  if (!r.ok) throw new Error('upstream ' + r.status);
  const meta = {};
  for (const k of META_HEADERS) {
    const v = r.headers.get(k);
    if (v && v.trim()) meta[k] = v.trim();
  }
  const raw = await r.text();
  const body = raw.replace(/\s+/g, '');
  let text = raw;
  const dec = b64ToUtf8(body);
  if (dec && NODE_PREFIXES.some(function (p) { return dec.indexOf(p) >= 0; })) text = dec;
  let lines = text.split('\n').map(function (l) { return l.trim(); })
    .filter(function (l) { return NODE_PREFIXES.some(function (p) { return l.startsWith(p); }); });
  if (!lines.length) throw new Error('узлов в подписке не найдено');
  lines = sortMaster(lines);
  return { ts: Date.now(), text: lines.join('\n'), meta: meta, n: lines.length };
}

function sortMaster(lines) {
  const cnt = {};
  for (const l of lines) {
    const nm = decodeName(fragOf(l));
    if (tagOf(nm) !== 'vpn') continue;
    const fl = startFlag(nm);
    if (fl) cnt[fl] = (cnt[fl] || 0) + 1;
  }
  function keyOf(l) {
    const nm = decodeName(fragOf(l));
    const fl = startFlag(nm);
    if (!fl) return { a: 2, b: 0, c: 'zzz', nm: nm };
    if (fl === DE) return { a: 0, b: 0, c: '', nm: nm };
    return { a: 1, b: -(cnt[fl] || 0), c: fl, nm: nm };
  }
  return lines.map(function (l) { return { l: l, k: keyOf(l) }; })
    .sort(function (x, y) {
      return (x.k.a - y.k.a) || (x.k.b - y.k.b) ||
        (x.k.c < y.k.c ? -1 : x.k.c > y.k.c ? 1 : 0) ||
        (x.k.nm < y.k.nm ? -1 : x.k.nm > y.k.nm ? 1 : 0);
    })
    .map(function (o) { return o.l; });
}

async function getSub(env, force) {
  const c = await kvGetJSON(env, 'sub_cache');
  if (!force && c && c.text && (Date.now() - c.ts) < FRESH_MS) return c;
  try {
    const fresh = await fetchUpstream(env);
    await kvPutJSON(env, 'sub_cache', fresh);
    return fresh;
  } catch (e) {
    if (c && c.text) return c;
    throw e;
  }
}

function renderNodesBoth(masterLines, state, showRtt) {
  const bypassRaw = [];
  const wTested = [], cTested = [], wUntested = [], cUntested = [];
  let maxW = 0, maxC = 0;
  for (const line of masterLines) {
    const name = decodeName(fragOf(line));
    const tag = tagOf(name);
    if (tag === 'bypass') { bypassRaw.push({ line: line, name: name, flag: flagOf(name) }); continue; }
    const base = norm(stripMetric(name));
    const st = (tag === 'vpn' || tag === 'game') ? state[matchKey(name)] : null;
    const mw = st ? st.w : null;
    const mc = st ? st.c : null;
    if (mw) { if (!mw.dead && mw.down > maxW) maxW = mw.down; wTested.push({ line: line, base: base, m: mw }); }
    else { wUntested.push(withFrag(line, encodeURIComponent(base + METRIC_SEP + ICON_WIFI + NODATA))); }
    if (mc) { if (!mc.dead && mc.down > maxC) maxC = mc.down; cTested.push({ line: line, base: base, m: mc }); }
    else { cUntested.push(withFrag(line, encodeURIComponent(base + METRIC_SEP + ICON_CELL + NODATA))); }
  }
  function buildBlock(items, icon, max) {
    const arr = [];
    for (const it of items) {
      const nm = it.base + METRIC_SEP + labelOf(icon, it.m, max, showRtt);
      arr.push({ line: withFrag(it.line, encodeURIComponent(nm)), score: it.m.dead ? -1 : scoreOf(it.m, max) });
    }
    arr.sort(function (a, b) { return b.score - a.score; });
    return arr.map(function (x) { return x.line; });
  }
  const wifiBlock = buildBlock(wTested, ICON_WIFI, maxW).concat(wUntested);
  const cellBlock = buildBlock(cTested, ICON_CELL, maxC).concat(cUntested);
  const bcnt = {};
  for (const b of bypassRaw) if (b.flag) bcnt[b.flag] = (bcnt[b.flag] || 0) + 1;
  bypassRaw.sort(function (a, b) {
    if (a.flag === DE && b.flag !== DE) return -1;
    if (b.flag === DE && a.flag !== DE) return 1;
    return ((bcnt[b.flag] || 0) - (bcnt[a.flag] || 0)) || (proxOf(a.flag) - proxOf(b.flag));
  });
  const bypassOut = bypassRaw.map(function (b) { return withFrag(b.line, encodeURIComponent(norm(stripMetric(b.name)))); });
  return wifiBlock.concat(cellBlock, bypassOut).join('\n');
}

export { fetchUpstream, getSub, renderNodesBoth, sortMaster };
