// routehub — модуль api.js
// Боевые эндпоинты устройства: /config, /nodes, /speed, /rkn, /status.
// Разделён из routehub-worker.js 2026-08-15 (v1.9.5). Логика не менялась.
// История версий — CHANGELOG.md в корне репозитория.

import { aiBlocks, buildAiTiers } from './ai.js';
import { KEY_RE } from './const.js';
import { ensureFlags, ensureFreeSpare, kvGetJSON, kvPutJSON, kvPutManyJSON, loadRegistry, tokenGate } from './store.js';
import { fetchUpstream, getSub, renderNodesBoth } from './sub.js';
import { classifyNet, confVersion, decodeName, fragOf, jsonResp, matchKey, metricOf, subParamsFromConf, utf8ToB64 } from './util.js';

function handleWhoami(req) {
  const cf = req.cf || {};
  const ip = req.headers.get('CF-Connecting-IP') || '';
  const aso = cf.asOrganization || '';
  return jsonResp({ ip: ip, asn: cf.asn || null, aso: aso, country: cf.country || null, net: classifyNet(aso) });
}

async function handleConfig(url, env, tok) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return new Response('bad key', { status: 400 });

  const reg = await loadRegistry(env);
  if (!reg[key]) return new Response('unknown key', { status: 403 });
  const bad = await tokenGate(env, reg, key, tok, true); if (bad) return bad;
  ensureFlags(reg);
  reg[key].last_config_ts = new Date().toISOString();

  // Обход кэша: no-store (кэш Workers) + ?t=now (CDN GitHub считает ресурс новым)
  const cfgUrl = env.CONFIG_URL + (env.CONFIG_URL.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
  const cr = await fetch(cfgUrl, { headers: { 'User-Agent': 'routehub-worker' }, cache: 'no-store' });
  if (!cr.ok) throw new Error('config fetch ' + cr.status);
  let conf = await cr.text();
  const cv = confVersion(conf);
  if (cv && reg[key].conf_ver !== cv) reg[key].conf_ver = cv;
  // Одна запись реестра на запрос (раньше при смене C-draft писалось дважды).
  try { await kvPutJSON(env, 'devices', reg); } catch (e) {}

  // Параметры подписки берём ИЗ КОНФИГА ДО переписывания строки Lastdep.
  const subParams = subParamsFromConf(conf);
  // База со встроенным токеном: скрипты на устройстве строят запрос как
  // ORIGIN + '/путь', поэтому токен доезжает до них без правки самих скриптов.
  const base = url.origin + '/t/' + reg[key].token;

  const sub = await getSub(env, false);
  const masterLines = sub.text.split('\n').filter(Boolean);
  const state = (await kvGetJSON(env, 'metrics:' + key)) || {};
  const blocks = aiBlocks(buildAiTiers(masterLines, state));
  conf = conf.replace('# __RH_AI_FILTERS__', blocks.filters);
  conf = conf.replace('# __RH_AI_GROUPS__', blocks.groups);

  const subUrl = base + '/nodes?key=' + key + subParams;
  conf = conf.replace(/^Lastdep = .*$/m, 'Lastdep = ' + subUrl);
  const mylistUrl = base + '/mylist?key=' + key;
  conf = conf.replace('# __RH_MYLIST_URL__', mylistUrl);
  const scriptBase = env.CONFIG_URL.replace(/[^/]+$/, '');
  conf = conf.replace(/script-path=(routehub-[^,\s]+)/g, 'script-path=' + scriptBase + '$1');
  const sFlags = [];
  if (reg[key].cell_unlim) sFlags.push('cellall');
  if (reg[key].ewma) sFlags.push('ewma');
  conf = conf.replace('tag=RH-Speed', 'tag=RH-Speed, argument=' + key + '|' + base + '|' + sFlags.join(','));
  const nOpts = reg[key].auto_refresh ? 'autorefresh' : '';
  conf = conf.replace('tag=RH-Net', 'tag=RH-Net, argument=' + key + '|' + base + '|' + nOpts);
  conf = conf.replace('tag=RH-DashCache,', 'tag=RH-DashCache, argument=' + key + '|' + base + ',');
  conf = conf.replace('tag=RH-Dash,', 'tag=RH-Dash, argument=' + key + '|' + base + ',');
  conf = conf.replace('tag=RH-RKN,', 'tag=RH-RKN, argument=' + key + '|' + base + ',');

  return new Response(conf, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function handleStatus(url, env, tok) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  const reg = await loadRegistry(env);
  const e = reg[key];
  if (!e) return jsonResp({ error: 'unknown key' }, 403);
  const bad = await tokenGate(env, reg, key, tok, false); if (bad) return bad;
  const c = await kvGetJSON(env, 'sub_cache');
  return jsonResp({
    key: key, status: e.status || null, net: e.net || null,
    net_ts: e.net_ts || null, nodes_ts: e.nodes_ts || null, nodes_n: e.nodes_n || 0,
    last_seen: e.last_seen || null,
    sub_ts: c ? new Date(c.ts).toISOString() : null,
    sub_age_min: c ? Math.round((Date.now() - c.ts) / 60000) : null,
    sub_nodes: c ? (c.n || (c.text ? c.text.split('\n').length : 0)) : 0,
    server_now: new Date().toISOString(),
  });
}

async function handleNodes(url, env, tok) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return new Response('bad key', { status: 400 });
  const reg = await loadRegistry(env);
  if (!reg[key]) return new Response('unknown key', { status: 403 });
  const bad = await tokenGate(env, reg, key, tok, true); if (bad) return bad;
  const showRtt = !!reg[key].show_rtt;
  reg[key].last_nodes_ts = new Date().toISOString();
  reg[key].nodes_n = (reg[key].nodes_n || 0) + 1;
  try { await kvPutJSON(env, 'devices', reg); } catch (e) {}
  const sub = await getSub(env, false);
  const masterLines = sub.text.split('\n').filter(Boolean);
  const state = (await kvGetJSON(env, 'metrics:' + key)) || {};
  const out = renderNodesBoth(masterLines, state, showRtt);
  const headers = {};
  for (const k in (sub.meta || {})) { if (sub.meta[k]) headers[k] = String(sub.meta[k]); }
  headers['Content-Type'] = 'text/plain; charset=utf-8';
  headers['Cache-Control'] = 'no-store';
  return new Response(utf8ToB64(out), { headers: headers });
}

