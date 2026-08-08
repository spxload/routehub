// =============================================================
// routehub-egern-worker.js — Worker стенда Egern (ветка `egern`)
// VERSION: e0.2.4 (2026-08-08) — ШАГ 4.3: вторая диагностическая группа
//   RH-Проба-DIRECT-2 — разрешающий тест K2 (см. ЭТАП_K_ШАГ_4.3.md, 5.2).
//   e0.2.3 — первая диагностическая группа RH-Проба-DIRECT.
//   e0.2.2 — шаг 4.2 (узлы + минимальный профиль), принят на k3 2026-08-08:
//   5 групп, 52 узла в обычном пуле, 17 в обходе, предупреждений нет.
//   Решения и границы объёма — ЭТАП_K_ШАГ_4.2.md и ЭТАП_K_ШАГ_4.3.md.
//   Эндпоинты: GET /health, GET /t/<token>/nodes?key=kN,
//   GET /t/<token>/profile?key=kN (+ &safe=1 — см. ниже),
//   GET /admin/keys?admin=<ADMIN_KEY> — выдача ссылок устройства.
//   Параметр назван admin, а не key: key занят идентификатором устройства.
//   Полноценной панели у стенда нет и на шаге 4.3 не планируется.
//   Токен обязателен всегда: у стенда фаза 2 включена с самого начала.
// ЧЕГО ЗДЕСЬ НЕТ (сознательно, шаг 4.4): smart-группы и priorities, ИИ,
//   спидтест и POST /speed, вердикты, модули, свой DNS, conditional, панель.
// ПРО smart: в официальном примере Profile.yaml группы smart НЕТ, её YAML-форма
//   документацией не подтверждена. Минимальный профиль собран только на
//   документированных типах (external / fallback). Как только форма smart
//   подтвердится на устройстве — RH-Пул-Обычные меняется на smart, и туда же
//   приходят priorities. Из-за этого проверка K5 уезжает на шаг 4.4.
// ПРО &safe=1: вариант профиля без полей, форму которых подтвердить нечем
//   (latency_test_url на группе). На 2026-08-08 обычный вариант принят
//   устройством, то есть форма поля верна; safe сохранён как инструмент
//   для последующих правок. ВНИМАНИЕ: в safe обе диагностические группы
//   теряют latency_test_url и становятся неразличимы — K2 проверяется
//   ТОЛЬКО на обычном варианте профиля.
// ПРО ДИАГНОСТИЧЕСКИЕ ГРУППЫ (K1/K2): единственные группы с членом
//   DIRECT. Ни одно правило на них не ссылается — маршрутизация не меняется.
//   RH-Проба-DIRECT   — контроль, проба по cp.cloudflare.com. На 2026-08-08
//     член DIRECT получил 32–43 мс, то есть Egern ПРИНИМАЕТ DIRECT внутри
//     fallback и ТЕСТИРУЕТ его. Какой адрес использован — по величине
//     задержки не различимо: оба адреса — CDN с близкими точками.
//   RH-Проба-DIRECT-2 — разрешающий тест: проба по 192.0.2.1 (TEST-NET-1,
//     RFC 5737) — адрес НЕ маршрутизуется в интернете, недостижим ни
//     напрямую, ни через любой узел. Исход бинарный: отказ/таймаут у
//     члена DIRECT → групповой latency_test_url к DIRECT применяется
//     (модель «слабый DIRECT» переносится); сохранившиеся десятки
//     миллисекунд → используется direct_latency_test_url (не переносится).
// НАЙДЕНО НА УСТРОЙСТВЕ (2026-08-08, Egern 2.20.0):
//   `hijack_dns` — СПИСОК, а не булево: профиль с `hijack_dns: false` отвергнут
//   с текстом «invalid type: boolean `false`, expected a sequence». Поле убрано
//   (перехват DNS стенду не нужен). Вывод общего характера: Egern проверяет типы
//   и падает на ПЕРВОМ несоответствии, поэтому поля за ним остаются
//   непроверенными — профиль доводится итерациями, по одной ошибке за импорт.
//   Остальные поля верхнего уровня сверены с официальным примером Profile.yaml.
//   Списки rule_set (K7) приняты все шесть, включая Shadowrocket-формат
//   domains_banking.list; фактические политики совпали с ожидаемыми.
// ВАЖНО: боевой контур (Worker `routehub`, база `routehub-db`) не затрагивается.
//   Ветка `egern` в `main` не сливается.
// ИСТОРИЯ СБОРОК:
//   2026-08-07 — первая сборка проекта routehub-egern прошла до переключения
//   production-ветки и задеплоила код из `main` (боевой v1.9.2, биндинг на
//   боевую базу). Признак: /status?key=k1 отвечал «ссылка устарела», то есть
//   читал token_required из routehub-db. Лечение — production branch = egern
//   и повторная сборка. Галочку «Builds for non-production branches» держать
//   СНЯТОЙ: иначе пуш в main выгружает версии сюда под именем `routehub`.
// =============================================================

