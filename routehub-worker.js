// =============================================================
// routehub-worker.js — Cloudflare Worker (Этап E, личные подписки)
// VERSION: worker v1.4.0 (2026-06-11) — ДАШБОРД: GET /dashboard?key=kN (JSON):
//   версия конфига, возраст кэша подписки, время последних /config и /nodes,
//   остаток ГБ (из subscription-userinfo), узлы W/C с метриками+☎, режим РКН
//   (из KV rkn:<kN>, пишет скрипт routehub-rkn на устройстве). last_config_ts/
//   last_nodes_ts пишутся при КАЖДОМ запросе /config и /nodes.
// VERSION: worker v1.3.0 (2026-06-11) — ОБХОД КЭША КОНФИГА: fetch(CONFIG_URL)
//   с cache:'no-store' + ?t=now — /config больше не отдаёт устаревший routehub.conf
//   из кэша CDN GitHub после коммита. Подписка (/nodes, KV) — без изменений.
// VERSION: worker v1.2.0 (2026-06-11) — ЗВОНКИ: маркер ☎ (voiceOk) в метке
//   узлов, годных для голоса (jit<=30, bl<=50, med<=160; раздельно 🛜/📱).
//   Группы RH-Звонки фильтруются по ☎ (фильтр 🛜.*☎ / 📱.*☎ в conf).
// VERSION: worker v1.1.0 (2026-06-11) — ЧИСТКА: гист-сид удалён, KV —
//   единственное хранилище. env GIST_TOKEN/GIST_ID/MASTER_FILE больше не нужны.
// VERSION: worker v1.0.1 — /refresh ходит к Lastdep напрямую, сбой = ok:false+причина.
// VERSION: worker v1.0.0 — МИГРАЦИЯ НА KV:
//   * Данные в Cloudflare KV (binding RH_KV): sub_cache (узлы+заголовки
//     подписки), devices (реестр+флаги; править в KV-дашборде), metrics:<kN>.
//   * Worker САМ качает подписку Lastdep (заголовки/сортировка — как было в
//     publish_nodes.py): stale-while-revalidate — кэш старше FRESH_MS (10 мин)
//     при ЛЮБОМ запросе обновляется синхронно (ручное/авто обновление Loon
//     неразличимы — оба получают свежее); сбой апстрима -> старый кэш.
//     Заголовки подписки (subscription-userinfo = остаток ГБ и пр.) берутся живьём.
//   * Cron Trigger (раз в 2 ч) — фоновое обновление кэша.
//   * Балл: задержка = med (медиана проб), фолбэк rtt. Метка ↓ — rtt (min).
//
// ОДНА ССЫЛКА НА ВСЕХ — НЕВОЗМОЖНА без ?key: Loon не передаёт никакого
//   идентификатора устройства в запросе подписки/конфига (UA общий, IP
//   меняется, cookie не хранятся). key=kN — единственный идентификатор;
//   привязка устройства к ключу — АВТОМАТИЧЕСКАЯ (nonce при первом POST
//   /speed), запасной свободный ключ создаётся сам (ensureFreeSpare).
//
// GET  /config?key=kN  -> конфиг (AI-тиеры, script-path, argument).
// GET  /nodes?key=kN   -> оба набора (🛜+📱) + обход; base64; no-store; заголовки подписки.
// GET  /refresh?key=kN -> принудительно обновить подписку в KV СЕЙЧАС (без отката на кэш).
// GET  /dashboard?key=kN -> JSON для дашборда (статус обновлений, узлы, ГБ, режим РКН).
// GET  /status?key=kN  -> диагностика (+ возраст кэша подписки).
// POST /speed          -> метрики устройства (KV).
// GET  /whoami         -> детект сети/оператора по request.cf.
// env: RH_KV (KV binding), SUBSCRIPTION_URL + SUB_HWID (секреты CF), CONFIG_URL.
// =============================================================

