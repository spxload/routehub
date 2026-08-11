// =============================================================
// routehub-probe-loon.js — диагностика Loon ПОД WHITELIST. REV: L6 (2026-08-11).
//
// ГЛАВНЫЙ РЕЗУЛЬТАТ L5 — БАЗОВОЕ ДОПУЩЕНИЕ ПРОЕКТА ОПРОВЕРГНУТО:
//   под активным whitelist ОБЫЧНЫЙ узел (🇳🇱 Нидерланды [VPN]) ответил по
//   ВСЕМ шести маякам за 96-121 мс, а обходной (🇩🇪 [Обход - МТС]) — за
//   383-452 мс. То есть обычные узлы работают, и ВЧЕТВЕРО быстрее платных.
//   При этом RH-АВТО-W, RH-АВТО-C, RH-AI-C и RH-RU сидели на обходном узле —
//   платный трафик тратился там, где бесплатный лучше.
//   Вероятная причина: в fallback первыми стоят РОССИЙСКИЕ узлы (RH-Все
//   выбрал 🇷🇺 Россия [VPN] #1); под whitelist они недостижимы, перебор
//   проваливается до обхода, не дойдя до живых европейских. Проверяется W2.
//
//   ДЕТЕКТОР ПОДТВЕРЖДЁН: все шесть иностранных маяков напрямую — таймаут
//   0/2, в норме отвечали за 54-74 мс. Ложных срабатываний нет. K1 и K3 закрыты.
//
//   КОНТРОЛЬНЫЕ РОССИЙСКИЕ ПОДОБРАНЫ НЕВЕРНО: напрямую работают только
//   ya.ru (801 мс) и gosuslugi.ru (233 мс). cbr.ru, nalog.gov.ru,
//   sberbank.ru, mos.ru — ТАЙМАУТ. Whitelist это конкретный список, а не
//   «всё российское»; в контроль годятся только ya.ru и gosuslugi.ru.
//
//   W7: node и policy с ИМЕНЕМ УЗЛА дали ошибку, а с ИМЕНЕМ ГРУППЫ —
//   204 за 3492 мс. Имена узлов содержат эмодзи и пробелы; вероятно, дело
//   в них. Проверяется W4.
//   W6 (обращение к нашим службам) УРОНИЛ ПРОГОН — здесь разнесён на
//   отдельные шаги с коротким таймаутом, чтобы падение стоило одного шага.
//
// БЕЗОПАСНОСТЬ: ТОЛЬКО ЧТЕНИЕ. setSelectPolicy, setPluginEnable,
//   setScriptEnable, setRunningModel НЕ вызываются.
// ТРАФИК: через обходной узел — только ответы generate_204, тяжёлого нет.
// ДОСТАВКА: отчёт в буфер обмена через уведомление.
// =============================================================

const REV = 'L6';
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
        if (err) { resolve('err:' + String(err).slice(0, 50)); return; }
        const r = { st: resp ? resp.status : null, ms: Date.now() - started };
        if (body) r.len = String(body).length;
        resolve(r);
      });
    } catch (e) {
      if (!done.fired) { done.fired = true; clearTimeout(timer); resolve('исключение'); }
    }
  });
}
function snapshot() {
  try {
    const raw = $config.getConfig();
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) || {};
  } catch (e) { return {}; }
}
function seenNodes(snap) {
  const out = [];
  const sel = (snap && snap.policy_select) || {};
  for (const g in sel) {
    const v = sel[g];
    if (typeof v !== 'string') continue;
    if (v.indexOf('RH-') === 0 || v === 'DIRECT' || v === 'REJECT') continue;
    if (out.indexOf(v) < 0) out.push(v);
  }
  return out;
}

const M = 'http://connectivitycheck.gstatic.com/generate_204';
const M2 = 'http://cp.cloudflare.com/generate_204';

