/* AI Switch Viewer v3 — табличный отчёт с эмодзи-флагами и статистикой.
 * Запускается вручную: Loon → Скрипты → Run.
 * Выводит структурированный отчёт в Script Output + уведомление. */

const KEY_STATE = 'ai_switch_state';
const KEY_LOGS = 'ai_switch_logs';

const FLAG = {
  DE:'🇩🇪',US:'🇺🇸',GB:'🇬🇧',FR:'🇫🇷',NL:'🇳🇱',JP:'🇯🇵',KR:'🇰🇷',
  SG:'🇸🇬',HK:'🇭🇰',CH:'🇨🇭',NO:'🇳🇴',SE:'🇸🇪',FI:'🇫🇮',PL:'🇵🇱',
  TR:'🇹🇷',EE:'🇪🇪',RU:'🇷🇺',BY:'🇧🇾',UA:'🇺🇦',CN:'🇨🇳',IN:'🇮🇳',
  AE:'🇦🇪',BR:'🇧🇷',CA:'🇨🇦',AR:'🇦🇷',KZ:'🇰🇿',BE:'🇧🇪',AM:'🇦🇲',
  RO:'🇷🇴',CZ:'🇨🇿',NG:'🇳🇬',TH:'🇹🇭',ES:'🇪🇸',IT:'🇮🇹',PT:'🇵🇹',
  IE:'🇮🇪',AU:'🇦🇺',NZ:'🇳🇿',MX:'🇲🇽',ZA:'🇿🇦',VN:'🇻🇳',ID:'🇮🇩',
  PH:'🇵🇭',MY:'🇲🇾',IL:'🇮🇱',SA:'🇸🇦',QA:'🇶🇦',LV:'🇱🇻',LT:'🇱🇹',
  AT:'🇦🇹',DK:'🇩🇰',IS:'🇮🇸',GE:'🇬🇪'
};

const flag = (cc) => cc ? (FLAG[cc] || '['+cc+']') : '❓';

const NAMES = {
  DE:'Germany',US:'USA',GB:'UK',FR:'France',NL:'Netherlands',JP:'Japan',
  KR:'S.Korea',SG:'Singapore',CH:'Switzerland',NO:'Norway',FI:'Finland',
  PL:'Poland',TR:'Turkey',EE:'Estonia',CA:'Canada',JP2:'Japan',BE:'Belgium',
  AM:'Armenia',KZ:'Kazakhstan',AT:'Austria',CZ:'Czechia',IN:'India',
  AE:'UAE',BR:'Brazil',AR:'Argentina',TH:'Thailand',NG:'Nigeria',
  RO:'Romania',ES:'Spain',LV:'Latvia',LT:'Lithuania',GE:'Georgia',
  GB2:'United Kingdom'
};

const SERVICE_LIST = ['chatgpt','claude','gemini','grok','perplexity'];
const SVC_SHORT = {chatgpt:'GPT',claude:'CLD',gemini:'GEM',grok:'GRK',perplexity:'PLX'};

const fmtTime = (ts) => ts ? new Date(ts).toLocaleString('ru-RU', {timeZone:'Europe/Moscow', hour:'2-digit', minute:'2-digit', day:'2-digit', month:'2-digit'}) : '—';
const fmtAgo = (ts) => {
  if (!ts) return '—';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'сейчас';
  if (m < 60) return m + ' мин назад';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' ч назад';
  return Math.round(h / 24) + ' дн назад';
};

try {
  const stateRaw = $persistentStore.read(KEY_STATE);
  if (!stateRaw) {
    console.log('Пусто. Запустите ai-region-switch.js хотя бы раз.');
    $notification.post('🤖 Viewer', 'Состояние пустое', '');
    $done({});
  } else {
    renderReport(JSON.parse(stateRaw));
    $done({});
  }
} catch(e) {
  console.log('VIEWER ERROR: ' + e.message);
  console.log(e.stack || '');
  $notification.post('🤖 Viewer', 'Ошибка', String(e.message));
  $done({});
}

