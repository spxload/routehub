/*
 * RouteHub — СВОДНАЯ ПРОБА EGERN EGS (скрипт профиля plugins/RouteHub-Egern-EGS.yaml).
 * Решения Дианы 27.09 «Оба», 28.09 «Да». История и порядок прогона — CHANGELOG.md, «EGS».
 *
 * ЗАЧЕМ. Одним прогоном ответить, что Egern умеет НАТИВНО из того, что на Stash
 * и Loon делали вспомогательными конструкциями (путь А: подписка в фоне, порядок
 * подписки, fallback = первый живой, смерть узла в фоне). Фоновые вопросы
 * (частота проверок, скачивания профиля и подписок) видны только в журнале
 * Worker'а стенда; скрипт отвечает на то, что видно ИЗНУТРИ: какой член выбран
 * в группе — по исходу запроса к стенду через эту группу (`ctx.http` с policy).
 *
 * ПРАВИЛА. Только чтение: у Egern в `ctx` нет API смены выбора, скрипт его и
 * не ищет (правило 2). Запросы — ТОЛЬКО на стенд Stash (адреса ниже), через
 * DIRECT или тестовые группы EGS-*, члены которых — DIRECT, REJECT и муляжи
 * TEST-NET (правило 1). Группы, через которые ходит скрипт, НЕ совпадают с
 * группами, которые наблюдаются «в фоне» (скриптовый запрос снимает с группы
 * «unreachable»). `ctx.http` timeout — МИЛЛИСЕКУНДЫ
 * (https://egernapp.com/docs/javascript-api/); timeout скрипта в профиле — секунды.
 * В журнал и уведомление — ни SSID, ни BSSID, ни IP, ни оператора: сеть только
 * как wifi / cell / none и тип радио.
 *
 * ВЕРДИКТЫ. Отсутствие данных никогда не «да». Каждое «нет» — только при
 * контроле «да» в том же прогоне: запрос к стенду через DIRECT прошёл. Без
 * контроля прогон в итоги не идёт вовсе (счёт «без контроля»); прогон на
 * границе окна стенда (минута окна < 4) — тоже (счёт «на границе»). Выводы о
 * группах — только если в том же прогоне `ctx.http` соблюдает policy: запрос
 * через мёртвый муляж EGS-DEAD-3 и через несуществующее имя EGS-NOPE НЕ прошёл
 * (иначе 2xx группы — не выбор её члена; счёт «policy не соблюдён»), и группы
 * находятся по имени: запрос через EGS-GRP (select [DIRECT], вне фоновых групп)
 * прошёл (иначе отказ любой группы мог значить «группа не найдена»; счёт
 * «группы не находятся»).
 *
 * ФОРМА. Нативный скрипт Egern: `export default async function (ctx)`, без
 * `$done`. Тип запуска: есть ctx.cron — schedule, нет — network.
 */

const REV = 'EGS-1';
const STAND = 'https://routehub-stash.proton4iker.workers.dev';
const PULSE = STAND + '/lab/pulse?t=';
const T24 = STAND + '/lab/t24-pulse?t=';
const WIN_MS = 600000;          // окна стенда t23 / t24 — 10 мин от эпохи
const HTTP_MS = 5000;           // ctx.http timeout, МИЛЛИСЕКУНДЫ
const TO_MS = 3000;             // проверка единиц timeout: ответ стенда в мёртвое окно — через 25 с
const FAST_MS = 1500;           // быстрее — «быстрый отказ», не ожидание
const EDGE_MIN = 4;             // раньше 4-й минуты окна — граница: группа могла не успеть (запасной cron */5)
const KEY = 'RH_EGS';
const KEY_NET = 'RH_EGS_NET';   // network-запуски пишут отдельно: без гонки с cron
const KEEP = 40;
// Состав ctx по справочнику JS API — для описи network-запуска (вывод 44).
const CTXBASE = ['abort', 'app', 'compress', 'cron', 'device', 'env', 'http', 'lookupIP', 'notify',
  'request', 'respond', 'response', 'script', 'ssh', 'storage', 'widgetFamily'];

function iso(ms) { return new Date(ms).toISOString(); }

