// =============================================================
// routehub-egern-worker.js — Worker стенда Egern (ветка `egern`)
// VERSION: e0.5.0 (2026-08-09) — ws-узел в proxies + скрипт k4-9.
//   Обычных ws-узлов в подписке НЕТ (все 17 ws обходные), поэтому разбор
//   ws-транспорта проверяется одним обходным узлом RH-Явный-WS. Через него
//   допускается РОВНО ОДИН запрос (шаг W4): трафик обходных узлов платный.
//   Узел кладётся в select-группу RH-Явные — у select нет interval, значит
//   фонового теста задержки по расписанию не будет.
// ИСТОРИЯ: e0.2.2 минимальный профиль (принят: 52/17 узла, 5 групп);
//   e0.2.3/e0.2.4 диагностика K2 — член DIRECT в fallback тестируется ГРУППОВЫМ
//   latency_test_url (36 мс и таймаут на 192.0.2.1) ⇒ модель «слабый DIRECT»
//   переносится; e0.3.0 schedule-скрипт и приём отчётов (K4 закрыт);
//   e0.4.0 объявленные узлы в proxies.
// РЕЗУЛЬТАТ e0.4.0 + k4-8 (2026-08-09): ctx.http с policy = имя узла из
//   proxies АДРЕСУЕТ ИМЕННО ЭТОТ УЗЕЛ (три явных узла — три разных выхода)
//   ⇒ поузловой спидтест на Egern реализуем. Открытый вопрос №1 закрыт.
// ЭНДПОИНТЫ: GET /health; GET /admin/keys?admin=<ADMIN_KEY>;
//   GET /t/<token>/nodes?key=kN; GET /t/<token>/profile?key=kN (+&safe=1);
//   GET /t/<token>/script/k4.js?key=kN; POST и GET /t/<token>/probe?key=kN.
//   Токен обязателен всегда.
// ЗНАНИЯ ИЗ ПОЛЕЙ (Egern 2.20.0, k3):
//   • hijack_dns — СПИСОК, не булево; Egern падает на ПЕРВОМ несоответствии
//     — новые конструкции вводить по одной за импорт.
//   • rule_set принимает списки формата Shadowrocket (K7 закрыт).
//   • policy в ctx.http принимает имена групп, DIRECT и имена узлов из
//     proxies; имя узла ПОДПИСКИ, несуществующее имя и REJECT — 404.
//   • cron в профиле и cron на устройстве расходятся, если правили в UI:
//     фактическое значение видно в __context.cronexp отчёта пробы.
//   • ИЗ ДОКУМЕНТАЦИИ: urls и filter — ОБЩИЕ поля пяти базовых типов,
//     то есть smart/fallback могут тянуть подписку без external. Перевод пула
//     на smart + priorities — следующий шаг (вместе с K5).
// СБОРКА: production branch = egern; «Builds for non-production branches» — СНЯТА.
// Боевой контур не затрагивается; ветка `egern` в `main` НЕ сливается.
// =============================================================

import { K4_SCRIPT, K4_REV, firstNormalNode, subNames } from './routehub-egern-k4.js';
import { explicitNodes, bypassWsNode } from './routehub-egern-proxies.js';

const WORKER_VER = 'e0.5.0';
const KEY_RE = /^k\d+$/;
const TOKEN_LEN = 32;
const TOKEN_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TOKEN_RE = /^[A-Za-z0-9]{16,64}$/;
const PATH_TOKEN_RE = /^\/t\/([A-Za-z0-9]{16,64})(\/.*)?$/;
const STAND_KEY = 'k3';
const FRESH_MS = 60 * 60 * 1000;
const NODE_PREFIXES = ['vless://', 'vmess://', 'trojan://', 'ss://'];
const PROBE_KEEP = 20;
const PROBE_MAX_BYTES = 64 * 1024;
const EXPLICIT_N = 3;                         // сколько ОБЫЧНЫХ узлов объявляем явно
const WS_NODE_NAME = 'RH-Явный-WS';           // один обходной ws — проверка разбора ws

