// routehub — модуль api/misc.js
// Мелкие эндпоинты устройства: /whoami, /status, /rkn.
// Выделен из src/api.js 2026-08-25 (ветка stash-client): файл перешагнул
// порог 15 КБ. Логика НЕ менялась — только раскладка по файлам.
// История версий — CHANGELOG.md в корне репозитория.

import { KEY_RE } from '../const.js';
import { kvGetJSON, kvPutJSON, kvPutManyJSON, loadRegistry, tokenGate } from '../store.js';
import { classifyNet, jsonResp } from '../util.js';

// Страница-проба смешанного содержимого. Отдаётся БЕЗ ключа и БЕЗ токена
// намеренно: в ней нет ни данных, ни секретов, а весь смысл — чтобы её можно
// было открыть в Safari на телефоне в один шаг. Диагностика, не маршрутизация:
// страница ничего не меняет ни в Stash, ни в конфиге.
// Вопрос, на который она отвечает, — ADR-04, раздел 4: пускает ли WebKit
// запрос со страницы по https на http://127.0.0.1:9090.
function handleMixed(MIXED_HTML) {
  return new Response(MIXED_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function handleWhoami(req) {
  const cf = req.cf || {};
  const ip = req.headers.get('CF-Connecting-IP') || '';
  const aso = cf.asOrganization || '';
  return jsonResp({ ip: ip, asn: cf.asn || null, aso: aso, country: cf.country || null, net: classifyNet(aso) });
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

export { handleMixed, handleRkn, handleStatus, handleWhoami };