// Текст ошибки без адресов устройства: IPv4 вне TEST-NET и IPv6 вырезаются.
function errText(e) {
  let s = '';
  try { s = String((e && e.message) || e); } catch (x) { s = '?'; }
  s = s.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, function (ip) { return ip.indexOf('192.0.2.') === 0 ? ip : '<ip>'; })
    .replace(/\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, '<ip>');
  return s.slice(0, 80);
}

// Запрос, который никогда не бросает: {ok, st, ms, e?}.
async function hit(ctx, url, policy, timeout) {
  const t0 = Date.now();
  try {
    const r = await ctx.http.get(url, { policy: policy, timeout: timeout, redirect: 'manual', credentials: 'omit' });
    const st = r && typeof r.status === 'number' ? r.status : 0;
    return { ok: st >= 200 && st < 300, st: st, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, st: 0, ms: Date.now() - t0, e: errText(e) };
  }
}

function netOf(ctx) {
  const d = (ctx && ctx.device) || {};
  if (d.wifi && d.wifi.ssid) return 'wifi';
  if (d.cellular && d.cellular.radio) return 'cell';
  return 'none';
}
function radioOf(ctx) {
  const d = (ctx && ctx.device) || {};
  const r = d.cellular && typeof d.cellular.radio === 'string' ? d.cellular.radio.replace(/^CTRadioAccessTechnology/, '') : '';
  return /^[A-Za-z0-9]{1,12}$/.test(r) ? r : null;
}

function load(ctx, key) {
  try { const v = ctx.storage.getJSON(key); return v && typeof v === 'object' ? v : null; } catch (e) { return null; }
}
function save(ctx, key, v) { try { ctx.storage.setJSON(key, v); } catch (e) { /* хранилище не роняет прогон */ } }

function fresh() {
  return { rev: REV, первый: null, запуски: [], без_контроля: 0, на_границе: 0, c: {
    pol: { да: 0, нет: 0, муляж: 0, имя: 0 }, grp: { да: 0, нет: 0 },
    ord: { да: 0, нет: 0, нр: 0 }, rej: { выбран: 0, пропущен: 0, нр: 0 }, dab: { да: 0, нет: 0, нр: 0 },
    subs: { чёт_ok: 0, чёт_err: 0, нечёт_ok: 0, нечёт_err: 0 },
    die: { ушёл: [], остался: [], вернулся: [], не_вернулся: [], нр: 0 },
    to: { да: [], нет: [], нр: [], без_паузы: 0, чёт_ok: 0 },
    names: { адр: 0, нет: 0, нр: 0 },
    cond: { wifi_ok: 0, wifi_err: 0, cell_ok: 0, cell_err: 0 },
  } };
}
function push(a, v) { a.push(v); if (a.length > KEEP) a.splice(0, a.length - KEEP); }

// Класс исхода для сравнения имён: успех / HTTP-код / исключение, быстро / долго.
function cls(r) {
  if (r.ok) return 'ok';
  return (r.st ? 'http' + r.st : 'искл') + '/' + (r.ms < FAST_MS ? 'быстро' : 'долго');
}

// Контроль policy: мёртвый муляж вне групп не пропустил запрос (policy не
// игнорируется) и несуществующее имя не ушло молча мимо (например, по
// default: DIRECT). Без этого 2xx через группу — не выбор её члена.
function policyOk(R) { return !R.dead.ok && !R.nope.ok; }