const METRIC_SEP = ' \u00B7 ';
const DEAD = '\u26D4';                 // ⛔
const ICON_WIFI = '\uD83D\uDEDC';      // 🛜
const ICON_CELL = '\uD83D\uDCF1';      // 📱
const NODATA = '\u2205';               // ∅
const BLK = ['\u2581', '\u2583', '\u2585', '\u2587', '\u2588']; // ▁▃▅▇█
const SUP_PLUS = '\u207A';             // ⁺
const SUP_DIG = ['\u2070', '\u00B9', '\u00B2', '\u00B3', '\u2074', '\u2075', '\u2076', '\u2077', '\u2078', '\u2079'];
const KEY_RE = /^k\d+$/;
const FLAGS = ['cell_unlim', 'ewma', 'show_rtt', 'auto_refresh'];
const CELL_HINTS = ['mts', 'mobile telesystems', 'megafon', 'vimpelcom', 'beeline',
  'tele2', 't2 mobile', 'yota', 'mobile', 'cellular', 'wireless', 'lte', 'gsm'];

const FRESH_MS = 10 * 60 * 1000;
const NODE_PREFIXES = ['vless://', 'vmess://', 'trojan://', 'ss://'];
const META_HEADERS = ['subscription-userinfo', 'subscription-ping-onopen-enabled',
  'subscriptions-collapse', 'profile-title', 'profile-update-interval',
  'profile-web-page-url', 'announce', 'announce-url', 'support-url',
  'provider', 'ping-result'];

const DE = '\uD83C\uDDE9\uD83C\uDDEA'; // 🇩🇪
const RU = '\uD83C\uDDF7\uD83C\uDDFA'; // 🇷🇺
const BY = '\uD83C\uDDE7\uD83C\uDDFE'; // 🇧🇾
const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/u;
const FLAG_START_RE = /^\s*([\u{1F1E6}-\u{1F1FF}]{2})/u;
const PROX = {
  '\uD83C\uDDE9\uD83C\uDDEA': 0,  '\uD83C\uDDF3\uD83C\uDDF1': 1,  '\uD83C\uDDE8\uD83C\uDDFF': 2,
  '\uD83C\uDDE6\uD83C\uDDF9': 3,  '\uD83C\uDDF5\uD83C\uDDF1': 4,  '\uD83C\uDDEB\uD83C\uDDF7': 5,
  '\uD83C\uDDE7\uD83C\uDDEA': 6,  '\uD83C\uDDE8\uD83C\uDDED': 7,  '\uD83C\uDDE9\uD83C\uDDF0': 8,
  '\uD83C\uDDF8\uD83C\uDDEA': 9,  '\uD83C\uDDF3\uD83C\uDDF4': 10, '\uD83C\uDDEB\uD83C\uDDEE': 11,
  '\uD83C\uDDEA\uD83C\uDDEA': 12, '\uD83C\uDDF1\uD83C\uDDFB': 13, '\uD83C\uDDF1\uD83C\uDDF9': 14,
  '\uD83C\uDDEC\uD83C\uDDE7': 15, '\uD83C\uDDEE\uD83C\uDDEA': 16, '\uD83C\uDDEA\uD83C\uDDF8': 17,
  '\uD83C\uDDEE\uD83C\uDDF9': 18, '\uD83C\uDDF7\uD83C\uDDF4': 19, '\uD83C\uDDE7\uD83C\uDDFE': 20,
  '\uD83C\uDDF9\uD83C\uDDF7': 22, '\uD83C\uDDF7\uD83C\uDDFA': 23, '\uD83C\uDDF0\uD83C\uDDFF': 24,
  '\uD83C\uDDE6\uD83C\uDDF2': 25, '\uD83C\uDDE6\uD83C\uDDEA': 26, '\uD83C\uDDEE\uD83C\uDDF3': 27,
  '\uD83C\uDDF8\uD83C\uDDEC': 28, '\uD83C\uDDF9\uD83C\uDDED': 29, '\uD83C\uDDEF\uD83C\uDDF5': 30,
  '\uD83C\uDDF0\uD83C\uDDF7': 31, '\uD83C\uDDFA\uD83C\uDDF8': 32, '\uD83C\uDDE8\uD83C\uDDE6': 33,
  '\uD83C\uDDE7\uD83C\uDDF7': 34, '\uD83C\uDDE6\uD83C\uDDF7': 35, '\uD83C\uDDF3\uD83C\uDDEC': 36,
};
function proxOf(fl) { return (fl in PROX) ? PROX[fl] : 99; }

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

