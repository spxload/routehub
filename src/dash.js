// routehub — модуль dash.js
// Дашборд rh.box: данные страницы и личный список доменов.
// Разделён из routehub-worker.js 2026-08-15 (v1.9.5). Логика не менялась.
// История версий — CHANGELOG.md в корне репозитория.

import { DOMAIN_RE, KEY_RE, RU, WORKER_VER } from './const.js';
import { kvGetJSON, kvPutJSON, loadMylist, loadRegistry, tokenGate } from './store.js';
import { decodeName, fragOf, jsonResp, matchKey, norm, parseUserinfo, scoreOf, stripMetric, tagOf, voiceOk } from './util.js';

async function handleMylist(url, env, tok) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return new Response('bad key', { status: 400 });
  const reg = await loadRegistry(env);
  if (!reg[key]) return new Response('unknown key', { status: 403 });
  const bad = await tokenGate(env, reg, key, tok, true); if (bad) return bad;
  const list = await loadMylist(env, key);
  const lines = ['# RouteHub личный список RH-RU (' + key + '), доменов: ' + list.length];
  for (const d of list) lines.push('DOMAIN-SUFFIX,' + d);
  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function handleRule(req, env, add, tok) {
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }
  const key = (data && data.key) || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  const reg = await loadRegistry(env);
  if (!reg[key]) return jsonResp({ error: 'unknown key' }, 403);
  const badT = await tokenGate(env, reg, key, tok, false); if (badT) return badT;
  const domain = String((data && data.domain) || '').trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) return jsonResp({ error: 'bad domain' }, 400);
  let list = await loadMylist(env, key);
  if (add) {
    if (list.indexOf(domain) < 0) list.push(domain);
  } else {
    list = list.filter(function (d) { return d !== domain; });
  }
  await kvPutJSON(env, 'mylist:' + key, list);
  return jsonResp({ ok: true, key: key, domains: list });
}

function nodesForDash(masterLines, state) {
  function pack(slot) {
    const arr = []; let mx = 0;
    for (const line of masterLines) {
      const name = decodeName(fragOf(line));
      const tag = tagOf(name);
      if (tag !== 'vpn' && tag !== 'game') continue;
      const st = state[matchKey(name)];
      const m = st ? st[slot] : null;
      if (!m || m.dead) continue;
      if ((+m.down || 0) > mx) mx = +m.down || 0;
      arr.push({ name: norm(stripMetric(name)), m: m });
    }
    return arr.map(function (it) {
      return {
        name: it.name,
        down: it.m.down || 0,
        rtt: it.m.rtt || 0,
        med: (it.m.med != null ? it.m.med : it.m.rtt) || 0,
        jit: (it.m.jit == null ? null : it.m.jit),   // v1.9.8: null = сбойный замер, не идеальный джиттер
        bl: (it.m.bl == null ? null : it.m.bl),
        pct: mx > 0 ? Math.round((it.m.down || 0) / mx * 100) : 0,
        score: +(scoreOf(it.m, mx) * 100).toFixed(0),
        voice: voiceOk(it.m),
      };
    }).sort(function (a, b) { return b.score - a.score; });
  }
  return { wifi: pack('w'), cell: pack('c') };
}

async function handleDashboard(url, env, tok) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  const reg = await loadRegistry(env);
  const e = reg[key];
  if (!e) return jsonResp({ error: 'unknown key' }, 403);
  const bad = await tokenGate(env, reg, key, tok, false); if (bad) return bad;
  const c = await kvGetJSON(env, 'sub_cache');
  const state = (await kvGetJSON(env, 'metrics:' + key)) || {};
  const masterLines = (c && c.text) ? c.text.split('\n').filter(Boolean) : [];
  const nodes = nodesForDash(masterLines, state);
  const rkn = (await kvGetJSON(env, 'rkn:' + key)) || null;
  const rknHist = (await kvGetJSON(env, 'rkn_hist:' + key)) || [];
  const mylist = await loadMylist(env, key);
  const traffic = c ? parseUserinfo(c.meta || {}) : null;
  return jsonResp({
    key: key,
    worker: WORKER_VER,
    conf_ver: e.conf_ver || null,
    status: e.status || null,
    sub_age_min: c ? Math.round((Date.now() - c.ts) / 60000) : null,
    sub_nodes: c ? (c.n || masterLines.length) : 0,
    sub_ts: c ? new Date(c.ts).toISOString() : null,
    last_config_ts: e.last_config_ts || null,
    last_nodes_ts: e.last_nodes_ts || null,
    traffic: traffic,
    rkn: rkn,
    rkn_hist: rknHist.slice(-20),
    mylist: mylist,
    counts: { wifi: nodes.wifi.length, cell: nodes.cell.length,
      voice_wifi: nodes.wifi.filter(function (n) { return n.voice; }).length,
      voice_cell: nodes.cell.filter(function (n) { return n.voice; }).length },
    nodes: nodes,
    server_now: new Date().toISOString(),
  });
}

export { handleDashboard, handleMylist, handleRule, nodesForDash };