// Разбор одного прогона в счётчики. Вызывается только при живом контроле.
function tally(c, R, odd, min, net) {
  // timeout ctx.http — запрос через DIRECT, от policy не зависит.
  if (odd) {
    if (R.to.ok) c.to.без_паузы++;
    else if (R.to.ms >= 2000 && R.to.ms <= 6000) push(c.to.да, R.to.ms);
    else if (R.to.ms >= 10000) push(c.to.нет, R.to.ms);
    else push(c.to.нр, R.to.ms);
  } else if (R.to.ok) c.to.чёт_ok++;
  if (!policyOk(R)) {
    c.pol.нет++;
    if (R.dead.ok) c.pol.муляж++;
    if (R.nope.ok) c.pol.имя++;
    return;
  }
  c.pol.да++;
  // Имя узла подписки — вывод об узлах, не о группах: его контроль — муляж ≠ NOPE.
  const k1 = cls(R.n1), k0 = cls(R.nope), ks = cls(R.dead);
  if (ks === k0) c.names.нр++;
  else if (k1 === ks) c.names.адр++;
  else if (k1 === k0) c.names.нет++;
  else c.names.нр++;
  // Контроль «группы находятся по имени»: без него отказ группы мог значить
  // «группа не найдена», и любое групповое «нет» было бы без контроля.
  if (!R.grp.ok) { c.grp.нет++; return; }
  c.grp.да++;
  // Отказ, неотличимый от несуществующего имени, — не «выбран мёртвый член».
  const like0 = function (r) { return !r.ok && cls(r) === k0; };
  if (R.ord.ok) c.ord.да++; else if (like0(R.ord)) c.ord.нр++; else c.ord.нет++;
  // REJECT выбран — только если группы профиля точно есть (EGS-ORD прошёл) и
  // отказ EGS-REJ отличим от отказа несуществующего имени: иначе отказ мог
  // значить «группа не найдена».
  const rejAlive = !R.rej.ok && R.ord.ok && cls(R.rej) !== cls(R.nope);
  if (R.rej.ok) c.rej.пропущен++; else if (rejAlive) c.rej.выбран++; else c.rej.нр++;
  // «Ушёл на REJECT» — отказ того же класса, что у живого REJECT в EGS-REJ.
  const onRej = function (r) { return rejAlive && !r.ok && cls(r) === cls(R.rej); };
  if (!R.da.ok && !like0(R.da)) c.dab.нет++;
  else if (!R.da.ok) c.dab.нр++;
  else if (onRej(R.db)) c.dab.да++;
  else c.dab.нр++;
  if (odd) { if (R.subs.ok) c.subs.нечёт_ok++; else c.subs.нечёт_err++; }
  else { if (R.subs.ok) c.subs.чёт_ok++; else c.subs.чёт_err++; }
  // Смерть узла: различимо, только если REJECT живой (иначе при мёртвом DIRECT
  // все члены мертвы и группа вправе остаться на DIRECT), отказ EGS-DIE-S —
  // именно REJECT и, в нечётном окне, адрес «мёртвого» узла в этом же прогоне
  // действительно молчал (не ответил и не отказал быстро — ждали не меньше 2 с).
  if (!rejAlive || (!R.die.ok && !onRej(R.die)) || (odd && (R.to.ok || R.to.ms < 2000))) c.die.нр++;
  else if (odd) { if (R.die.ok) push(c.die.остался, min); else push(c.die.ушёл, min); }
  else if (c.die.ушёл.length) { if (R.die.ok) push(c.die.вернулся, min); else push(c.die.не_вернулся, min); }
  if (net === 'wifi') { if (R.cond.ok) c.cond.wifi_ok++; else c.cond.wifi_err++; }
  if (net === 'cell') { if (R.cond.ok) c.cond.cell_ok++; else c.cond.cell_err++; }
}

function mixed(a, b, yes, no, both) {
  if (a && !b) return yes;
  if (b && !a) return no;
  if (a && b) return both;
  return 'нет данных';
}
function mx(a) { return a.length ? Math.max.apply(null, a) : null; }

