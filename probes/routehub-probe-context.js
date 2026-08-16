/*
 * routehub-probe-context.js — проба L10 «контекст проверки»
 * ------------------------------------------------------------------
 * ЗАЧЕМ. Когда Диана говорит «проверила — сидит на обходе», сам по себе
 * этот факт ничего не значит: причина может быть в узлах, а может — в
 * активном whitelist РКН или в том, что телефон на сотовой сети.
 * L10 снимает ВЕСЬ контекст одним запуском, чтобы вывод был однозначным.
 *
 * ЧТО ДЕЛАЕТ (только чтение, боевую маршрутизацию НЕ трогает):
 *   1. Локальный контекст: ssid, режим Loon, FINAL, выбор всех групп.
 *   2. Детект whitelist: 5 иностранных маяков напрямую (node:'DIRECT')
 *      + 2 российских контрольных адреса. Вердикт по обеим сторонам.
 *   3. Живость КАЖДОГО выбранного узла: generate_204 через node:<имя>.
 *      Обходные узлы ПРОПУСКАЮТСЯ — платный трафик (правило проекта).
 *   4. Сводка в тексте уведомления + полный отчёт в буфер обмена.
 *
 * НЕ вызывает setSelectPolicy / setPluginEnable / setScriptEnable /
 * setRunningModel. Ничего не пишет в $persistentStore.
 *
 * ПОДКЛЮЧЕНИЕ (раздел [Script] локального конфига):
 * generic script-path=routehub-probe-context.js, tag=RH-L10, timeout=120, enable=true
 *
 * ВАЖНО (вывод 55): $httpClient БЕЗ параметра node идёт по правилам —
 * поэтому маяки и контрольные адреса бьются явным node:'DIRECT'.
 * ВАЖНО (вывод T6): node понимает имена УЗЛОВ, имена ГРУПП игнорирует
 * молча. Поэтому проверяются только значения policy_select, которые
 * являются узлами, а не ссылками на другие группы.
 */

const REV = 'L10';
const T_BEACON = 3000;   // мс на маяк
const T_NODE = 5000;     // мс на узел
const T_RU = 4000;       // мс на российский контроль

// Иностранные маяки. Набор из СРАВНЕНИЕ_КЛИЕНТОВ_И_WHITELIST.md:
// под whitelist все дают таймаут, ложных срабатываний не зафиксировано.
const BEACONS = [
  ['gstatic', 'http://connectivitycheck.gstatic.com/generate_204'],
  ['clients3', 'http://clients3.google.com/generate_204'],
  ['cloudflare', 'http://cp.cloudflare.com/generate_204'],
  ['apple', 'http://captive.apple.com/hotspot-detect.html'],
  ['msft', 'http://www.msftconnecttest.com/connecttest.txt'],
];

// Российские контрольные адреса. Выжили только эти два (замер 2026-08-11):
// остальные госсайты дают таймаут даже в обычном режиме.
const RU_CTRL = [
  ['ya.ru', 'https://ya.ru/'],
  ['gosuslugi', 'https://www.gosuslugi.ru/'],
];

const rep = {
  rev: REV,
  ts: new Date().toISOString(),
  errors: [],
};

function req(url, node, timeout) {
  return new Promise(function (resolve) {
    const t0 = Date.now();
    const p = { url: url, timeout: timeout };
    if (node) p.node = node;
    $httpClient.get(p, function (err, resp) {
      const ms = Date.now() - t0;
      if (err) resolve({ ok: false, ms: ms, err: String(err).slice(0, 60) });
      else resolve({ ok: true, ms: ms, status: resp ? resp.status : null });
    });
  });
}

