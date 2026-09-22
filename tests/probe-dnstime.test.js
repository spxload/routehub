// Поведение пробы L12 «время резолва DNS» в песочнице (пункт 44).
//
// ЗАЧЕМ СВЕРХ probes-smoke. L12 — прибор: её цифры пойдут в решение по
// `[General]` (вывод 33). Поэтому проверяется не только «дожила до $done»,
// но и сама арифметика («имя − IP», первый отдельно, база без первого),
// вердикт whitelist по обеим сторонам, потолок таймаута и сторож.
//
// ВИРТУАЛЬНЫЕ ЧАСЫ. Проба меряет время через Date.now(). В песочнице Date
// подменён: часы двигает подставной $httpClient — каждый ответ приходит в
// момент «старт + заданная длительность». Реальные таймеры ужаты в 100 раз,
// порядок событий сохраняется, поэтому и сторож, и параллельная фаза
// контекста ведут себя как на устройстве.
//
// ГРАНИЦЫ ПРОЕКТА, которые тест держит: каждый запрос — node:'DIRECT';
// ни одного узла, ни одного «Обход»; ни PUT/POST; ни одного пишущего вызова
// $config; ровно один $done на любой ветви.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = 'probes/routehub-probe-dnstime.js';
const CODE = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
const PLUGIN = fs.readFileSync(path.join(ROOT, 'plugins/RouteHub-DNS-L12.plugin'), 'utf8');
const SCALE = 100;

const isBeaconName = (u) => /gstatic|clients3|cp\.cloudflare|captive\.apple|msftconnect/.test(u);
const isIpBeacon = (u) => u.indexOf('http://1.1.1.1/') === 0;
const isTarget = (u) => /^http:\/\/\d+\.\d+\.\d+\.\d+\/$/.test(u) && !isIpBeacon(u);
const isName = (u) => /\.(nip|sslip)\.io\//.test(u);
const isDoh = (u) => /cloudflare-dns\.com|dns\.google/.test(u);

// plan(url, n) -> { ms, ok, err } | null (null = никогда не ответить).
function run(plan) {
  let clock = 1_000_000;
  const RealDate = Date;
  function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(clock); }
  FakeDate.now = () => clock;

  const st = { done: 0, note: null, reqs: [], counts: {}, logs: [] };
  const bang = (what) => () => { throw new Error('проба не должна звать ' + what); };

  function get(opts, cb) {
    const url = String(opts.url);
    st.reqs.push(opts);
    st.counts[url] = (st.counts[url] || 0) + 1;
    const r = plan(url, st.counts[url], opts);
    if (!r) return;
    const start = clock;
    // Таймаут клиента: ответ длиннее opts.timeout превращается в ошибку.
    const dur = Math.min(r.ms, opts.timeout);
    const failed = r.ok === false || r.ms > opts.timeout;
    setTimeout(() => {
      clock = Math.max(clock, start + dur);
      if (failed) cb(r.err || 'timed out', null, null);
      else cb(null, { status: r.status || 200, headers: {} }, '');
    }, Math.max(1, Math.round(dur / SCALE)));
  }

  const sandbox = {
    console: { log: (s) => st.logs.push(String(s)) },
    JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, isFinite, encodeURIComponent, decodeURIComponent,
    Date: FakeDate,
    setTimeout: (fn, ms) => setTimeout(fn, Math.max(1, Math.round((ms || 0) / SCALE))),
    clearTimeout,
    $config: {
      getConfig: () => JSON.stringify({ ssid: 'home', running_model: 1, policy_select: {} }),
      setSelectPolicy: bang('setSelectPolicy'),
      setRunningModel: bang('setRunningModel'),
    },
    $persistentStore: { read: bang('$persistentStore.read'), write: bang('$persistentStore.write') },
    $notification: { post: (t, s, b, o) => { st.note = { t, s, b, clip: o && o.clipboard }; } },
    $httpClient: {
      get,
      post: bang('POST'), put: bang('PUT'), patch: bang('PATCH'), delete: bang('DELETE'), head: bang('HEAD'),
    },
    $done: () => { st.done++; },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(CODE, ctx, { filename: FILE });
  st.ctx = ctx;
  st.clock = () => clock;
  return st;
}