function renderReport(state) {
  const mode = state.mode || 'normal';
  const poolKey = (mode === 'normal') ? 'normal' : 'bypass';
  const ratings = (state.ratings && state.ratings[poolKey]) || {};
  const assigns = (state.assignments && state.assignments[poolKey]) || {};

  const allNodes = Object.entries(ratings);
  const okNodes = allNodes.filter(([_, r]) => r.ok);
  const failed = allNodes.filter(([_, r]) => !r.ok);

  const pickedNodes = new Set();
  for (const a of Object.values(assigns)) {
    if (a && a.node) pickedNodes.add(a.node);
  }

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║          🤖  AI REGION SWITCH — STATE REPORT  v' + (state.version || '?').padEnd(15) + '║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  Режим:            ' + (mode === 'normal' ? '✅ нормальный' : '⚠️ whitelist РКН'));
  console.log('  Прогон:           ' + fmtTime(state.lastRun) + ' (' + fmtAgo(state.lastRun) + ')');
  console.log('  Длительность:     ' + (state.lastRunDuration ? Math.round(state.lastRunDuration/1000) + 'с' : '—'));
  console.log('  Узлов рабочих:    ' + okNodes.length + ' / ' + allNodes.length);
  console.log('');

  // === ASSIGNMENTS ===
  console.log('━━━ 📌 ТЕКУЩИЕ НАЗНАЧЕНИЯ ━━━');
  console.log('');
  for (const svc of SERVICE_LIST) {
    const a = assigns[svc];
    const label = SVC_SHORT[svc].padEnd(4);
    if (!a || !a.node) {
      console.log('  ' + label + ' → ∅ (не назначен)');
      continue;
    }
    console.log('  ' + label + ' → ' + flag(a.country) + ' ' + a.node);
    console.log('         ' + (a.reason || '?') + ', держится ' + fmtAgo(a.lastSwitched));
  }
  console.log('');

  // === BY COUNTRY ===
  console.log('━━━ 🌍 РАБОЧИЕ УЗЛЫ ПО СТРАНАМ ━━━');
  console.log('');

  const byCountry = {};
  for (const [name, r] of okNodes) {
    const cc = r.country || '??';
    (byCountry[cc] = byCountry[cc] || []).push([name, r]);
  }
  const sortedCC = Object.keys(byCountry).sort((a, b) => {
    const d = byCountry[b].length - byCountry[a].length;
    return d !== 0 ? d : a.localeCompare(b);
  });

  for (const cc of sortedCC) {
    const list = byCountry[cc].sort((a, b) => a[1].latency - b[1].latency);
    console.log(flag(cc) + ' ' + cc + (NAMES[cc] ? ' (' + NAMES[cc] + ')' : '') + ' · ' + list.length + ' узл.');
    for (const [name, r] of list) {
      const picked = pickedNodes.has(name) ? ' ◀── ВЫБРАН' : '';
      const svcs = SERVICE_LIST.map(s => r.services[s] === 'pass' ? '✅' : '🚫').join('');
      const lat = String(r.latency || '?').padStart(4) + 'ms';
      console.log('   ' + svcs + '  ' + lat + '  ' + name + picked);
    }
    console.log('');
  }

  // === STATISTICS ===
  console.log('━━━ 📊 СТАТИСТИКА ━━━');
  console.log('');
  console.log('  Всего стран в строю: ' + sortedCC.length);
  if (okNodes.length > 0) {
    const lats = okNodes.map(([_, r]) => r.latency).sort((a, b) => a - b);
    const avg = Math.round(lats.reduce((a, b) => a + b, 0) / lats.length);
    const med = lats[Math.floor(lats.length / 2)];
    console.log('  Latency средн: ' + avg + 'мс · медиана: ' + med + 'мс · мин: ' + lats[0] + 'мс · макс: ' + lats[lats.length-1] + 'мс');
  }

  // Доступность сервисов
  console.log('');
  console.log('  Узлов где работает сервис:');
  for (const svc of SERVICE_LIST) {
    const okCount = okNodes.filter(([_, r]) => r.services[svc] === 'pass').length;
    const bar = '█'.repeat(Math.round(okCount / okNodes.length * 20)) + '░'.repeat(20 - Math.round(okCount / okNodes.length * 20));
    console.log('    ' + SVC_SHORT[svc].padEnd(4) + ' ' + bar + ' ' + okCount + '/' + okNodes.length);
  }
  console.log('');

  // === FAILURES ===
  if (failed.length > 0) {
    console.log('━━━ ❌ НЕДОСТУПНЫЕ УЗЛЫ (' + failed.length + ') ━━━');
    console.log('');
    for (const [name, r] of failed) {
      const err = (r.error || 'неизвестно').slice(0, 50);
      console.log('  ' + name);
      console.log('     └ ' + err);
    }
    console.log('');
  }

  // === LEGEND ===
  console.log('━━━ ℹ️ ЛЕГЕНДА ━━━');
  console.log('  Сервисы по столбцам: GPT · CLD · GEM · GRK · PLX');
  console.log('  ✅ = AI доступен из этой страны');
  console.log('  🚫 = AI блокирует эту страну');
  console.log('');

  // === NOTIFICATION ===
  const picks = SERVICE_LIST
    .map(s => SVC_SHORT[s] + ':' + (assigns[s] ? flag(assigns[s].country) : '∅'))
    .join(' ');
  $notification.post(
    '🤖 ' + okNodes.length + '/' + allNodes.length + ' узлов · ' + mode,
    picks,
    'Отчёт в Script Output. ' + fmtAgo(state.lastRun)
  );
}