// Признак типа узла — слово в скобочном теге, НЕ значок провайдера (вывод 28).
const RE_NORMAL = '^(?!.*Обход)';
const RE_BYPASS = '\\[Обход';

const TEST_URL_PROXY = 'http://cp.cloudflare.com/generate_204';
const TEST_URL_DIRECT = 'http://www.msftconnecttest.com/connecttest.txt';

const RAW = 'https://raw.githubusercontent.com/';
const RULE_SETS = [
  { url: RAW + 'forg-lib-lov/roscomvpn-shadowrocket/main/lists/whitelist-domains.list', policy: 'DIRECT' },
  { url: RAW + 'forg-lib-lov/roscomvpn-shadowrocket/main/lists/hxehex-whitelist.list', policy: 'DIRECT' },
  { url: RAW + 'forg-lib-lov/roscomvpn-shadowrocket/main/lists/whitelist-ips.list', policy: 'DIRECT' },
  { url: RAW + 'forg-lib-lov/roscomvpn-shadowrocket/main/lists/category-ru.list', policy: 'RH-RU' },
  { url: RAW + 'forg-lib-lov/roscomvpn-shadowrocket/main/lists/apple.list', policy: 'RH-RU' },
  { url: RAW + 'misha-tgshv/shadowrocket-configuration-file/main/rules/domains_banking.list', policy: 'RH-RU' }
];