function short(name, max) {
  const s = String(name).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

(async function main() {
  // ---------- 1. Локальный контекст ----------
  try {
    const raw = $config.getConfig();
    const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    rep.ssid = cfg.ssid || null;
    rep.net = cfg.ssid ? 'wifi' : 'cell';   // ssid пуст на сотовой
    rep.running_model = cfg.running_model;
    rep.final = cfg.final;
    rep.global_proxy = cfg.global_proxy;
    rep.policy_select = cfg.policy_select || {};
  } catch (e) {
    rep.errors.push('getConfig: ' + e);
    rep.policy_select = {};
  }

  // ---------- 2. Детект whitelist ----------
  rep.beacons = {};
  let beaconOk = 0;
  for (const b of BEACONS) {
    const r = await req(b[1], 'DIRECT', T_BEACON);
    rep.beacons[b[0]] = r.ok ? r.ms : 'таймаут';
    if (r.ok) beaconOk++;
  }

  rep.ru_ctrl = {};
  let ruOk = 0;
  for (const c of RU_CTRL) {
    const r = await req(c[1], 'DIRECT', T_RU);
    rep.ru_ctrl[c[0]] = r.ok ? r.ms : 'таймаут';
    if (r.ok) ruOk++;
  }

  // Вердикт. Whitelist = иностранное напрямую мертво, российское живо.
  if (beaconOk === 0 && ruOk === 0) rep.mode = 'НЕТ ИНТЕРНЕТА';
  else if (beaconOk === 0 && ruOk > 0) rep.mode = 'WHITELIST АКТИВЕН';
  else if (beaconOk <= 1 && ruOk > 0) rep.mode = 'ПОХОЖЕ НА WHITELIST';
  else rep.mode = 'ОБЫЧНЫЙ РЕЖИМ';

  // ---------- 3. Живость выбранных узлов ----------
  // Значения policy_select бывают трёх видов: встроенная политика
  // (DIRECT/REJECT), ссылка на другую группу (начинается с RH-) и узел.
  // Проверяем только узлы: node понимает имена узлов, не групп.
  const nodes = {};   // имя узла -> список групп, которые его выбрали
  for (const g in rep.policy_select) {
    const v = String(rep.policy_select[g] || '');
    if (!v) continue;
    if (v === 'DIRECT' || v === 'REJECT') continue;
    if (v.indexOf('RH-') === 0) continue;
    if (!nodes[v]) nodes[v] = [];
    nodes[v].push(g);
  }

  rep.nodes = [];
  for (const name in nodes) {
    // Обходные узлы не трогаем — платный трафик (правило проекта).
    if (name.indexOf('Обход') >= 0) {
      rep.nodes.push({ name: name, groups: nodes[name], skip: 'обходной, не проверяем' });
      continue;
    }
    const r = await req('http://connectivitycheck.gstatic.com/generate_204', name, T_NODE);
    rep.nodes.push({
      name: name,
      groups: nodes[name],
      ok: r.ok,
      ms: r.ms,
      status: r.ok ? r.status : null,
      err: r.ok ? null : r.err,
    });
  }

  const live = rep.nodes.filter(function (n) { return n.ok; }).length;
  const dead = rep.nodes.filter(function (n) { return n.ok === false; }).length;
  const skipped = rep.nodes.filter(function (n) { return n.skip; }).length;
  rep.summary = { живых: live, мёртвых: dead, пропущено: skipped };

  // ---------- 4. Вывод ----------
  const lines = [];
  lines.push(rep.mode);
  lines.push('сеть: ' + (rep.net === 'wifi' ? ('Wi-Fi ' + rep.ssid) : 'сотовая'));
  lines.push('маяки: ' + beaconOk + '/' + BEACONS.length + '  РФ: ' + ruOk + '/' + RU_CTRL.length);
  lines.push('узлы: ' + live + ' живых, ' + dead + ' мёртвых, ' + skipped + ' пропущено');
  for (const n of rep.nodes) {
    if (n.skip) lines.push('· ' + short(n.name, 34) + ' — обход, пропуск');
    else lines.push((n.ok ? '✓ ' : '✗ ') + short(n.name, 34) + (n.ok ? ' ' + n.ms + 'мс' : ' ' + n.err));
  }

  $notification.post(
    'RouteHub ' + REV + ' — ' + rep.mode,
    lines[1] + ' · ' + lines[2],
    lines.slice(3).join('\n'),
    { clipboard: JSON.stringify(rep) }
  );
  console.log('[' + REV + '] ' + JSON.stringify(rep));
  $done();
})();