const SCORE_WS = 0.40, SCORE_WR = 0.30, SCORE_WJ = 0.20, SCORE_WB = 0.10;
const FLOOR_RTT = 30, FLOOR_JIT = 10, FLOOR_BL = 20;
const VOICE_JIT = 30, VOICE_BL = 50, VOICE_MED = 160; // пороги голосовой пригодности (☎)
const VOICE = '\u260E'; // ☎ маркер пригодности для звонков
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

function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

async function kvGetJSON(env, k) { const s = await env.RH_KV.get(k); if (!s) return null; try { return JSON.parse(s); } catch (e) { return null; } }
async function kvPutJSON(env, k, o) { await env.RH_KV.put(k, JSON.stringify(o)); }

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
function tagOf(name) {
  if (name.indexOf('[\u041E\u0431\u0445\u043E\u0434') >= 0) return 'bypass';
  if (name.indexOf('[VPN]') >= 0) return 'vpn';
  if (name.indexOf('\u0418\u0433\u0440\u044B') >= 0) return 'game';
  return 'other';
}
function classifyNet(asOrg) {
  const s = (asOrg || '').toLowerCase();
  for (const h of CELL_HINTS) if (s.indexOf(h) >= 0) return 'cell';
  return 'wifi';
}

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
    if (nm.indexOf('[VPN]') < 0) continue;
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

async function loadRegistry(env) {
  let reg = await kvGetJSON(env, 'devices');
  if (reg) return reg;
  reg = { k1: { status: 'free' } };
  await kvPutJSON(env, 'devices', reg);
  return reg;
}
function ensureFreeSpare(reg) {
  for (const k in reg) if (reg[k].status === 'free') return;
  let max = 0;
  for (const k in reg) { const n = parseInt(k.slice(1), 10); if (n > max) max = n; }
  reg['k' + (max + 1)] = { status: 'free' };
}
function ensureFlags(reg) {
  let ch = false;
  for (const k in reg) {
    const e = reg[k];
    for (const f of FLAGS) if (typeof e[f] !== 'boolean') { e[f] = false; ch = true; }
  }
  return ch;
}

function handleWhoami(req) {
  const cf = req.cf || {};
  const ip = req.headers.get('CF-Connecting-IP') || '';
  const aso = cf.asOrganization || '';
  return jsonResp({ ip: ip, asn: cf.asn || null, aso: aso, country: cf.country || null, net: classifyNet(aso) });
}

function buildAiTiers(masterLines, state) {
  const cnt = {}, spd = {};
  for (const line of masterLines) {
    const name = decodeName(fragOf(line));
    if (tagOf(name) !== 'vpn') continue;
    const fl = flagOf(name);
    if (!fl) continue;
    cnt[fl] = (cnt[fl] || 0) + 1;
    let s = 0;
    const st = state[matchKey(name)];
    if (st) {
      if (st.w && !st.w.dead) s = Math.max(s, +st.w.down || 0);
      if (st.c && !st.c.dead) s = Math.max(s, +st.c.down || 0);
    }
    if (!(fl in spd) || s > spd[fl]) spd[fl] = s;
  }
  const others = Object.keys(cnt).filter(function (f) { return f !== DE && f !== RU && f !== BY; });
  const multi = others.filter(function (f) { return cnt[f] >= 2; }).sort(function (a, b) {
    return (cnt[b] - cnt[a]) || ((spd[b] || 0) - (spd[a] || 0)) || (proxOf(a) - proxOf(b));
  });
  const tiers = [];
  if (cnt[DE]) tiers.push(DE);
  for (const f of multi) tiers.push(f);
  return tiers;
}
function aiBlocks(tiers) {
  const fW = [], fC = [], gW = [], gC = [];
  tiers.forEach(function (fl, i) {
    const id = (i + 1 < 10 ? '0' : '') + (i + 1);
    fW.push('RH-Filter-W-AI' + id + ' = NameRegex, Lastdep, FilterKey = ' + fl + '.*\\[VPN\\].*' + ICON_WIFI);
    fC.push('RH-Filter-C-AI' + id + ' = NameRegex, Lastdep, FilterKey = ' + fl + '.*\\[VPN\\].*' + ICON_CELL);
    gW.push('RH-Filter-W-AI' + id);
    gC.push('RH-Filter-C-AI' + id);
  });
  const exclAlt = [RU, BY].concat(tiers).join('|');
  fW.push('RH-Filter-W-AIrest = NameRegex, Lastdep, FilterKey = ^(?!.*(' + exclAlt + ')).*\\[VPN\\].*' + ICON_WIFI);
  fC.push('RH-Filter-C-AIrest = NameRegex, Lastdep, FilterKey = ^(?!.*(' + exclAlt + ')).*\\[VPN\\].*' + ICON_CELL);
  gW.push('RH-Filter-W-AIrest');
  gC.push('RH-Filter-C-AIrest');
  const filters = fW.join('\n') + '\n' + fC.join('\n');
  const u = 'url=http://cp.cloudflare.com/generate_204, interval=600';
  const groups =
    'RH-AI = select, RH-AI-W, RH-AI-C, img-url=https://cdn.jsdelivr.net/gh/Orz-3/mini@master/Color/AI.png\n' +
    'RH-AI-W = fallback, ' + gW.join(', ') + ', RH-Filter-\u041e\u0431\u0445\u043e\u0434, ' + u + '\n' +
    'RH-AI-C = fallback, ' + gC.join(', ') + ', RH-Filter-\u041e\u0431\u0445\u043e\u0434, ' + u;
  return { filters: filters, groups: groups };
}