// ------------------------------------------------------------------ утилиты
function json(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
function textResp(s, status, type) {
  return new Response(s, {
    status: status || 200,
    headers: { 'Content-Type': (type || 'text/plain') + '; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

const KV_UPSERT = 'INSERT INTO kv(key,value,updated_at) VALUES(?,?,?) ' +
  'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at';
async function kvGetJSON(env, k) {
  const r = await env.RH_DB.prepare('SELECT value FROM kv WHERE key = ?').bind(k).first();
  if (!r || r.value == null) return null;
  try { return JSON.parse(r.value); } catch (e) { return null; }
}
async function kvPutJSON(env, k, o) {
  await env.RH_DB.prepare(KV_UPSERT).bind(k, JSON.stringify(o), Date.now()).run();
}

function makeToken() {
  const buf = new Uint8Array(TOKEN_LEN);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < TOKEN_LEN; i++) out += TOKEN_ALPHABET[buf[i] % TOKEN_ALPHABET.length];
  return out;
}
async function loadRegistry(env) {
  let reg = await kvGetJSON(env, 'devices');
  let changed = false;
  if (!reg) { reg = {}; changed = true; }
  if (!reg[STAND_KEY]) { reg[STAND_KEY] = { status: 'stand' }; changed = true; }
  for (const k in reg) if (!TOKEN_RE.test(String(reg[k].token || ''))) {
    reg[k].token = makeToken();
    changed = true;
  }
  if (changed) await kvPutJSON(env, 'devices', reg);
  return reg;
}

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

// --------------------------------------------------------------- подписка
async function fetchUpstream(env) {
  if (!env.SUBSCRIPTION_URL) throw new Error('SUBSCRIPTION_URL не задан (секрет CF)');
  const r = await fetch(env.SUBSCRIPTION_URL, {
    headers: {
      'X-HWID': env.SUB_HWID || '',
      'User-Agent': 'Shadowrocket/3274 CFNetwork/3860.400.51 Darwin/25.3.0 iPhone14,7',
      'Accept': '*/*',
      'Accept-Language': 'ru'
    }
  });
  if (!r.ok) throw new Error('upstream ' + r.status);
  const raw = await r.text();
  let text = raw;
  const dec = b64ToUtf8(raw.replace(/\s+/g, ''));
  if (dec && NODE_PREFIXES.some(function (p) { return dec.indexOf(p) >= 0; })) text = dec;
  const lines = text.split('\n').map(function (l) { return l.trim(); })
    .filter(function (l) { return NODE_PREFIXES.some(function (p) { return l.startsWith(p); }); });
  if (!lines.length) throw new Error('узлов в подписке не найдено');
  return { ts: Date.now(), text: lines.join('\n'), n: lines.length };
}
async function getSub(env, force) {
  const c = await kvGetJSON(env, 'sub_cache');
  if (!force && c && c.text && Date.now() - c.ts < FRESH_MS) return c;
  try {
    const fresh = await fetchUpstream(env);
    await kvPutJSON(env, 'sub_cache', fresh);
    return fresh;
  } catch (e) {
    if (c && c.text) return c;
    throw e;
  }
}

// ------------------------------------------------------------------- YAML
function yamlStr(s) {
  return '"' + String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n') + '"';
}
function yamlVal(v, indent) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return yamlStr(v);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    const pad = ' '.repeat(indent);
    return '\n' + v.map(function (item) {
      const body = yamlVal(item, indent + 2);
      return pad + '- ' + (body.startsWith('\n') ? body.slice(1 + indent + 2) : body);
    }).join('\n');
  }
  const keys = Object.keys(v);
  if (!keys.length) return '{}';
  const pad = ' '.repeat(indent);
  return '\n' + keys.map(function (k) {
    const body = yamlVal(v[k], indent + 2);
    return pad + k + ':' + (body.startsWith('\n') ? body : ' ' + body);
  }).join('\n');
}
function yamlDoc(obj) {
  const body = yamlVal(obj, 0);
  return (body.startsWith('\n') ? body.slice(1) : body) + '\n';
}

// ---------------------------------------------------------------- профиль
// explicit — массив из explicitNodes() плюс, при наличии, один ws-узел
// из bypassWsNode(): [{ node, meta }]
function buildProfile(base, key, safe, nodeName, explicit) {
  const nodesUrl = base + '/nodes?key=' + key;
  const profUrl = base + '/profile?key=' + key + (safe ? '&safe=1' : '');
  const ex = explicit || [];
  const exNames = ex.map(function (e) { return e.node.name; });
  const normalNames = exNames.filter(function (n) { return n !== WS_NODE_NAME; });

  function pool(name, filter, interval) {
    return {
      external: {
        name: name, type: 'auto_test', urls: [nodesUrl],
        filter: filter, interval: interval, update_interval: 3600
      }
    };
  }
  function fb(name, policies, extra) {
    const g = { name: name, policies: policies, interval: 120, timeout: 5 };
    if (extra && !safe) for (const k in extra) g[k] = extra[k];
    return { fallback: g };
  }

  const groups = [
    // Обычные узлы. Обходные исключены: платный трафик на пробы не тратим.
    pool('RH-Пул-Обычные', RE_NORMAL, 600),
    pool('RH-Обход', RE_BYPASS, 3600),
    fb('RH-Проба-Обычная', ['RH-Пул-Обычные'], { latency_test_url: TEST_URL_PROXY }),
    fb('RH-RU', ['RH-Проба-Обычная', 'RH-Обход'], { latency_test_url: TEST_URL_PROXY }),
    fb('RH-Главный', ['RH-Пул-Обычные', 'RH-Обход'], { latency_test_url: TEST_URL_PROXY }),
    // Диагностика K1 — единственная группа с членом DIRECT, правилами не используется.
    fb('RH-Проба-DIRECT', ['DIRECT', 'RH-Обход'], { latency_test_url: TEST_URL_PROXY })
  ];
  // Группа из явно объявленных узлов — чтобы они были видны в UI и проверялись
  // штатным тестом задержки. Маршрутизацией не используется. Тип select выбран
  // намеренно: у него нет interval, то есть фонового опроса членов не будет
  // (в группе есть обходной ws-узел с платным трафиком).
  if (exNames.length) {
    const g = { name: 'RH-Явные', policies: exNames };
    if (!safe) g.latency_test_url = TEST_URL_PROXY;
    groups.push({ select: g });
  }

  const rules = RULE_SETS.map(function (r) {
    return { rule_set: { match: r.url, policy: r.policy, update_interval: 86400 } };
  });
  rules.push({ default: { policy: 'RH-Главный' } });

  const scriptings = [{
    schedule: {
      name: 'RH-K4-Проба',
      cron: '*/5 * * * *',
      script_url: base + '/script/k4.js?key=' + key,
      update_interval: 300,
      timeout: 120,
      env: {
        RH_POST_URL: base + '/probe?key=' + key,
        RH_GROUP: 'RH-Пул-Обычные',
        RH_NODE: nodeName || '',
        RH_NODE2: normalNames[0] || '',    // явно объявленный узел
        RH_GROUP2: exNames.length ? 'RH-Явные' : '',
        RH_TEST_URL: TEST_URL_PROXY,
        RH_HEAVY: '0'
      }
    }
  }];

  const out = {
    auto_update: { url: profUrl, interval: 86400 },
    ipv6: false,
    block_quic: false,
    close_connections_on_policy_change: true,
    bypass_tunnel_proxy: ['*.local', '192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12'],
    real_ip_domains: ['*.apple.com', '*.icloud.com', '*.push.apple.com'],
    include_all_networks: false,
    compat_route: false,
    proxy_latency_test_url: TEST_URL_PROXY,
    direct_latency_test_url: TEST_URL_DIRECT
  };
  // proxies объявляются ДО групп: группа RH-Явные на них ссылается по имени.
  if (ex.length) out.proxies = ex.map(function (e) { return { vless: e.node }; });
  out.policy_groups = groups;
  out.rules = rules;
  out.scriptings = scriptings;
  return out;
}

// Полный набор явных узлов: обычные + один обходной ws (если найден).
function collectExplicit(text) {
  const list = explicitNodes(text, EXPLICIT_N);
  const ws = bypassWsNode(text, WS_NODE_NAME);
  if (ws) list.push(ws);
  return list;
}

// ------------------------------------------------------------- обработчики
function gate(reg, key, tok) {
  if (!KEY_RE.test(key)) return textResp('bad key', 400);
  if (!reg[key]) return textResp('unknown key', 403);
  if (!tok || tok !== reg[key].token) {
    return textResp('RouteHub-стенд: нужен токен.\nФормат: <origin>/t/<token>/profile?key=' + key, 403);
  }
  return null;
}

async function handleNodes(url, env, tok) {
  const key = url.searchParams.get('key') || '';
  const reg = await loadRegistry(env);
  const bad = gate(reg, key, tok);
  if (bad) return bad;
  const sub = await getSub(env, false);
  return textResp(utf8ToB64(sub.text));
}

async function handleProfile(url, env, tok) {
  const key = url.searchParams.get('key') || '';
  const reg = await loadRegistry(env);
  const bad = gate(reg, key, tok);
  if (bad) return bad;
  const safe = url.searchParams.get('safe') === '1';
  const base = url.origin + '/t/' + reg[key].token;
  let nodeName = '', explicit = [];
  try {
    const sub = await getSub(env, false);
    nodeName = firstNormalNode(sub.text);
    explicit = collectExplicit(sub.text);
  } catch (e) { }
  reg[key].last_profile_ts = new Date().toISOString();
  try { await kvPutJSON(env, 'devices', reg); } catch (e) { }
  const head = '# RouteHub — профиль стенда Egern, worker ' + WORKER_VER +
    ' / скрипт ' + K4_REV + (safe ? ' (safe)' : '') +
    '\n# Сгенерирован ' + new Date().toISOString() +
    '\n# Вручную в UI ничего не создавать: профиль перезапишет.\n';
  return textResp(head + yamlDoc(buildProfile(base, key, safe, nodeName, explicit)), 200, 'text/yaml');
}

async function handleScript(url, env, tok) {
  const key = url.searchParams.get('key') || '';
  const reg = await loadRegistry(env);
  const bad = gate(reg, key, tok);
  if (bad) return bad;
  return textResp(K4_SCRIPT, 200, 'application/javascript');
}

async function handleProbe(request, url, env, tok) {
  const key = url.searchParams.get('key') || '';
  const reg = await loadRegistry(env);
  const bad = gate(reg, key, tok);
  if (bad) return bad;
  const dbKey = 'probe:' + key;

  if (request.method === 'GET') {
    const cur = await kvGetJSON(env, dbKey);
    const n = parseInt(url.searchParams.get('n') || '0', 10);
    const items = cur || [];
    return json({ worker: WORKER_VER, script: K4_REV, key: key, runs: items.length,
                  items: n > 0 ? items.slice(0, n) : items });
  }

  const body = await request.text();
  if (body.length > PROBE_MAX_BYTES) return textResp('отчёт слишком велик', 413);
  let rep;
  try { rep = JSON.parse(body); } catch (e) { return textResp('не JSON', 400); }
  const list = (await kvGetJSON(env, dbKey)) || [];
  list.unshift({ got: new Date().toISOString(), report: rep });
  await kvPutJSON(env, dbKey, list.slice(0, PROBE_KEEP));
  return json({ ok: true, stored: Math.min(list.length, PROBE_KEEP) });
}

async function handleAdminKeys(url, env) {
  const given = url.searchParams.get('admin') || '';
  const real = env.ADMIN_KEY || '';
  if (!real) return textResp('ADMIN_KEY не задан (секрет CF)', 503);
  if (given.length !== real.length || given !== real) {
    await new Promise(function (r) { setTimeout(r, 300); });
    return textResp('нет доступа', 403);
  }
  const reg = await loadRegistry(env);
  const out = {};
  for (const k in reg) {
    const base = url.origin + '/t/' + reg[k].token;
    out[k] = {
      profile: base + '/profile?key=' + k,
      profile_safe: base + '/profile?key=' + k + '&safe=1',
      nodes: base + '/nodes?key=' + k,
      script: base + '/script/k4.js?key=' + k,
      probe: base + '/probe?key=' + k,
      probe_last: base + '/probe?key=' + k + '&n=1',
      last_profile_ts: reg[k].last_profile_ts || null
    };
  }
  return json({ worker: WORKER_VER, script: K4_REV, devices: out });
}

async function handleHealth(env) {
  const out = { worker: WORKER_VER, script: K4_REV, stand: 'egern', now: new Date().toISOString() };
  try {
    const row = await env.RH_DB.prepare('SELECT count(*) AS n FROM kv').first();
    out.db = 'ok';
    out.kv_keys = row ? row.n : null;
    const c = await kvGetJSON(env, 'sub_cache');
    out.sub_nodes = c ? c.n : 0;
    out.sub_age_min = c ? Math.round((Date.now() - c.ts) / 60000) : null;
    if (c && c.text) {
      out.sub_named = subNames(c.text).length;
      out.probe_node = firstNormalNode(c.text) || null;
      out.explicit = collectExplicit(c.text).map(function (e) {
        return { name: e.meta.name, label: e.meta.label, type: e.meta.type, security: e.meta.security };
      });
    }
    const p = await kvGetJSON(env, 'probe:' + STAND_KEY);
    out.probe_runs = p ? p.length : 0;
    out.probe_last = p && p[0] ? p[0].got : null;
  } catch (e) {
    out.db = 'error';
    out.db_error = String(e && e.message || e);
  }
  return json(out);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let tok = '';
    const pm = url.pathname.match(PATH_TOKEN_RE);
    if (pm) { tok = pm[1]; url.pathname = pm[2] || '/'; }
    else {
      const qt = url.searchParams.get('token') || '';
      if (TOKEN_RE.test(qt)) tok = qt;
    }
    const m = request.method;
    try {
      if (m === 'GET' && url.pathname === '/health') return await handleHealth(env);
      if (m === 'GET' && url.pathname === '/admin/keys') return await handleAdminKeys(url, env);
      if (m === 'GET' && url.pathname === '/nodes') return await handleNodes(url, env, tok);
      if (m === 'GET' && url.pathname === '/profile') return await handleProfile(url, env, tok);
      if (m === 'GET' && url.pathname === '/script/k4.js') return await handleScript(url, env, tok);
      if ((m === 'GET' || m === 'POST') && url.pathname === '/probe') {
        return await handleProbe(request, url, env, tok);
      }
      return json({ error: 'not found', worker: WORKER_VER }, 404);
    } catch (err) {
      return textResp('error: ' + (err && err.message ? err.message : 'unknown'), 500);
    }
  }
};

export const __test = { buildProfile, yamlDoc, yamlStr, collectExplicit, RE_NORMAL, RE_BYPASS, WORKER_VER };

// ХВОСТОВОЙ СТРАЖ — строка без перевода в конце файла; мусор после неё —