function verdicts(S) {
  const c = S.c;
  const v = {};
  const p = c.pol;
  v.policy_ctx_http = mixed(p.да, p.нет, 'да: мёртвый муляж и несуществующее имя не пропустили запрос (' + p.да + ')',
    'нет: policy не соблюдён — муляж пропустил ' + p.муляж + ', несуществующее имя ' + p.имя + '; прогоны не в итогах групп (' + p.нет + ')',
    'не всегда: да ' + p.да + ', нет ' + p.нет);
  v.группы_по_имени = mixed(c.grp.да, c.grp.нет, 'да: EGS-GRP прошла (' + c.grp.да + ')',
    'нет: EGS-GRP не прошла при соблюдённом policy — группы по имени не находятся, групповые выводы не в итогах (' + c.grp.нет + ')',
    'не всегда: да ' + c.grp.да + ', нет ' + c.grp.нет);
  v.fallback_первый_живой = mixed(c.ord.да, c.ord.нет, 'да: муляж первым пропущен, выбран DIRECT (' + c.ord.да + ')',
    'нет: через EGS-ORD запрос не прошёл при живом контроле — выбран мёртвый первый (' + c.ord.нет + ')',
    'не всегда: да ' + c.ord.да + ', нет ' + c.ord.нет);
  if (v.fallback_первый_живой === 'нет данных' && c.ord.нр) v.fallback_первый_живой = 'не различить: отказ EGS-ORD как у несуществующего имени (' + c.ord.нр + ')';
  v.REJECT_в_fallback = mixed(c.rej.выбран, c.rej.пропущен, 'считается живым: выбран первым (' + c.rej.выбран + ')',
    'пропускается как мёртвый (' + c.rej.пропущен + ')', 'по-разному: выбран ' + c.rej.выбран + ', пропущен ' + c.rej.пропущен);
  if (v.REJECT_в_fallback === 'нет данных' && c.rej.нр) v.REJECT_в_fallback = 'не различить: отказ как у несуществующего имени или EGS-ORD не прошёл (' + c.rej.нр + ')';
  if (c.dab.да || c.dab.нет) {
    v.свой_адрес_DIRECT = mixed(c.dab.да, c.dab.нет, 'да: A на DIRECT, B ушёл на REJECT — живость DIRECT своя у группы (' + c.dab.да + ')',
      'нет: в EGS-DA DIRECT не выбран при живом контроле (' + c.dab.нет + ')', 'не всегда: да ' + c.dab.да + ', нет ' + c.dab.нет);
  } else v.свой_адрес_DIRECT = c.dab.нр ? 'не различить: отказ A как у несуществующего имени, B не ушёл на REJECT или REJECT не подтверждён (' + c.dab.нр + ')' : 'нет данных';
  const s = c.subs;
  const parsed = s.чёт_ok + s.нечёт_ok;
  v.clash_direct_разобран = parsed ? 'да: запрос через EGS-SUBS прошёл (' + parsed + ')'
    : (s.чёт_err ? 'нет: в чётном окне (все узлы direct) запрос через EGS-SUBS не прошёл — не разобран или не скачан (' + s.чёт_err + ')' : 'нет данных');
  v.подписка_первый_живой = s.нечёт_ok && !s.нечёт_err ? 'да: в нечётном окне (муляж первым) выбран живой (' + s.нечёт_ok + ')'
    : (s.нечёт_ok && s.нечёт_err ? 'не всегда: да ' + s.нечёт_ok + ', нет ' + s.нечёт_err
      : (s.нечёт_err && parsed ? 'нет: в нечётном окне выбран муляж (' + s.нечёт_err + ')' : 'нет данных'));
  const d = c.die;
  if (d.ушёл.length || d.остался.length) {
    v.смерть_узла = mixed(d.ушёл.length, d.остался.length, 'замечает: ушёл с DIRECT к ' + mx(d.ушёл) + '-й мин мёртвого окна (' + d.ушёл.length + ')',
      'не замечает: на DIRECT на ' + mx(d.остался) + '-й мин мёртвого окна (' + d.остался.length + ')',
      'не всегда: ушёл ' + d.ушёл.length + ', остался ' + d.остался.length);
  } else v.смерть_узла = d.нр ? 'не различить: REJECT не подтверждён или адрес не умер (' + d.нр + ')' : 'нет данных';
  v.возврат = mixed(d.вернулся.length, d.не_вернулся.length, 'возвращается: на DIRECT к ' + mx(d.вернулся) + '-й мин живого окна',
    'не вернулся к ' + mx(d.не_вернулся) + '-й мин живого окна', 'не всегда: вернулся ' + d.вернулся.length + ', нет ' + d.не_вернулся.length);
  const t = c.to;
  v.timeout_мс = mixed(t.да.length, t.нет.length, 'да: исключение через ' + t.да.join(', ') + ' мс при timeout ' + TO_MS,
    'нет: ждал ' + t.нет.join(', ') + ' мс при timeout ' + TO_MS, 'не всегда: ' + t.да.join(', ') + ' / ' + t.нет.join(', '));
  if (v.timeout_мс === 'нет данных' && (t.нр.length || t.без_паузы)) v.timeout_мс = 'нет данных: быстрый отказ ' + t.нр.join(', ') + ' мс, без паузы ' + t.без_паузы;
  const n = c.names;
  v.имя_узла_подписки = mixed(n.адр, n.нет, 'да: EGS-N1 как статический муляж, не как несуществующее имя (' + n.адр + ')',
    'нет: EGS-N1 как несуществующее имя (' + n.адр + '/' + n.нет + ')', 'не всегда: да ' + n.адр + ', нет ' + n.нет);
  if (v.имя_узла_подписки === 'нет данных' && n.нр) v.имя_узла_подписки = 'не различить: контроль не разделил муляж и несуществующее имя (' + n.нр + ')';
  const k = c.cond;
  const wObs = k.wifi_ok + k.wifi_err, cObs = k.cell_ok + k.cell_err;
  if (wObs && cObs) {
    v.conditional = k.wifi_ok && k.cell_err && !k.wifi_err && !k.cell_ok ? 'да: Wi-Fi — DIRECT, сотовая — REJECT'
      : ((k.wifi_ok && k.cell_ok) || (k.wifi_err && k.cell_err) ? 'нет: ветка одна в обеих сетях' : 'не всегда: ' + JSON.stringify(k));
  } else if (wObs || cObs) v.conditional = 'частично: видна только ' + (wObs ? 'wifi' : 'cell') + ' ' + JSON.stringify(k);
  else v.conditional = 'нет данных';
  const r = S.запуски;
  let gmin = null, gmax = null, miss = 0;
  for (let i = 1; i < r.length; i++) {
    const g = Math.round((Date.parse(r[i]) - Date.parse(r[i - 1])) / 6000) / 10;
    gmin = gmin === null ? g : Math.min(gmin, g); gmax = gmax === null ? g : Math.max(gmax, g);
    if (g > 15) miss++;
  }
  v.cron = 'запусков ' + r.length + (r.length > 1 ? ', промежутки ' + gmin + '–' + gmax + ' мин, пропусков (>15 мин) ' + miss : '');
  return v;
}