async function handleRefresh(url, env, tok) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  const reg = await loadRegistry(env);
  if (!reg[key]) return jsonResp({ error: 'unknown key' }, 403);
  const bad = await tokenGate(env, reg, key, tok, false); if (bad) return bad;
  try {
    const fresh = await fetchUpstream(env);
    await kvPutJSON(env, 'sub_cache', fresh);
    return jsonResp({ ok: true, nodes: fresh.n, updated: new Date(fresh.ts).toISOString() });
  } catch (e) {
    return jsonResp({ ok: false, error: String(e && e.message || e) }, 502);
  }
}

async function handleRkn(req, env, tok) {
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }
  const key = (data && data.key) || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  const reg = await loadRegistry(env);
  if (!reg[key]) return jsonResp({ error: 'unknown key' }, 403);
  const badT = await tokenGate(env, reg, key, tok, false); if (badT) return badT;
  const mode = String((data && data.mode) || '');
  if (['normal', 'whitelist', 'block'].indexOf(mode) < 0) return jsonResp({ error: 'bad mode' }, 400);
  const rec = { mode: mode, ts: (data && data.ts) || new Date().toISOString() };
  let hist = (await kvGetJSON(env, 'rkn_hist:' + key)) || [];
  if (!hist.length || hist[hist.length - 1].mode !== mode) {
    hist.push(rec);
    if (hist.length > 50) hist = hist.slice(-50);
    // Смена режима: текущее состояние + история — одной транзакцией.
    await kvPutManyJSON(env, [['rkn:' + key, rec], ['rkn_hist:' + key, hist]]);
  } else {
    await kvPutJSON(env, 'rkn:' + key, rec);
  }
  return jsonResp({ ok: true, key: key, mode: mode });
}

async function handleSpeed(req, env, tok) {
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }

  const key = (data && data.key) || '';
  const nonce = String((data && data.nonce) || '');
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  if (!nonce) return jsonResp({ error: 'no nonce' }, 400);

  const reg = await loadRegistry(env);
  if (!reg[key]) return jsonResp({ error: 'unknown key' }, 403);
  const badT = await tokenGate(env, reg, key, tok, false); if (badT) return badT;
  ensureFlags(reg);

  const now = new Date().toISOString();
  const e = reg[key];
  if (e.status === 'free') {
    e.status = 'bound'; e.nonce = nonce; e.first_seen = now; e.last_seen = now;
    ensureFreeSpare(reg); ensureFlags(reg);
  } else if (e.status === 'bound') {
    if (e.nonce !== nonce) {
      e.status = 'conflict';
      await kvPutJSON(env, 'devices', reg);
      return jsonResp({ error: 'nonce conflict' }, 409);
    }
    e.last_seen = now;
  } else {
    return jsonResp({ error: 'key in conflict' }, 409);
  }

  const state = (await kvGetJSON(env, 'metrics:' + key)) || {};
  let sentW = 0, sentC = 0;
  function apply(arr, slot) {
    if (!Array.isArray(arr)) return;
    for (const s of arr) {
      if (!s || !s.name) continue;
      const k = matchKey(String(s.name));
      if (!state[k]) state[k] = {};
      state[k][slot] = metricOf(s);
      if (slot === 'w') sentW++; else sentC++;
    }
  }
  apply(data.wifi, 'w');
  apply(data.cell, 'c');

  // v1.9.0: отсечение МЁРТВЫХ МЕТРИК — ключей, которых нет в текущей подписке.
  // Критерий один: фактический состав sub_cache (без порогов по возрасту).
  // ПРЕДОХРАНИТЕЛЬ: подписка недоступна, не распарсилась или дала 0 строк ->
  // чистка пропускается целиком. Иначе один сбой Lastdep стёр бы накопленное.
  let pruned = 0;
  try {
    const sub = await kvGetJSON(env, 'sub_cache');
    const lines = (sub && sub.text) ? sub.text.split('\n').filter(Boolean) : [];
    if (lines.length) {
      const live = {};
      for (const line of lines) live[matchKey(decodeName(fragOf(line)))] = 1;
      for (const k in state) if (!(k in live)) { delete state[k]; pruned++; }
    }
  } catch (e) { pruned = 0; }

  let labeled = 0;
  for (const k in state) if (state[k] && (state[k].w || state[k].c)) labeled++;

  // Парная запись одним обращением к D1 (атомарно): метрики + реестр.
  await kvPutManyJSON(env, [['metrics:' + key, state], ['devices', reg]]);

  return jsonResp({ ok: true, key: key, status: e.status, labeled: labeled, pruned: pruned, sent_wifi: sentW, sent_cell: sentC });
}

export { handleConfig, handleNodes, handleRefresh, handleRkn, handleSpeed, handleStatus, handleWhoami };
