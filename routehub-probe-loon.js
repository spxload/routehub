// =============================================================
// routehub-probe-loon.js — диагностика Loon ПОД WHITELIST. REV: L5 (2026-08-11).
//
// СРОЧНАЯ РЕВИЗИЯ: whitelist РКН ВКЛЮЧЁН ПРЯМО СЕЙЧАС. Это тот режим, ради
//   которого висели непроверенными K1 и K3, и единственная возможность снять
//   картину «под блокировкой» и сравнить с эталоном, снятым в норме (k4-13/14).
//   Пока окно открыто — меряем.
//
// ЧТО ИЗВЕСТНО ИЗ L4 И ЧТО ЭТО МЕНЯЕТ В МЕТОДИКЕ:
//   • $httpClient БЕЗ параметра node идёт ПО ПРАВИЛАМ КОНФИГА, а не напрямую.
//     Поэтому на L4 gosuslugi и vivo дали таймаут — их запросы ушли через
//     обходной узел. Здесь прямой выход задаётся ЯВНО: node: 'DIRECT'.
//   • Список узлов из скрипта недоступен: getConfig() отдаёт только встроенные
//     политики и имена групп. Имена реальных узлов берутся из policy_select —
//     это карта «группа → выбранный член», доступная одним вызовом.
//   • getSubPolicies не работает ни с какими аргументами (всегда undefined).
//   • Хранилище держит 1 МБ на ключ, remove работает.
//   • Геобазы Loon корректны: 8.8.8.8 → US / 15169 / GOOGLE.
//   • Локальный порт 6152 закрыт: ошибки сокета на все методы и пути.
//   • Loon 3.5.0(975), iOS 26.5.2 — во всех наших документах значится 3.3.9.
//
// БЕЗОПАСНОСТЬ: ТОЛЬКО ЧТЕНИЕ. setSelectPolicy, setPluginEnable,
//   setScriptEnable, setRunningModel НЕ вызываются.
// ТРАФИК: через обходной узел уходит минимум — только маленькие ответы
//   generate_204 и заголовки; тяжёлых загрузок через обход НЕТ.
// ДОСТАВКА: отчёт кладётся в буфер обмена через уведомление.
// =============================================================

const REV = 'L5';
const STATE = 'rh_probe_l1';
const BUDGET = 70000;
const t0 = Date.now();

function readState() {
  try { const raw = $persistentStore.read(STATE); if (raw) return JSON.parse(raw); } catch (e) { }
  return null;
}
function writeState(o) {
  try { $persistentStore.write(JSON.stringify(o), STATE); } catch (e) { }
}

function get(url, opt, ms) {
  return new Promise(function (resolve) {
    const done = { fired: false };
    const started = Date.now();
    const timer = setTimeout(function () {
      if (!done.fired) { done.fired = true; resolve('таймаут'); }
    }, ms || 4000);
    try {
      const req = Object.assign({ url: url }, opt || {});
      $httpClient.get(req, function (err, resp, body) {
        if (done.fired) return;
        done.fired = true;
        clearTimeout(timer);
        if (err) { resolve('err:' + String(err).slice(0, 60)); return; }
        const r = { st: resp ? resp.status : null, ms: Date.now() - started };
        if (body) r.len = String(body).length;
        resolve(r);
      });
    } catch (e) {
      if (!done.fired) { done.fired = true; clearTimeout(timer); resolve('исключение'); }
    }
  });
}

// Снимок состояния: карта «группа → выбранный член» плюс режим и сеть.
function snapshot() {
  try {
    const raw = $config.getConfig();
    const c = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return c || {};
  } catch (e) { return {}; }
}

// Имена узлов берутся из выбора групп — другого источника в Loon нет.
function pickNodes(snap) {
  const out = { bypass: null, normal: null, all: [] };
  const sel = (snap && snap.policy_select) || {};
  for (const g in sel) {
    const v = sel[g];
    if (typeof v !== 'string') continue;
    if (v.indexOf('RH-') === 0 || v === 'DIRECT' || v === 'REJECT') continue;
    if (out.all.indexOf(v) < 0) out.all.push(v);
    if (v.indexOf('Обход') >= 0) { if (!out.bypass) out.bypass = v; }
    else if (!out.normal) out.normal = v;
  }
  return out;
}

// Иностранные маяки: под whitelist должны замолчать НАПРЯМУЮ.
const FOREIGN = [
  ['gstatic_cc', 'http://connectivitycheck.gstatic.com/generate_204'],
  ['google_c3', 'http://clients3.google.com/generate_204'],
  ['cloudflare', 'http://cp.cloudflare.com/generate_204'],
  ['apple', 'http://captive.apple.com/hotspot-detect.html'],
  ['msft', 'http://www.msftconnecttest.com/connecttest.txt'],
  ['vivo', 'http://wifi.vivo.com.cn/generate_204']
];
// Российские: под whitelist обязаны продолжать работать напрямую.
const RUSSIAN = [
  ['ya', 'https://ya.ru'],
  ['gosuslugi', 'https://www.gosuslugi.ru'],
  ['cbr', 'https://www.cbr.ru'],
  ['nalog', 'https://www.nalog.gov.ru'],
  ['sber', 'https://www.sberbank.ru'],
  ['mos', 'https://www.mos.ru']
];

async function sweep(list, opt, tries) {
  const out = {};
  const n = tries || 2;
  for (let i = 0; i < list.length; i++) {
    let ok = 0, st = null, ms = null, note = null;
    for (let k = 0; k < n; k++) {
      const r = await get(list[i][1], opt, 4000);
      if (r && r.st) { ok++; st = r.st; if (ms === null) ms = r.ms; }
      else { note = String(r).slice(0, 30); break; }
    }
    out[list[i][0]] = note ? { ok: ok + '/' + n, err: note } : { ok: ok + '/' + n, st: st, ms: ms };
  }
  return out;
}

