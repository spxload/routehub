/* =====================================================================
 *  AI Region Switch — Loon reader v5.0 (2026-05-21)
 *
 *  НОВАЯ АРХИТЕКТУРА: тестирование вынесено на сервер (GitHub Actions).
 *  Этот скрипт НЕ тестирует узлы. Он:
 *   1. Скачивает готовый ai-ratings.json с сервера.
 *   2. Применяет sticky-логику выбора узла для каждого AI.
 *   3. Через setSelectPolicy назначает узлы 5 группам.
 *
 *  Преимущества: быстро (<5с), без MITM, без нагрузки, без лимитов.
 *  Можно запускать хоть каждые 5 минут.
 * ===================================================================== */

const VERSION = '5.0';

// ===== ИСТОЧНИК ДАННЫХ =====
// Замените USER/REPO на свои. Скрипт пробует обе ссылки по очереди.
const RATINGS_URLS = [
  'https://raw.githubusercontent.com/spxload/ai-node-check/main/ai-ratings.json',
  'https://cdn.jsdelivr.net/gh/spxload/ai-node-check@main/ai-ratings.json'
];

// ===== СЕРВИСЫ =====
const SERVICES = {
  chatgpt:    { group: 'ИИ-ChatGPT',    label: 'ChatGPT' },
  claude:     { group: 'ИИ-Claude',     label: 'Claude' },
  gemini:     { group: 'ИИ-Gemini',     label: 'Gemini' },
  grok:       { group: 'ИИ-Grok',       label: 'Grok' },
  perplexity: { group: 'ИИ-Perplexity', label: 'Perplexity' }
};

// ===== PREFERRED =====
const PREFERRED_NODE_HINTS = [
  'Германия [VPN] #1',
  'Германия Напрямую #1',
  'Германия #1'
];

const COUNTRY_PRIORITY = [
  'DE','NL','CH','BE','FR','AT','GB','FI','SE','NO','PL','EE','LV','LT',
  'US','CA','JP','SG','KR'
];

const COOLDOWN_MS = 30 * 60 * 1000;
const MAX_DATA_AGE_MS = 12 * 60 * 60 * 1000;

const KEY_STATE = 'ai_switch_state';
const KEY_LOGS = 'ai_switch_logs';
const KEY_BLACKLIST = 'ai_switch_blacklist';

const now = () => Date.now();

function log(msg, lvl) {
  lvl = lvl || 'i';
  const line = `[${new Date().toISOString().slice(11,19)}] [${lvl}] ${msg}`;
  console.log(line);
  try {
    const raw = $persistentStore.read(KEY_LOGS);
    const logs = raw ? JSON.parse(raw) : [];
    logs.unshift(line);
    $persistentStore.write(JSON.stringify(logs.slice(0, 100)), KEY_LOGS);
  } catch(e) {}
}

function loadState() {
  try {
    const raw = $persistentStore.read(KEY_STATE);
    if (raw) {
      const s = JSON.parse(raw);
      s.assignments = s.assignments || {};
      return s;
    }
  } catch(e) { log('loadState: ' + e.message, 'w'); }
  return { version: VERSION, lastRun: 0, assignments: {} };
}

function saveState(s) {
  s.version = VERSION;
  $persistentStore.write(JSON.stringify(s), KEY_STATE);
}

function loadBlacklist() {
  try {
    const raw = $persistentStore.read(KEY_BLACKLIST);
    if (raw) return JSON.parse(raw);
  } catch(_) {}
  return { chatgpt: [], claude: [], gemini: [], grok: [], perplexity: [] };
}

function setPolicy(groupName, nodeName) {
  try {
    const r = $config.setSelectPolicy(groupName, nodeName);
    return r === true || r === undefined;
  } catch(e) {
    log(`setSelectPolicy(${groupName}): ${e.message}`, 'e');
    return false;
  }
}

function httpGet(url) {
  return new Promise((resolve) => {
    $httpClient.get({
      url,
      timeout: 15000,
      headers: { 'User-Agent': 'LoonAI/' + VERSION, 'Cache-Control': 'no-cache' }
    }, (err, resp, body) => {
      if (err || !resp) resolve({ ok: false, error: String(err) });
      else resolve({ ok: true, status: resp.status, body: body || '' });
    });
  });
}

async function fetchRatings() {
  for (const url of RATINGS_URLS) {
    log(`Запрос: ${url.slice(0, 55)}...`);
    const r = await httpGet(url);
    if (r.ok && r.status === 200 && r.body) {
      try {
        const data = JSON.parse(r.body);
        if (data && data.nodes) {
          log(`Данные получены: ${Object.keys(data.nodes).length} узлов`);
          return data;
        }
      } catch(e) {
        log(`JSON-парсинг упал: ${e.message}`, 'w');
      }
    } else {
      log(`Не удалось (${r.status || r.error})`, 'w');
    }
  }
  return null;
}