const WORKER_VER = 'e0.2.4';
const KEY_RE = /^k\d+$/;
const TOKEN_LEN = 32;
const TOKEN_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TOKEN_RE = /^[A-Za-z0-9]{16,64}$/;
const PATH_TOKEN_RE = /^\/t\/([A-Za-z0-9]{16,64})(\/.*)?$/;
const STAND_KEY = 'k3';                       // ключ стенда; k1/k2 живут на боевом
const FRESH_MS = 60 * 60 * 1000;
const NODE_PREFIXES = ['vless://', 'vmess://', 'trojan://', 'ss://'];

// Признак типа узла — слово в скобочном теге, НЕ значок провайдера (вывод 28).
// Обходные: `[Обход - <оператор>]`. Значка 🙏 в подписке нет, поэтому скелет
// из ЭТАП_K_EGERN.md 6.2 перенесён с поправкой (см. ЭТАП_K_ШАГ_4.2.md, п. 1.1).
// Подтверждено на устройстве 2026-08-08: 52 узла в обычном пуле, 17 в обходе.
const RE_NORMAL = '^(?!.*Обход)';
const RE_BYPASS = '\\[Обход';

const TEST_URL_PROXY = 'http://cp.cloudflare.com/generate_204';
const TEST_URL_DIRECT = 'http://www.msftconnecttest.com/connecttest.txt';
// TEST-NET-1 (RFC 5737): адрес зарезервирован для документации и не
// маршрутизуется в интернете — недостижим и напрямую, и через узел.
const TEST_URL_UNREACHABLE = 'http://192.0.2.1/generate_204';