async function settle(st, extraMs = 150) {
  const until = Date.now() + 3000;
  while (!st.done && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  // Даём опоздавшим ответам шанс вызвать второй $done, если защита сломана.
  await new Promise((r) => setTimeout(r, extraMs));
  return st;
}

const rep = (st) => JSON.parse(st.note.clip);

// Под whitelist: иностранное мертво (таймаут), цели по IP живы, имена
// разрешаются долго, DoH мёртв.
function whitelistPlan(nameMs = 5000, ipMs = 50) {
  return (u, n) => {
    if (isBeaconName(u) || isIpBeacon(u) || isDoh(u)) return { ms: 99999 };
    if (isTarget(u)) return { ms: ipMs };
    if (isName(u)) return { ms: n === 1 ? nameMs : ipMs };  // повтор имени — из кэша
    return { ms: 10 };
  };
}

test('под whitelist: вердикт первой строкой, DoH мёртв, резолв = имя − IP', async () => {
  const st = await settle(run(whitelistPlan(5000, 50)));
  assert.equal(st.done, 1);
  assert.match(st.note.t, /whitelist ВКЛ/);
  assert.match(st.note.t, /DoH не отвечает \(0\/2\)/);
  assert.match(st.note.t, /резолв: 1-й 4950 мс, медиана 4950 мс/);
  assert.match(st.note.b, /похоже на ожидание мёртвого DoH/);
  const r = rep(st);
  assert.equal(r.target, '77.88.8.8');
  assert.equal(r.dns_est.length, 6);
  assert.equal(r.control_delta, 0);
});

test('без whitelist: DoH отвечает, прогон помечен как база', async () => {
  const st = await settle(run((u, n) => {
    if (isName(u)) return { ms: n === 1 ? 170 : 50 };
    if (isDoh(u)) return { ms: 80 };
    return { ms: 50 };
  }));
  assert.equal(st.done, 1);
  assert.match(st.note.t, /whitelist ВЫКЛ/);
  assert.match(st.note.t, /DoH отвечает за 80 мс \(2\/2\)/);
  assert.match(st.note.t, /резолв: 1-й 120 мс, медиана 120 мс/);
  assert.match(st.note.b, /этот прогон — база/);
});

test('нет интернета: замер не делается, ни одного запроса по имени', async () => {
  const st = await settle(run(() => ({ ms: 99999 })));
  assert.equal(st.done, 1);
  assert.match(st.note.t, /НЕТ ИНТЕРНЕТА/);
  assert.match(st.note.t, /замер невозможен/);
  assert.equal(st.reqs.filter((o) => isName(String(o.url))).length, 0);
  assert.equal(st.reqs.filter((o) => isDoh(String(o.url))).length, 0);
});

test('цели из whitelist молчат, иностранное живо: замера нет, DoH всё равно проверен', async () => {
  const st = await settle(run((u) => {
    if (isTarget(u)) return { ms: 99999 };
    return { ms: 45 };
  }));
  assert.equal(st.done, 1);
  assert.match(st.note.t, /whitelist ВЫКЛ · DoH отвечает за 45 мс/);
  assert.match(st.note.t, /нет цели из whitelist — замер невозможен/);
  assert.equal(st.reqs.filter((o) => isName(String(o.url))).length, 0);
});

test('быстрая ошибка имени видна с её временем', async () => {
  const st = await settle(run((u) => {
    if (isBeaconName(u) || isIpBeacon(u) || isDoh(u)) return { ms: 99999 };
    if (isName(u)) return { ms: 4200, ok: false, err: 'dns failed' };
    return { ms: 50 };
  }));
  assert.match(st.note.b, /имя − IP, мс: ош4200, ош4200/);
});

test('иностранный IP-маяк жив при мёртвых именах — это сбой DNS, не whitelist', async () => {
  const st = await settle(run((u) => {
    if (isBeaconName(u)) return { ms: 99999 };
    return { ms: 40 };
  }));
  assert.match(st.note.t, /whitelist ВЫКЛ/);
  assert.match(st.note.b, /сбой DNS, а не whitelist/);
});

test('один живой маяк по имени без IP-маяка — «похоже на whitelist», как в L10', async () => {
  const st = await settle(run((u) => {
    if (u.indexOf('gstatic') >= 0) return { ms: 60 };
    if (isBeaconName(u) || isIpBeacon(u)) return { ms: 99999 };
    return { ms: 40 };
  }));
  assert.match(st.note.t, /похоже на whitelist/);
});

test('первый замер отдельно: холодный первый не портит медиану', async () => {
  let nameIdx = 0;
  const st = await settle(run((u, n) => {
    if (isBeaconName(u) || isIpBeacon(u) || isDoh(u)) return { ms: 99999 };
    // n=1 — фаза контекста, n=2 — первый (холодный) замер, дальше 50/60/70.
    if (isTarget(u)) return { ms: [0, 50, 900, 50, 60, 70][n] || 50 };
    if (isName(u)) {
      if (n > 1) return { ms: 60 };
      nameIdx++;
      // Холодный первый + разброс остальных: медиана с первым дала бы 350.
      return { ms: [0, 3060, 160, 260, 360, 460, 560][nameIdx] };
    }
    return { ms: 10 };
  }));
  const r = rep(st);
  assert.equal(r.ip_first, 900);
  assert.equal(r.ip_median, 60, 'база по IP считается без первого замера (с ним было бы 65)');
  assert.equal(r.dns_first, 3000);
  assert.deepEqual(r.dns_est, [3000, 100, 200, 300, 400, 500]);
  assert.equal(r.dns_median_rest, 300, 'медиана без первого (с ним было бы 350)');
});

test('таймаут имени — цензура: значение с «≥» и пометка потолка', async () => {
  const st = await settle(run((u) => {
    if (isBeaconName(u) || isIpBeacon(u) || isDoh(u)) return { ms: 99999 };
    if (isTarget(u)) return { ms: 50 };
    if (isName(u)) return { ms: 99999 };
    return { ms: 10 };
  }), 300);
  assert.equal(st.done, 1);
  assert.match(st.note.t, /1-й ≥5950 мс, медиана ≥5950 мс/);
  assert.match(st.note.b, /таймаутов 6/);
  // Повтор первого имени не делается: оно не разрешилось.
  const names = st.reqs.filter((o) => isName(String(o.url)));
  assert.equal(names.length, 6);
  // Худший честный путь уложился до сторожа — сторож не сработал.
  assert.ok(!rep(st).errors.some((e) => /сторож/.test(e)));
  assert.ok(st.clock() - 1_000_000 <= st.ctx.WORST_MS);
});

test('быстрая ошибка имени (зеркало не разрешилось) — отдельная пометка', async () => {
  const st = await settle(run((u) => {
    if (isBeaconName(u) || isIpBeacon(u) || isDoh(u)) return { ms: 99999 };
    if (isName(u)) return { ms: 30, ok: false, err: 'dns failed' };
    return { ms: 50 };
  }));
  assert.match(st.note.b, /ошибок имени 6/);
});

test('контроль: повтор имени сильно дольше IP — «ШУМНО»', async () => {
  const st = await settle(run((u, n) => {
    if (isBeaconName(u) || isIpBeacon(u) || isDoh(u)) return { ms: 99999 };
    if (isTarget(u)) return { ms: 50 };
    if (isName(u)) return { ms: n === 1 ? 800 : 400 };
    return { ms: 10 };
  }));
  assert.equal(rep(st).control_delta, 350);
  assert.match(st.note.b, /ШУМНО/);
});

test('имена свежие: все разные, указывают на цель, оба зеркала', async () => {
  const st = await settle(run(whitelistPlan()));
  const names = [...new Set(st.reqs.map((o) => String(o.url)).filter(isName))];
  assert.equal(names.length, 6);
  for (const u of names) assert.match(u, /^http:\/\/rh[a-z0-9]+-77-88-8-8\.(nip|sslip)\.io\/$/);
  assert.ok(names.some((u) => u.includes('nip.io')) && names.some((u) => u.includes('sslip.io')));
});

test('каждый запрос — DIRECT, без узлов и обхода, без редиректа, Connection: close', async () => {
  for (const plan of [whitelistPlan(), () => ({ ms: 40 })]) {
    const st = await settle(run(plan));
    assert.ok(st.reqs.length > 10);
    for (const o of st.reqs) {
      assert.equal(o.node, 'DIRECT', 'запрос не через DIRECT: ' + o.url);
      assert.equal(o['auto-redirect'], false);
      assert.equal(o.headers.Connection, 'close');
      assert.ok(!/Обход/.test(JSON.stringify(o)));
    }
  }
});

test('зависший клиент: сторож гасит пробу ровно одним $done', async () => {
  const st = run(() => null);
  const until = Date.now() + 3000;
  while (!st.done && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(st.done, 1);
  assert.match(st.note.b, /сторож 80000 мс/);
});

test('ответы после сторожа не дают второго $done', async () => {
  // Эмуляция растянутых таймеров: сторож срабатывает, пока проба ещё идёт.
  // Цели отвечают 2900 мс, имена 5900 мс — путь почти худший; сторож зовём
  // вручную в начале пути, а оставшиеся ответы приходят уже после него.
  const st = run((u, n) => {
    if (isBeaconName(u) || isIpBeacon(u) || isDoh(u)) return { ms: 99999 };
    if (isTarget(u)) return { ms: 2900 };
    if (isName(u)) return { ms: 5900 };
    return { ms: 10 };
  });
  await new Promise((r) => setTimeout(r, 80));
  st.ctx.finish('ручной сторож');
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(st.done, 1);
});

test('сторож позже худшего честного пути, манифест позже сторожа (ST14)', () => {
  const st = run(() => null);
  const c = st.ctx;
  assert.equal(c.WORST_MS, c.T_CTX + c.N_IP * c.T_IP + (c.N_NAMES + 1) * c.T_NAME + c.T_DOH);
  assert.ok(c.WATCHDOG_MS >= c.WORST_MS * 1.25, 'запас сторожа над худшим путём < 25%');
  const m = PLUGIN.match(/timeout=(\d+)/);
  assert.ok(m, 'в плагине нет timeout');
  assert.ok(Number(m[1]) * 1000 >= c.WATCHDOG_MS + 20000, 'тайм-аут манифеста впритык к сторожу');
});

test('плагин: generic RH-L12 на этот файл в main; боевой конфиг L12 не содержит', () => {
  assert.match(PLUGIN, /^generic script-path=https:\/\/raw\.githubusercontent\.com\/spxload\/routehub\/main\/probes\/routehub-probe-dnstime\.js,/m);
  assert.match(PLUGIN, /tag=RH-L12/);
  assert.doesNotMatch(PLUGIN, /^(cron|network-changed|http-request)/m, 'проба только ручная');
  const conf = fs.readFileSync(path.join(ROOT, 'routehub.conf'), 'utf8');
  assert.doesNotMatch(conf, /dnstime|RH-L12/);
});

test('исходник не содержит пишущих вызовов и узлов подписки', () => {
  assert.doesNotMatch(CODE, /setSelectPolicy\s*\(|setRunningModel\s*\(|\$persistentStore\.write|\$httpClient\.(put|post|patch|delete)/);
  const nodes = CODE.match(/node:\s*'[^']*'/g) || [];
  assert.deepEqual([...new Set(nodes.map((x) => x.replace(/\s+/g, '')))], ["node:'DIRECT'"]);
});