function pickSticky(svcName, nodes, prev, blacklist) {
  const bl = (blacklist && blacklist[svcName]) || [];

  const working = Object.entries(nodes)
    .filter(([name, r]) =>
      r && r.ok && r.services &&
      r.services[svcName] === 'pass' &&
      bl.indexOf(name) === -1
    );

  if (working.length === 0) return null;

  for (const hint of PREFERRED_NODE_HINTS) {
    const matches = working
      .filter(([name, _]) => name.indexOf(hint) !== -1)
      .sort((a, b) => a[1].latency - b[1].latency);
    if (matches.length > 0) {
      return { node: matches[0][0], country: matches[0][1].country, reason: 'preferred:' + hint };
    }
  }

  if (prev && prev.node && nodes[prev.node] &&
      nodes[prev.node].ok && nodes[prev.node].services[svcName] === 'pass' &&
      bl.indexOf(prev.node) === -1) {
    return { node: prev.node, country: nodes[prev.node].country, reason: 'stick-node' };
  }

  if (prev && prev.country) {
    const same = working
      .filter(([_, r]) => r.country === prev.country)
      .sort((a, b) => a[1].latency - b[1].latency);
    if (same.length > 0) {
      return { node: same[0][0], country: prev.country, reason: 'stick-country' };
    }
  }

  for (const country of COUNTRY_PRIORITY) {
    if (prev && country === prev.country) continue;
    const cand = working
      .filter(([_, r]) => r.country === country)
      .sort((a, b) => a[1].latency - b[1].latency);
    if (cand.length > 0) {
      return { node: cand[0][0], country, reason: 'country-priority:' + country };
    }
  }

  const history = (prev && Array.isArray(prev.history)) ? prev.history : [];
  for (const country of history) {
    if (prev && country === prev.country) continue;
    if (COUNTRY_PRIORITY.indexOf(country) !== -1) continue;
    const cand = working
      .filter(([_, r]) => r.country === country)
      .sort((a, b) => a[1].latency - b[1].latency);
    if (cand.length > 0) {
      return { node: cand[0][0], country, reason: 'history' };
    }
  }

  working.sort((a, b) => a[1].latency - b[1].latency);
  return { node: working[0][0], country: working[0][1].country, reason: 'global-best' };
}

async function main() {
  const t0 = now();
  log(`=== AI Region Switch reader v${VERSION} ===`);

  const data = await fetchRatings();
  if (!data) {
    log('Не удалось получить данные ни с одного источника', 'e');
    $notification.post('🤖 AI-Switch', 'Ошибка', 'Сервер недоступен. Проверьте URL в скрипте.');
    $done({});
    return;
  }

  const ageMs = now() - (data.updated || 0) * 1000;
  const ageMin = Math.round(ageMs / 60000);
  if (ageMs > MAX_DATA_AGE_MS) {
    log(`⚠️ Данные устарели: ${Math.round(ageMin/60)}ч назад`, 'w');
  } else {
    log(`Данные свежие: ${ageMin} мин назад`);
  }

  const nodes = data.nodes;
  const state = loadState();
  const blacklist = loadBlacklist();

  const okCount = Object.values(nodes).filter(n => n.ok).length;
  const totalCount = Object.keys(nodes).length;

  const switches = [];
  const summary = [];

  for (const [svcName, svcCfg] of Object.entries(SERVICES)) {
    const prev = state.assignments[svcName];
    let pick = pickSticky(svcName, nodes, prev, blacklist);

    if (!pick) {
      log(`${svcCfg.label}: ❌ нет рабочих узлов`, 'w');
      summary.push(`${svcCfg.label}:❌`);
      continue;
    }

    if (prev && prev.lastSwitched && (now() - prev.lastSwitched < COOLDOWN_MS)
        && prev.node && pick.node !== prev.node && pick.reason !== 'stick-node'
        && pick.reason.indexOf('preferred') !== 0
        && nodes[prev.node] && nodes[prev.node].ok
        && nodes[prev.node].services[svcName] === 'pass'
        && (blacklist[svcName] || []).indexOf(prev.node) === -1) {
      pick = { node: prev.node, country: prev.country, reason: 'cooldown' };
    }

    let history = (prev && Array.isArray(prev.history)) ? prev.history.slice() : [];
    if (pick.country) {
      history = [pick.country, ...history.filter(c => c !== pick.country)].slice(0, 5);
    }

    const changed = !prev || prev.node !== pick.node;
    state.assignments[svcName] = {
      node: pick.node, country: pick.country, reason: pick.reason,
      history,
      lastSwitched: changed ? now() : (prev && prev.lastSwitched) || now()
    };

    if (changed) {
      switches.push(`${svcCfg.label}: ${(prev && prev.node) || '∅'} → ${pick.node}`);
    }

    setPolicy(svcCfg.group, pick.node);
    summary.push(`${svcCfg.label}:${pick.country}`);
    log(`${changed ? '🔄' : '✓'} ${svcCfg.label} → [${pick.country}] ${pick.node} (${pick.reason})`);
  }

  const fb = state.assignments.chatgpt && state.assignments.chatgpt.node;
  if (fb) {
    setPolicy('ИИ-АВТО', fb);
    setPolicy('ИИ', fb);
  }

  state.lastRun = now();
  state.lastRunDuration = now() - t0;
  state.dataAge = ageMin;
  state.serverStats = data.stats || {};
  saveState(state);

  let body;
  if (switches.length > 0) {
    body = `🔄 ${switches.length} переключений\n${summary.join(' · ')}`;
  } else {
    body = `Без изменений · ${summary.join(' · ')}`;
  }
  $notification.post(
    '🤖 AI Region Switch',
    `Узлов: ${okCount}/${totalCount} · данные ${ageMin}мин`,
    body
  );

  log(`=== Готово за ${Math.round((now()-t0)/1000)}с ===`);
  $done({});
}

main().catch(err => {
  const msg = err && err.message || String(err);
  log('КРАШ: ' + msg, 'e');
  $notification.post('🤖 AI-Switch', 'Критическая ошибка', msg);
  $done({});
});