const steps = [
  // W1: снимок состояния под whitelist. Что выбрано в каждой группе —
  // видно, какие группы провалились на обход.
  ['W1_state', async function () {
    const s = snapshot();
    const nodes = pickNodes(s);
    return {
      running_model: s.running_model,
      ssid: s.ssid,
      final: s.final,
      global_proxy: s.global_proxy,
      groups: (s.all_policy_groups || []).length,
      policy_select: s.policy_select,
      node_bypass: nodes.bypass,
      node_normal: nodes.normal,
      nodes_seen: nodes.all
    };
  }],

  // W2: ГЛАВНОЕ. Иностранные маяки НАПРЯМУЮ под whitelist.
  // В норме (эталон k4-14) все отвечали 3/3 за 54-74 мс.
  ['W2_foreign_direct', async function () {
    return await sweep(FOREIGN, { node: 'DIRECT' }, 2);
  }],

  // W3: российские напрямую — контроль, что интернет вообще жив.
  ['W3_russian_direct', async function () {
    return await sweep(RUSSIAN, { node: 'DIRECT' }, 2);
  }],

  // W4: те же иностранные маяки ЧЕРЕЗ ОБХОДНОЙ узел. Должны работать —
  // именно на этом держится вся модель обхода.
  ['W4_foreign_via_bypass', async function () {
    const nodes = pickNodes(snapshot());
    if (!nodes.bypass) return 'обходной узел не найден в выборе групп';
    const r = await sweep(FOREIGN, { node: nodes.bypass }, 1);
    r.__node = nodes.bypass;
    return r;
  }],

  // W5: те же маяки через ОБЫЧНЫЙ узел. Под whitelist обычные узлы,
  // по нашей модели, недоступны — здесь это проверяется прямо.
  ['W5_foreign_via_normal', async function () {
    const nodes = pickNodes(snapshot());
    if (!nodes.normal) return 'обычный узел не найден в выборе групп';
    const r = await sweep(FOREIGN, { node: nodes.normal }, 1);
    r.__node = nodes.normal;
    return r;
  }],

  // W6: достижимы ли под whitelist наши собственные службы —
  // Worker, GitHub (подписка и списки правил), стенд.
  ['W6_our_services', async function () {
    const list = [
      ['worker_boevoy', 'https://routehub.proton4iker.workers.dev/status'],
      ['worker_stend', 'https://routehub-egern.proton4iker.workers.dev/health'],
      ['github_raw', 'https://raw.githubusercontent.com/spxload/routehub/main/README.md'],
      ['github', 'https://github.com']
    ];
    const nodes = pickNodes(snapshot());
    const out = { direct: await sweep(list, { node: 'DIRECT' }, 1) };
    if (nodes.bypass) out.via_bypass = await sweep(list, { node: nodes.bypass }, 1);
    return out;
  }],

  // W7: работает ли policy как синоним node — от этого зависит, как писать
  // поузловой спидтест.
  ['W7_node_vs_policy', async function () {
    const nodes = pickNodes(snapshot());
    const U = 'http://connectivitycheck.gstatic.com/generate_204';
    const out = {};
    if (nodes.bypass) {
      out.with_node = await get(U, { node: nodes.bypass }, 6000);
      out.with_policy = await get(U, { policy: nodes.bypass }, 6000);
      out.node_used = nodes.bypass;
    }
    out.with_group = await get(U, { node: 'RH-Обход' }, 6000);
    out.no_param = await get(U, null, 6000);
    return out;
  }]
];

(async function () {
  let st = readState();
  if (!st || st.rev !== REV) st = { rev: REV, dead: {}, results: {}, runs: 0 };
  if (!st.dead) st.dead = {};
  if (!st.results) st.results = {};

  if (st.inflight) {
    st.dead[st.inflight] = true;
    st.results[st.inflight] = 'РОНЯЕТ ПРОГОН — шаг исключён';
    st.inflight = null;
    writeState(st);
  }

  st.runs = (st.runs || 0) + 1;
  let did = 0, errs = 0, left = 0;

  for (let i = 0; i < steps.length; i++) {
    const nm = steps[i][0];
    if (st.dead[nm]) continue;
    if (st.results[nm] !== undefined) continue;
    if (Date.now() - t0 > BUDGET) { left++; continue; }
    st.inflight = nm;
    writeState(st);
    try { st.results[nm] = await steps[i][1](); did++; }
    catch (e) { st.results[nm] = 'ошибка: ' + String((e && e.message) || e); errs++; }
    st.inflight = null;
    writeState(st);
  }

  const done = Object.keys(st.results).length;
  const R = { rev: REV, client: 'loon', mode: 'WHITELIST', run: st.runs,
              total: steps.length, done: done, errors: errs, left: left,
              dead: Object.keys(st.dead), results: st.results,
              total_ms: Date.now() - t0, ts: new Date().toISOString() };
  const body = JSON.stringify(R);

  try {
    $notification.post('Loon ' + REV + ' (whitelist): прогон ' + st.runs,
                       'Отчёт скопирован — вставь в чат',
                       'Готово ' + done + ' из ' + steps.length +
                       (left ? '. Осталось ' + left + ' — запусти ещё раз' : '. ЗАВЕРШЕНО') +
                       '. Байт: ' + body.length,
                       { 'clipboard': body });
  } catch (e) {
    try { $notification.post('Loon ' + REV, '', 'Готово ' + done + ' из ' + steps.length); } catch (e2) { }
  }
  $done({});
})();

// ХВОСТОВОЙ СТРАЖ — строка без перевода в конце файла; мусор после неё —