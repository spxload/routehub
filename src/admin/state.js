// routehub — модуль admin/state.js
// Состояние и ключи: /admin/state, /admin/keys, каскад регионов, возраст замеров.
// Выделен из src/admin.js 2026-08-25 (ветка stash-client): файл перешагнул
// порог 15 КБ. Логика НЕ менялась — только раскладка по файлам.
// История версий — CHANGELOG.md в корне репозитория.

import { CASCADE_TIERS, FLAGS, FRESH_MS, WORKER_VER } from '../const.js';
import { kvGetJSON, loadMylist, loadRegistry, loadSettings } from '../store.js';
import { decodeName, flagOf, fragOf, jsonResp, matchKey, parseUserinfo, regionOf, tagOf } from '../util.js';
import { adminGate } from './session.js';

function deviceRow(url, k, e) {
  const flags = {};
  for (const f of FLAGS) flags[f] = !!e[f];
  return {
    key: k, status: e.status || null,
    first_seen: e.first_seen || null, last_seen: e.last_seen || null,
    last_config_ts: e.last_config_ts || null, last_nodes_ts: e.last_nodes_ts || null,
    conf_ver: e.conf_ver || null, nodes_n: e.nodes_n || 0,
    token: e.token || null, flags: flags,
    config_url: url.origin + '/t/' + e.token + '/config?key=' + k,
    dashboard_url: url.origin + '/t/' + e.token + '/dashboard?key=' + k,
    refresh_url: url.origin + '/t/' + e.token + '/refresh?key=' + k,
  };
}

// Готовые ссылки по устройствам — отсюда Диана берёт строку для нового телефона.
// Токен показывается ТОЛЬКО здесь и в /admin/state, и только под ADMIN_KEY.

async function handleAdminKeys(req, url, env) {
  const denied = await adminGate(req, url, env); if (denied) return denied;
  const reg = await loadRegistry(env);
  const st = await loadSettings(env);
  const out = [];
  for (const k in reg) out.push(deviceRow(url, k, reg[k]));
  return jsonResp({ ok: true, token_required: st.token_required, devices: out });
}

// Каскад регионов конфига: сколько узлов в каждом тире и сколько из них живых
// по метрикам выбранного устройства. Порядок тиров совпадает с [Proxy Group]
// главного конфига (RH-АВТО): EU -> AM -> RU/СНГ -> прочие -> игры -> обход.

function cascadeOf(masterLines, state) {
  const out = {};
  for (const t of CASCADE_TIERS) out[t] = { total: 0, live: 0 };
  for (const line of masterLines) {
    const name = decodeName(fragOf(line));
    const tag = tagOf(name);
    let tier;
    if (tag === 'bypass') tier = 'BYPASS';
    else if (tag === 'game') tier = 'GAME';
    else if (tag === 'vpn') tier = CASCADE_TIERS[regionOf(flagOf(name))];
    else continue;
    out[tier].total++;
    const st = state[matchKey(name)];
    const m = st ? (st.w || st.c) : null;
    if (m && !m.dead) out[tier].live++;
  }
  return out;
}

// Сводка для панели: один GET на всё, чтобы не плодить обращения к D1.
// ?dev=kN — устройство, по которому считаются каскад, метрики и личный список;
// по умолчанию первое привязанное.

// v1.10.1: сводка по возрасту замеров, по слоту.
// Без неё замороженный слот виден только в сыром JSON дашборда и только
// при разглядывании всего списка узлов. Здесь достаточно одной строки:
// «сотовая — 0 из 50 с отметкой» читается как «этот слот не мерялся».
// `no_ts` — узлы, у которых отметки нет: либо запись старше v1.10.0, либо
// слот приезжает переотправкой кэша устройства и замера не было ни разу.
function metricsAge(state) {
  const now = Date.now();
  function forSlot(slot) {
    let total = 0, withTs = 0, oldest = null, newest = null;
    let dead = 0;
    for (const k in state) {
      const m = state[k] && state[k][slot];
      if (!m) continue;
      // Мёртвые узлы считаем отдельно: дашборд и каскад их отбрасывают
      // (`nodesForDash`, `cascadeOf`), и если сложить их в `total`, два
      // числа на одном экране перестанут быть сравнимыми.
      if (m.dead) { dead++; continue; }
      total++;
      if (!m.ts) continue;
      withTs++;
      // clampTs пропускает отметку на пять минут вперёд (часы устройства),
      // поэтому возраст может выйти отрицательным — наружу это не отдаём.
      const age = Math.max(0, Math.round((now - m.ts) / 60000));
      if (oldest == null || age > oldest) oldest = age;
      if (newest == null || age < newest) newest = age;
    }
    return { total: total, with_ts: withTs, no_ts: total - withTs, dead: dead,
      oldest_min: oldest, newest_min: newest };
  }
  return { w: forSlot('w'), c: forSlot('c') };
}

async function handleAdminState(req, url, env) {
  const denied = await adminGate(req, url, env); if (denied) return denied;
  const reg = await loadRegistry(env);
  const st = await loadSettings(env);
  const c = await kvGetJSON(env, 'sub_cache');
  const masterLines = (c && c.text) ? c.text.split('\n').filter(Boolean) : [];

  let dev = url.searchParams.get('dev') || '';
  if (!reg[dev]) {
    dev = '';
    for (const k in reg) if (reg[k].status === 'bound') { dev = k; break; }
    if (!dev) for (const k in reg) { dev = k; break; }
  }
  const state = dev ? ((await kvGetJSON(env, 'metrics:' + dev)) || {}) : {};
  const mylist = dev ? await loadMylist(env, dev) : [];
  const rkn = dev ? ((await kvGetJSON(env, 'rkn:' + dev)) || null) : null;

  const devices = [];
  for (const k in reg) devices.push(deviceRow(url, k, reg[k]));

  // Раздел «хранилище»: тот же запрос, что стоял в снятом /admin/verify.
  let storage = [];
  try {
    const rows = await env.RH_DB.prepare(
      'SELECT key, LENGTH(value) AS len, updated_at FROM kv ORDER BY key').all();
    storage = (rows.results || []).map(function (r) {
      return { key: r.key, len: r.len, updated_at: r.updated_at || null };
    });
  } catch (e) { storage = []; }

  return jsonResp({
    ok: true, worker: WORKER_VER,
    token_required: st.token_required,
    dev: dev || null,
    sub: {
      ts: c ? new Date(c.ts).toISOString() : null,
      age_min: c ? Math.round((Date.now() - c.ts) / 60000) : null,
      nodes: c ? (c.n || masterLines.length) : 0,
      fresh_min: Math.round(FRESH_MS / 60000),
      traffic: c ? parseUserinfo(c.meta || {}) : null,
    },
    cascade: cascadeOf(masterLines, state),
    metrics_n: Object.keys(state).length,
    metrics_age: metricsAge(state),
    mylist: mylist, rkn: rkn,
    devices: devices, storage: storage,
    server_now: new Date().toISOString(),
  });
}

export { cascadeOf, deviceRow, handleAdminKeys, handleAdminState };