// Класс A — анти-VPN: жёсткий DIRECT. Класс B — прочее РФ: RH-RU.
// Списки те же, что проверены в боевом конфиге C-draft-39.
// K7 (2026-08-08): все шесть приняты Egern, политики применяются как ожидалось.
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
// Имена узлов НЕ размечаются: ранжирование ушло в группы, разметка отменена
// журналом решений этапа K. Порядок — как отдал провайдер (сортировок нет).
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
// Свой сериализатор: структура профиля — только карты, списки и скаляры.
// Все строки берутся в двойные кавычки с экранированием, поэтому спецсимволы
// (regex со скобками и обратными слэшами, эмодзи) документ не ломают.
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
function buildProfile(base, key, safe) {
  const nodesUrl = base + '/nodes?key=' + key;
  const profUrl = base + '/profile?key=' + key + (safe ? '&safe=1' : '');

  // external — документированный способ подтянуть подписку прямо в группу.
  function pool(name, filter, interval) {
    return {
      external: {
        name: name,
        type: 'auto_test',
        urls: [nodesUrl],
        filter: filter,
        interval: interval,
        update_interval: 3600
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
    // Обход — раз в час (риск №1 раздела 10 ЭТАП_K_EGERN.md).
    pool('RH-Обход', RE_BYPASS, 3600),
    // Пробник состояния сети: зарубежная точка, а не конкретный домен —
    // ставка на статус одного домена рушится, когда домен вносят в whitelist.
    fb('RH-Проба-Обычная', ['RH-Пул-Обычные'], { latency_test_url: TEST_URL_PROXY }),
    // Класс B: норма — обычный узел, whitelist — обход. DIRECT убран намеренно.
    fb('RH-RU', ['RH-Проба-Обычная', 'RH-Обход'], { latency_test_url: TEST_URL_PROXY }),
    // Класс C и FINAL.
    fb('RH-Главный', ['RH-Пул-Обычные', 'RH-Обход'], { latency_test_url: TEST_URL_PROXY }),
    // Диагностика K1/K2 (шаг 4.3). Единственные группы с членом DIRECT;
    // ни одно правило на них не ссылается, маршрутизация не меняется.
    // Контроль: достижимый адрес пробы (2026-08-08 дал 32–43 мс у DIRECT).
    fb('RH-Проба-DIRECT', ['DIRECT', 'RH-Обход'], { latency_test_url: TEST_URL_PROXY }),
    // Разрешающий тест: адрес недостижим ни напрямую, ни через узел.
    // Отказ у DIRECT → групповой latency_test_url к нему применяется.
    fb('RH-Проба-DIRECT-2', ['DIRECT', 'RH-Обход'], { latency_test_url: TEST_URL_UNREACHABLE })
  ];

  const rules = RULE_SETS.map(function (r) {
    return { rule_set: { match: r.url, policy: r.policy, update_interval: 86400 } };
  });
  // Звонки отдельной группы на шаге 4.2 не получают (ЭТАП_K_ШАГ_4.2.md, 2.4).
  rules.push({ default: { policy: 'RH-Главный' } });

  return {
    auto_update: { url: profUrl, interval: 86400 },
    ipv6: false,
    block_quic: false,
    close_connections_on_policy_change: true,
    bypass_tunnel_proxy: ['*.local', '192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12'],
    real_ip_domains: ['*.apple.com', '*.icloud.com', '*.push.apple.com'],
    include_all_networks: false,
    compat_route: false,
    proxy_latency_test_url: TEST_URL_PROXY,
    direct_latency_test_url: TEST_URL_DIRECT,
    policy_groups: groups,
    rules: rules
  };
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
  reg[key].last_profile_ts = new Date().toISOString();
  try { await kvPutJSON(env, 'devices', reg); } catch (e) { }
  const head = '# RouteHub — профиль стенда Egern, worker ' + WORKER_VER +
    (safe ? ' (safe)' : '') + '\n# Сгенерирован ' + new Date().toISOString() +
    '\n# Вручную в UI ничего не создавать: профиль перезапишет.\n';
  return textResp(head + yamlDoc(buildProfile(base, key, safe)), 200, 'text/yaml');
}

async function handleAdminKeys(url, env) {
  const given = url.searchParams.get('admin') || '';
  const real = env.ADMIN_KEY || '';
  if (!real) return textResp('ADMIN_KEY не задан (секрет CF)', 503);
  if (given.length !== real.length || given !== real) {
    await new Promise(function (r) { setTimeout(r, 300); });   // притормозить перебор
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
      last_profile_ts: reg[k].last_profile_ts || null
    };
  }
  return json({ worker: WORKER_VER, devices: out });
}

async function handleHealth(env) {
  const out = { worker: WORKER_VER, stand: 'egern', now: new Date().toISOString() };
  try {
    const row = await env.RH_DB.prepare('SELECT count(*) AS n FROM kv').first();
    out.db = 'ok';
    out.kv_keys = row ? row.n : null;
    const c = await kvGetJSON(env, 'sub_cache');
    out.sub_nodes = c ? c.n : 0;
    out.sub_age_min = c ? Math.round((Date.now() - c.ts) / 60000) : null;
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
    try {
      if (request.method === 'GET' && url.pathname === '/health') return await handleHealth(env);
      if (request.method === 'GET' && url.pathname === '/admin/keys') return await handleAdminKeys(url, env);
      if (request.method === 'GET' && url.pathname === '/nodes') return await handleNodes(url, env, tok);
      if (request.method === 'GET' && url.pathname === '/profile') return await handleProfile(url, env, tok);
      return json({ error: 'not found', worker: WORKER_VER }, 404);
    } catch (err) {
      return textResp('error: ' + (err && err.message ? err.message : 'unknown'), 500);
    }
  }
};

export const __test = { buildProfile, yamlDoc, yamlStr, RE_NORMAL, RE_BYPASS, WORKER_VER };