function brief(r) { return r ? (r.ok ? 'ok ' : (r.st ? r.st + ' ' : 'err ')) + r.ms : '-'; }

function report(ctx, dump, lines, sound) {
  const s = JSON.stringify(dump);
  try { console.log('[EGS] ' + s); } catch (e) { /* журнал не роняет прогон */ }
  try {
    ctx.notify({ title: 'RouteHub ' + REV + ' ' + dump.вид, body: lines.join('\n'), sound: sound,
      action: { type: 'clipboard', text: s } });
  } catch (e) { /* уведомление не роняет прогон */ }
}

async function runNet(ctx, now, net) {
  const ctl = await hit(ctx, PULSE + 'egs-net-' + net, 'DIRECT', HTTP_MS);
  let keys = [];
  try {
    keys = Object.getOwnPropertyNames(ctx);
    const p = Object.getPrototypeOf(ctx);
    if (p && p !== Object.prototype) keys = keys.concat(Object.getOwnPropertyNames(p));
  } catch (e) { keys = []; }
  const nov = keys.filter(function (k, i) { return CTXBASE.indexOf(k) < 0 && k.charAt(0) !== '_' && keys.indexOf(k) === i; });
  const N = load(ctx, KEY_NET) || { rev: REV, смены: [] };
  if (!Array.isArray(N.смены)) N.смены = [];
  const first = !N.смены.length;
  push(N.смены, iso(now) + ' ' + net);
  save(ctx, KEY_NET, N);
  const dump = { rev: REV, ts: iso(now), вид: 'network', сеть: net, радио: radioOf(ctx), контроль: brief(ctl),
    новое_в_ctx: nov.length ? 'ДА: ' + nov.join(', ') : 'НЕТ — только поля справочника', смен_сети: N.смены.length, смены: N.смены.slice(-10) };
  report(ctx, dump, ['сеть: ' + net + ', контроль ' + brief(ctl), 'новое в ctx: ' + (nov.length ? nov.join(', ') : 'нет')], first);
}

