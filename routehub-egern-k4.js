// routehub-egern-k4.js — диагностика Egern. K4_REV: k4-13 (2026-08-09).
//
// ЗАДАЧА РЕВИЗИИ: подобрать тест-адреса под ВСЕ наши задачи, пока блокировок
//   нет. Проверяется 16 кандидатов через четыре разных выхода, по три повтора,
//   с медианой задержки и долей успехов. Плюс отдельно источники выходного IP
//   и источники данных для спидтеста.
//   ПОЧЕМУ СЕЙЧАС: под whitelist проверить будет уже нечем — нужен эталон,
//   снятый в нормальном режиме, чтобы потом было с чем сравнивать.
//
// СХЕМА: все шаги за один прогон подряд, НО с бюджетом времени.
//   • timeout скрипта в профиле — 120 с; если бюджет (100 с) исчерпан, прогон
//     останавливается и оставшиеся шаги выполнятся при следующем запуске —
//     уже выполненные не повторяются (результат лежит в хранилище).
//   • обычная ошибка шага пишется в отчёт, перебор идёт дальше;
//   • шаг, убивший прогон целиком, при следующем запуске заносится в dead и
//     пропускается навсегда (падение внутри прослойки try/catch не ловит).
//   • внутри шага URL, не ответивший с первого раза, больше не повторяется —
//     иначе мёртвый адрес съедал бы бюджет втрое.
//
// ИТОГИ k4-12 (2026-08-09):
//   • Порты 13991..13994 — один обработчик, только /js; запись 404;
//     заголовков Server и WWW-Authenticate нет. Локальный сервер раздаёт
//     только тела скриптов.
//   • Egern.arguments = копия наших же env из профиля.
//   • ctx.ssh ЖИВ: отказ 'ssh session shut down', ловится try/catch.
//   • Опись ctx по прототипам совпала с документацией дословно.
//   • URL-схема НЕ перезаписывает существующую группу — отказ «имя занято».
//   • ЗАМЕР СКОРОСТИ: первый прогон каждого узла систематически занижен
//     (8,8 против 17,8 Мбит/с) — считать медиану БЕЗ первого замера.
// ИТОГИ k4-11: сплошная опись globalThis (959 имён) — недокументированного
//   нет; policyDescriptor во всех формах 400; Surge и Clash API отсутствуют.
//   ⇒ управление политиками из скрипта невозможно, доказано.
//
// В ТЕКСТЕ СКРИПТА НЕЛЬЗЯ: обратные кавычки, ${...} и ЛЮБЫЕ обратные слэши.
// ФАЙЛ ЗАКАНЧИВАЕТСЯ СТРОЧНЫМ КОММЕНТАРИЕМ БЕЗ ПЕРЕВОДА СТРОКИ.
// ТРАФИК: обходные узлы не задействованы. Обычных — около 1 МБ на шаг Z6.

export const K4_REV = 'k4-13';

export function subNames(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const p = lines[i].indexOf('#');
    if (p < 0) continue;
    let n = lines[i].slice(p + 1).trim();
    try { n = decodeURIComponent(n); } catch (e) { }
    if (n) out.push(n);
  }
  return out;
}
export function normalNodes(text, limit) {
  const out = [];
  const names = subNames(text);
  for (let i = 0; i < names.length && out.length < (limit || 4); i++) {
    if (!/Обход/.test(names[i])) out.push(names[i]);
  }
  return out;
}
export function firstNormalNode(text) {
  const a = normalNodes(text, 1);
  return a.length ? a[0] : '';
}