async function handleConfig(url, env) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return new Response('bad key', { status: 400 });

  const reg = await loadRegistry(env);
  if (!reg[key]) return new Response('unknown key', { status: 403 });
  ensureFlags(reg);
  reg[key].last_config_ts = new Date().toISOString();
  try { await kvPutJSON(env, 'devices', reg); } catch (e) {}

  // Обход кэша: no-store (кэш Workers) + ?t=now (CDN GitHub считает ресурс новым)
  const cfgUrl = env.CONFIG_URL + (env.CONFIG_URL.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
  const cr = await fetch(cfgUrl, { headers: { 'User-Agent': 'routehub-worker' }, cache: 'no-store' });
  if (!cr.ok) throw new Error('config fetch ' + cr.status);
  let conf = await cr.text();
  const cv = confVersion(conf);
  if (cv && reg[key].conf_ver !== cv) { reg[key].conf_ver = cv; try { await kvPutJSON(env, 'devices', reg); } catch (e) {} }

  const sub = await getSub(env, false);
  const masterLines = sub.text.split('\n').filter(Boolean);
  const state = (await kvGetJSON(env, 'metrics:' + key)) || {};
  const blocks = aiBlocks(buildAiTiers(masterLines, state));
  conf = conf.replace('# __RH_AI_FILTERS__', blocks.filters);
  conf = conf.replace('# __RH_AI_GROUPS__', blocks.groups);

  const subUrl = url.origin + '/nodes?key=' + key + ',udp=true,enabled=true';
  conf = conf.replace(/^Lastdep = .*$/m, 'Lastdep = ' + subUrl);
  const scriptBase = env.CONFIG_URL.replace(/[^/]+$/, '');
  conf = conf.replace(/script-path=(routehub-[^,\s]+)/g, 'script-path=' + scriptBase + '$1');
  const sFlags = [];
  if (reg[key].cell_unlim) sFlags.push('cellall');
  if (reg[key].ewma) sFlags.push('ewma');
  conf = conf.replace('tag=RH-Speed', 'tag=RH-Speed, argument=' + key + '|' + url.origin + '|' + sFlags.join(','));
  const nOpts = reg[key].auto_refresh ? 'autorefresh' : '';
  conf = conf.replace('tag=RH-Net', 'tag=RH-Net, argument=' + key + '|' + url.origin + '|' + nOpts);

  return new Response(conf, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function handleStatus(url, env) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  const reg = await loadRegistry(env);
  const e = reg[key];
  if (!e) return jsonResp({ error: 'unknown key' }, 403);
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

function labelOf(icon, m, max, showRtt) {
  if (m.dead) return icon + DEAD;
  const pct = max > 0 ? Math.round(m.down / max * 100) : 0;
  const v = voiceOk(m) ? VOICE : '';
  return icon + speedBlock(m.down) + ' ' + supNum(pct) + v + (showRtt ? (' ' + m.down + '\u2193' + m.rtt) : '');
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

async function handleNodes(url, env) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return new Response('bad key', { status: 400 });
  const reg = await loadRegistry(env);
  if (!reg[key]) return new Response('unknown key', { status: 403 });
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

async function handleRefresh(url, env) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  const reg = await loadRegistry(env);
  if (!reg[key]) return jsonResp({ error: 'unknown key' }, 403);
  try {
    const fresh = await fetchUpstream(env);
    await kvPutJSON(env, 'sub_cache', fresh);
    return jsonResp({ ok: true, nodes: fresh.n, updated: new Date(fresh.ts).toISOString() });
  } catch (e) {
    return jsonResp({ ok: false, error: String(e && e.message || e) }, 502);
  }
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
        jit: it.m.jit || 0,
        bl: (it.m.bl == null ? null : it.m.bl),
        pct: mx > 0 ? Math.round((it.m.down || 0) / mx * 100) : 0,
        score: +(scoreOf(it.m, mx) * 100).toFixed(0),
        voice: voiceOk(it.m),
      };
    }).sort(function (a, b) { return b.score - a.score; });
  }
  return { wifi: pack('w'), cell: pack('c') };
}