async function runCron(ctx, now, net) {
  const w = Math.floor(now / WIN_MS);
  const odd = w % 2 === 1;
  const min = Math.floor((now % WIN_MS) / 6000) / 10;
  const ctl = await hit(ctx, PULSE + 'egs-cron-' + net, 'DIRECT', HTTP_MS);
  const names = ['ord', 'rej', 'da', 'db', 'subs', 'die', 'cond', 'grp', 'n1', 'nope', 'dead', 'to'];
  const res = await Promise.all([
    hit(ctx, PULSE + 'egs-via-ord', 'EGS-ORD', HTTP_MS),
    hit(ctx, PULSE + 'egs-via-rej', 'EGS-REJ', HTTP_MS),
    hit(ctx, PULSE + 'egs-via-da', 'EGS-DA', HTTP_MS),
    hit(ctx, PULSE + 'egs-via-db', 'EGS-DB', HTTP_MS),
    hit(ctx, PULSE + 'egs-via-subs', 'EGS-SUBS', HTTP_MS),
    hit(ctx, PULSE + 'egs-via-die', 'EGS-DIE-S', HTTP_MS),
    hit(ctx, PULSE + 'egs-via-cond', 'EGS-COND', HTTP_MS),
    hit(ctx, PULSE + 'egs-via-grp', 'EGS-GRP', HTTP_MS),
    hit(ctx, PULSE + 'egs-name', 'EGS-N1', HTTP_MS),
    hit(ctx, PULSE + 'egs-name', 'EGS-NOPE', HTTP_MS),
    hit(ctx, PULSE + 'egs-name', 'EGS-DEAD-3', HTTP_MS),
    hit(ctx, T24 + 't24pa', 'DIRECT', TO_MS),
  ]);
  const R = {};
  names.forEach(function (k, i) { R[k] = res[i]; });
  const S0 = load(ctx, KEY);
  const S = S0 && S0.c && Array.isArray(S0.запуски) ? S0 : fresh();
  const first = !S.первый;
  if (first) S.первый = iso(now);
  push(S.запуски, iso(now));
  const edge = min < EDGE_MIN;
  if (!ctl.ok) S.без_контроля++;
  else if (edge) S.на_границе++;
  else tally(S.c, R, odd, min, net);
  const pol = policyOk(R);
  const inSum = ctl.ok && !edge && pol && R.grp.ok;
  // Классы исходов этого прогона — для чтения глазами (текст ошибки различает то,
  // чего не различает класс), в итоги не идут.
  const seen = {};
  [['EGS-N1', 'n1'], ['EGS-NOPE', 'nope'], ['EGS-DEAD-3', 'dead'], ['EGS-REJ', 'rej']].forEach(function (x) {
    const r = R[x[1]];
    seen[x[0]] = cls(r) + (r.e ? ' ' + r.e : '');
  });
  save(ctx, KEY, S);
  const v = verdicts(S);
  const run = { контроль: brief(ctl) };
  names.forEach(function (k) { run[k] = brief(R[k]); });
  const dump = { rev: REV, ts: iso(now), вид: 'cron', сеть: net, радио: radioOf(ctx), окно: w, нечёт: odd, мин: min,
    прогон: run, в_итоги: inSum, без_контроля: S.без_контроля, на_границе: S.на_границе,
    policy_не_соблюдён: S.c.pol.нет, группы_не_находятся: S.c.grp.нет, итоги: v, имена: seen };
  report(ctx, dump, [
    (!ctl.ok ? 'контроль НЕ прошёл — прогон не в итогах' : edge ? 'граница окна — прогон не в итогах'
      : !pol ? 'policy НЕ соблюдён — группы не в итогах'
        : !R.grp.ok ? 'группы по имени не находятся — группы не в итогах' : 'контроль ok') + ', сеть ' + net + ', ' + v.cron,
    'первый живой: ' + v.fallback_первый_живой.split(':')[0] + '; подписка: ' + v.подписка_первый_живой.split(':')[0],
    'смерть узла: ' + v.смерть_узла.split(':')[0] + '; timeout мс: ' + v.timeout_мс.split(':')[0],
  ], first);
}

export default async function egs(ctx) {
  const now = Date.now();
  try {
    const net = netOf(ctx);
    if (typeof ctx.cron === 'string') await runCron(ctx, now, net);
    else await runNet(ctx, now, net);
  } catch (e) {
    try { console.log('[EGS] ' + JSON.stringify({ rev: REV, ts: iso(now), ошибка: errText(e) })); } catch (x) { /* нечем сообщить */ }
  }
}