const steps = [
  ['W1_state', async function () {
    const s = snapshot();
    return { running_model: s.running_model, final: s.final, ssid: s.ssid,
             policy_select: s.policy_select, nodes: seenNodes(s) };
  }],

  // W2: ГЛАВНОЕ. Каждый известный узел под whitelist — по два маяка и замер.
  // Показывает, какие ТИПЫ узлов переживают блокировку: российские,
  // европейские, игровые, обходные.
  ['W2_nodes_matrix', async function () {
    const nodes = seenNodes(snapshot());
    const out = {};
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const a = await get(M, { node: n }, 5000);
      const b = (a && a.st) ? await get(M2, { node: n }, 5000) : 'пропущен';
      const short = n.slice(0, 24);
      out[short] = { gstatic: a, cloudflare: b };
    }
    return out;
  }],

  // W3: скорость через живые узлы — 128 КБ, чтобы понять, годятся ли
  // обычные узлы под whitelist не только для проб, но и для работы.
  ['W3_speed_live', async function () {
    const nodes = seenNodes(snapshot());
    const out = {};
    const U = 'https://speed.cloudflare.com/__down?bytes=131072';
    for (let i = 0; i < nodes.length && i < 4; i++) {
      const n = nodes[i];
      const r = await get(U, { node: n }, 15000);
      out[n.slice(0, 24)] = (r && r.len)
        ? { mbps: Math.round(r.len * 8 / Math.max(1, r.ms) / 100) / 10, ms: r.ms, len: r.len }
        : r;
    }
    return out;
  }],

  // W4: почему node с именем узла дал ошибку на L5. Пробуем узел без эмодзи
  // в начале строки и сравниваем с обращением по имени группы.
  ['W4_node_naming', async function () {
    const nodes = seenNodes(snapshot());
    const out = { tried: [] };
    for (let i = 0; i < nodes.length && i < 3; i++) {
      const n = nodes[i];
      out.tried.push(n.slice(0, 24));
      out['node_' + i] = await get(M, { node: n }, 5000);
      out['policy_' + i] = await get(M, { policy: n }, 5000);
    }
    out.by_group_avto = await get(M, { node: 'RH-АВТО' }, 6000);
    out.by_group_oboh = await get(M, { node: 'RH-Обход' }, 6000);
    out.no_param = await get(M, null, 5000);
    return out;
  }],

  // W5-W7: наши службы по одной. На L5 общий шаг уронил прогон, поэтому
  // каждый адрес отдельным шагом — падение стоит одного шага, а не всех.
  ['W5_worker_direct', async function () {
    return { direct: await get('https://routehub.proton4iker.workers.dev/status', { node: 'DIRECT' }, 3000) };
  }],
  ['W6_worker_via_bypass', async function () {
    const nodes = seenNodes(snapshot());
    let bypass = null;
    for (let i = 0; i < nodes.length; i++) if (nodes[i].indexOf('Обход') >= 0) { bypass = nodes[i]; break; }
    if (!bypass) return 'обходной узел не найден';
    return { node: bypass.slice(0, 24),
             worker: await get('https://routehub.proton4iker.workers.dev/status', { node: bypass }, 6000) };
  }],
  ['W7_github', async function () {
    const nodes = seenNodes(snapshot());
    let normal = null;
    for (let i = 0; i < nodes.length; i++) if (nodes[i].indexOf('Обход') < 0) { normal = nodes[i]; break; }
    const out = { direct: await get('https://raw.githubusercontent.com/spxload/routehub/main/README.md', { node: 'DIRECT' }, 3000) };
    if (normal) out.via_normal = await get('https://raw.githubusercontent.com/spxload/routehub/main/README.md', { node: normal }, 6000);
    return out;
  }],

  // W8: контрольные российские адреса — сузить набор до реально работающих.
  ['W8_russian_control', async function () {
    const list = [['ya', 'https://ya.ru'], ['gosuslugi', 'https://www.gosuslugi.ru'],
                  ['yandex', 'https://yandex.ru'], ['vk', 'https://vk.com'],
                  ['dzen', 'https://dzen.ru'], ['avito', 'https://www.avito.ru']];
    const out = {};
    for (let i = 0; i < list.length; i++) {
      out[list[i][0]] = await get(list[i][1], { node: 'DIRECT' }, 4000);
    }
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