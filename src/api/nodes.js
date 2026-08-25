// routehub — модуль api/nodes.js
// Эндпоинты /nodes и /refresh: выдача обоих наборов узлов и обновление кэша подписки.
// Выделен из src/api.js 2026-08-25 (ветка stash-client): файл перешагнул
// порог 15 КБ. Логика НЕ менялась — только раскладка по файлам.
// История версий — CHANGELOG.md в корне репозитория.

import { KEY_RE } from '../const.js';
import { kvGetJSON, kvPutJSON, loadRegistry, tokenGate } from '../store.js';
import { fetchUpstream, getSub, renderNodesBoth } from '../sub.js';
import { jsonResp, utf8ToB64 } from '../util.js';

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

export { handleNodes, handleRefresh };