async function handleDashboard(url, env) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  const reg = await loadRegistry(env);
  const e = reg[key];
  if (!e) return jsonResp({ error: 'unknown key' }, 403);
  const c = await kvGetJSON(env, 'sub_cache');
  const state = (await kvGetJSON(env, 'metrics:' + key)) || {};
  const masterLines = (c && c.text) ? c.text.split('\n').filter(Boolean) : [];
  const nodes = nodesForDash(masterLines, state);
  const rkn = (await kvGetJSON(env, 'rkn:' + key)) || null;
  const traffic = c ? parseUserinfo(c.meta || {}) : null;
  return jsonResp({
    key: key,
    worker: 'v1.4.0',
    conf_ver: e.conf_ver || null,
    status: e.status || null,
    sub_age_min: c ? Math.round((Date.now() - c.ts) / 60000) : null,
    sub_nodes: c ? (c.n || masterLines.length) : 0,
    sub_ts: c ? new Date(c.ts).toISOString() : null,
    last_config_ts: e.last_config_ts || null,
    last_nodes_ts: e.last_nodes_ts || null,
    traffic: traffic,
    rkn: rkn,
    counts: { wifi: nodes.wifi.length, cell: nodes.cell.length,
      voice_wifi: nodes.wifi.filter(function (n) { return n.voice; }).length,
      voice_cell: nodes.cell.filter(function (n) { return n.voice; }).length },
    nodes: nodes,
    server_now: new Date().toISOString(),
  });
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

async function handleSpeed(req, env) {
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }

  const key = (data && data.key) || '';
  const nonce = String((data && data.nonce) || '');
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  if (!nonce) return jsonResp({ error: 'no nonce' }, 400);

  const reg = await loadRegistry(env);
  if (!reg[key]) return jsonResp({ error: 'unknown key' }, 403);
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

  let labeled = 0;
  for (const k in state) if (state[k] && (state[k].w || state[k].c)) labeled++;

  await kvPutJSON(env, 'metrics:' + key, state);
  await kvPutJSON(env, 'devices', reg);

  return jsonResp({ ok: true, key: key, status: e.status, labeled: labeled, sent_wifi: sentW, sent_cell: sentC });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/whoami') return handleWhoami(req);
      if (req.method === 'GET' && url.pathname === '/config') return await handleConfig(url, env);
      if (req.method === 'GET' && url.pathname === '/nodes') return await handleNodes(url, env);
      if (req.method === 'GET' && url.pathname === '/refresh') return await handleRefresh(url, env);
      if (req.method === 'GET' && url.pathname === '/dashboard') return await handleDashboard(url, env);
      if (req.method === 'GET' && url.pathname === '/status') return await handleStatus(url, env);
      if (req.method === 'POST' && url.pathname === '/speed') return await handleSpeed(req, env);
      return new Response('routehub-worker: not found', { status: 404 });
    } catch (err) {
      return new Response('error: ' + (err && err.message ? err.message : 'unknown'), { status: 500 });
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(getSub(env, true).catch(function () {}));
  },
};