export const K4_SCRIPT = `export default async function (ctx) {
  const t0 = Date.now();
  const BUDGET = 100000;
  const env = ctx.env || {};
  const STATE = 'rh_scan13';
  const REV = 'k4-13';
  const GRP = env.RH_GROUP || 'RH-Пул-Обычные';

  // Кандидаты в тест-адреса. Назначение: 204 — идеал для latency_test_url
  // (пустое тело, минимальный трафик); ok — годен, но с телом; рф — маяк
  // для детектора whitelist (должен работать БЕЗ прокси).
  const URLS = [
    ['cloudflare', 'http://cp.cloudflare.com/generate_204'],
    ['gstatic', 'http://www.gstatic.com/generate_204'],
    ['gstatic_cc', 'http://connectivitycheck.gstatic.com/generate_204'],
    ['google_c3', 'http://clients3.google.com/generate_204'],
    ['apple', 'http://captive.apple.com/hotspot-detect.html'],
    ['msft', 'http://www.msftconnecttest.com/connecttest.txt'],
    ['msft_edge', 'http://edge-http.microsoft.com/captiveportal/generate_204'],
    ['firefox', 'http://detectportal.firefox.com/success.txt'],
    ['gnome', 'http://nmcheck.gnome.org/check_network_status.txt'],
    ['vivo', 'http://wifi.vivo.com.cn/generate_204'],
    ['qualcomm', 'http://www.qualcomm.cn/generate_204'],
    ['icanhazip', 'http://ipv4.icanhazip.com'],
    ['cf_trace_https', 'https://1.1.1.1/cdn-cgi/trace'],
    ['ya_ru', 'http://ya.ru'],
    ['mailru', 'http://mail.ru'],
    ['gosuslugi', 'https://www.gosuslugi.ru']
  ];

  const notify = (title, text) => {
    try {
      if (typeof ctx.notify === 'function') { ctx.notify({ title: title, body: text }); return 'ok'; }
      if (typeof $notification !== 'undefined' && $notification && $notification.post) {
        $notification.post(title, '', text); return 'surge';
      }
    } catch (e) { }
    return 'нет';
  };

  const median = (arr) => {
    const a = arr.filter(v => v !== null).sort((x, y) => x - y);
    if (!a.length) return null;
    return a[Math.floor(a.length / 2)];
  };

  // Три повтора одного адреса через одну политику. Если первый заход провален,
  // повторы не делаются — мёртвый адрес не должен съедать бюджет времени.
  const measure = async (url, policy) => {
    const times = [];
    let status = null, note = null, bytes = null;
    for (let k = 0; k < 3; k++) {
      const t = Date.now();
      try {
        const o = { timeout: 3000 };
        if (policy) o.policy = policy;
        const r = await ctx.http.get(url, o);
        times.push(Date.now() - t);
        status = r.status;
        if (bytes === null) {
          try { bytes = String(await r.text() || '').length; } catch (e) { bytes = -1; }
        }
      } catch (e) {
        note = String((e && e.message) || e).slice(0, 60);
        times.push(null);
        break;
      }
    }
    const ok = times.filter(v => v !== null).length;
    const res = { ok: ok + '/3', ms: median(times) };
    if (status !== null) res.st = status;
    if (bytes !== null) res.len = bytes;
    if (note) res.err = note;
    return res;
  };

  const sweep = async (policy) => {
    const out = {};
    for (let i = 0; i < URLS.length; i++) {
      out[URLS[i][0]] = await measure(URLS[i][1], policy);
    }
    return out;
  };

  const steps = [
    // Z1: прямой выход. Отсюда берутся кандидаты в internet-test-url и в
    // маяки детектора whitelist — они обязаны работать БЕЗ прокси.
    ['Z1_direct', async () => await sweep('DIRECT')],
    // Z2: российский узел. Главный кандидат в latency_test_url обязан
    // отвечать именно отсюда — РФ-узлов в пуле большинство.
    ['Z2_node_ru', async () => await sweep('RH-Явный-1')],
    // Z3: немецкий узел — контроль, что адрес не привязан к стране выхода.
    ['Z3_node_de', async () => await sweep('RH-Явный-3')],
    // Z4: через группу — так адрес будет использоваться в бою.
    ['Z4_group', async () => await sweep(GRP)],
    // Z5: источники выходного IP. Нужны для диагностики и для детектора
    // подмены; проверяем, какие доступны через узел и напрямую.
    ['Z5_ip_sources', async () => {
      const src = [
        ['ifconfig', 'https://ifconfig.me/ip'],
        ['ipify', 'https://api.ipify.org'],
        ['ipinfo', 'https://ipinfo.io/ip'],
        ['icanhazip', 'https://ipv4.icanhazip.com'],
        ['cf_trace', 'https://www.cloudflare.com/cdn-cgi/trace']
      ];
      const out = {};
      for (let i = 0; i < src.length; i++) {
        const via = async (pol) => {
          try {
            const r = await ctx.http.get(src[i][1], { policy: pol, timeout: 5000 });
            const b = String(await r.text() || '').trim().slice(0, 60);
            return { st: r.status, body: b };
          } catch (e) { return 'err:' + String((e && e.message) || e).slice(0, 50); }
        };
        out[src[i][0]] = { node: await via('RH-Явный-1'), direct: await via('DIRECT') };
      }
      return out;
    }],
    // Z6: источники данных для спидтеста. По 128 КБ, два повтора, первый
    // замер отбрасывается (см. итоги k4-12).
    ['Z6_speed_sources', async () => {
      const src = [
        ['cloudflare', 'https://speed.cloudflare.com/__down?bytes=131072'],
        ['hetzner', 'https://ash-speed.hetzner.com/100MB.bin'],
        ['ovh', 'https://proof.ovh.net/files/1Mb.dat']
      ];
      const out = {};
      for (let i = 0; i < src.length; i++) {
        const runs = [];
        for (let k = 0; k < 3; k++) {
          const t = Date.now();
          try {
            const r = await ctx.http.get(src[i][1], { policy: 'RH-Явный-1', timeout: 20000 });
            const b = await r.arrayBuffer();
            const ms = Math.max(1, Date.now() - t);
            runs.push({ bytes: b.byteLength, ms: ms, mbps: Math.round(b.byteLength * 8 / ms / 100) / 10 });
          } catch (e) { runs.push('err:' + String((e && e.message) || e).slice(0, 50)); break; }
        }
        const good = runs.filter(v => v && v.mbps).map(v => v.mbps);
        // Первый замер отбрасываем: в него входит установление соединения.
        const tail = good.slice(1);
        out[src[i][0]] = { runs: runs, median_no_first: median(tail) };
      }
      return out;
    }]
  ];

  let st = null;
  try { st = ctx.storage.getJSON(STATE); } catch (e) { }
  if (!st || st.rev !== REV || (env.RH_RESET && st.reset !== env.RH_RESET)) {
    st = { rev: REV, reset: env.RH_RESET || '', dead: {}, results: {}, runs: 0 };
  }
  if (!st.dead) st.dead = {};
  if (!st.results) st.results = {};

  if (st.inflight) {
    st.dead[st.inflight] = true;
    st.results[st.inflight] = 'РОНЯЕТ ПРОГОН — падение внутри прослойки Egern, try/catch не ловит; шаг исключён';
    st.inflight = null;
    try { ctx.storage.setJSON(STATE, st); } catch (e) { }
  }

  st.runs = (st.runs || 0) + 1;
  let did = 0, errCount = 0, left = 0;

  for (let i = 0; i < steps.length; i++) {
    const nm = steps[i][0];
    if (st.dead[nm]) continue;
    if (st.results[nm] !== undefined) continue;      // уже сделан в прошлый раз
    if (Date.now() - t0 > BUDGET) { left++; continue; }
    st.inflight = nm;
    try { ctx.storage.setJSON(STATE, st); } catch (e) { }
    try { st.results[nm] = await steps[i][1](); did++; }
    catch (e) { st.results[nm] = 'ошибка: ' + String((e && e.message) || e); errCount++; }
    st.inflight = null;
    try { ctx.storage.setJSON(STATE, st); } catch (e) { }
  }

  const done = Object.keys(st.results).length;
  const R = { rev: REV, run: st.runs, total: steps.length, done: done,
              did_now: did, errors: errCount, left: left,
              dead: Object.keys(st.dead), results: st.results,
              total_ms: Date.now() - t0, ts: new Date().toISOString() };

  notify(REV + ': прогон ' + st.runs,
         'Готово шагов ' + done + ' из ' + steps.length +
         (left ? '. Не хватило времени на ' + left + ' — запусти ещё раз' : '. ПЕРЕБОР ЗАВЕРШЁН'));

  try {
    if (env.RH_POST_URL) {
      await ctx.http.post(env.RH_POST_URL, {
        body: R, headers: { 'Content-Type': 'application/json' }, timeout: 15000
      });
    }
  } catch (e) { }
  return { rh: REV, run: st.runs, done: done, left: left };
}
`;

// ХВОСТОВОЙ СТРАЖ — строка без перевода в конце файла; мусор после неё —