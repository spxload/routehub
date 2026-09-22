// =============================================================
// routehub-stash-collect.js — RouteHub, сборщик метрик узлов для Stash
var VERSION = 'stash-collect v0.2.2 (2026-09-22)';
//
// Тип: cron (каждые 20 мин). Аргумент: "<key>|<origin>|<opts>" —
// та же форма, что у routehub-speedtest.js в Loon. `origin` включает префикс
// токена целиком, если он нужен: <origin>/t/<токен>; дальше скрипт добавляет
// /speed. Валидность проверяется до первого сетевого вызова.
//
// v0.2.2 — доля потерь ядра и сравнение delay ядра с нашим rtt. Оба пункта
//   закрывают хвосты ADR-04 (§6.7 п. 3 и §7 п. 2). Оба — ВЫЧИСЛЕНИЯ НАД
//   УЖЕ ПОЛУЧЕННЫМ: ответ /proxies и кэш узлов. Ни одного нового запроса ни
//   к контроллеру, ни через узлы (правила 1 и 2), худший путь до $done —
//   прежние 75 с. Наружу, в Worker, ни то ни другое НЕ УХОДИТ: контракт
//   /speed не тронут, числа живут только в отчёте, кэше и журнале прогонов.
//   * ДОЛЯ ПОТЕРЬ ЯДРА. Раньше узел, проваливший половину проверок ядра, был
//     неотличим от безупречного: учитывался лишь счётчик fails ПОДРЯД, и
//     одна удачная проверка его обнуляла. Теперь каждый прогон дописывает
//     наблюдение alive в окно lw (последние LOSS_N), отчёт выводит долю.
//     Окно, а не накопление, — расчёт у LOSS_N.
//   * delay ЯДРА ПРОТИВ rtt. Оба замера ходят на generate_204 (BENCH_URL в
//     src/clients/stash.js и PING_URL здесь), поэтому сравнимы по адресу.
//     Отчёт даёт медиану расхождения, медиану отношения и число узлов;
//     меньше CMP_MIN пар — прямо «данных мало», без числа.
//
// v0.2.1 — сторож и журнал выбора. Кратко, что изменилось по существу:
//   * СТОРОЖ 25 -> 90 С, ПУТЬ ДО $done ОГРАНИЧЕН. Арифметика v0.2.0
//     («25 с втрое — 75 с, скрипт уже закончил») держалась на растяжении
//     таймеров, а его может и не быть: без растяжения 25 с номинала — это
//     25 с настоящих, и сторож обрывал живой прогон посреди замера. Обрыв
//     по своему таймеру выглядит как отказ узла — дефект ST14, проект
//     ловил его уже четыре раза. Сверх того худший честный путь v0.2.0 ничем
//     не был ограничен (до 120 с): узел запускался до 30-й секунды и сам
//     стоил до 75. Теперь тайм-аут каждого запроса замера подрезается под
//     остаток бюджета (capSec), и путь до $done не длиннее 75 с при стороже
//     в 90. Расчёт — у GUARD_MS.
//   * ЖУРНАЛ ВЫБОРА СЛУЖЕБНЫХ ГРУПП. S-draft-7 (14.09) перевёл RH-Главный из
//     ручного select в fallback, и у этого решения записан новый риск: если
//     ядро ошибочно сочтёт DIRECT мёртвым, весь прочий иностранный трафик
//     молча уйдёт на узлы, включая ПЛАТНЫЕ обходные. Увидеть этот уход можно
//     только по полю now групп, поэтому сборщик его теперь записывает, а уход
//     RH-Главный или RH-RU с DIRECT ставит ПЕРВОЙ строкой отчёта. Это чтение
//     того же ответа /proxies: ни одного нового запроса, ни байта через узлы.
//
// v0.2.0 — по итогам ревью v0.1.0. Разбор ревью и причины решений — в
//   docs/ADR-04, §6. Кратко, что изменилось по существу:
//   * КЛЮЧ КЭША — БАЗОВОЕ ИМЯ. Имя узла в профиле несёт метрики
//     («… · 21↓68 / 7↓96»), и они меняются при каждой перевыдаче конфига.
//     Кэш по полному имени обнулялся бы после каждого замера: узлы вечно
//     «просрочены», трафик вчетверо, мёртвый узел никогда не помечен мёртвым.
//     Ровно так же ключуется кэш у Loon (baseName), только там это было
//     сделано сразу.
//   * ВСЕ ЧЕТЫРЕ МЕТРИКИ СНИМАЕТ САМ СКРИПТ, а не ядро. v0.1.0 брала rtt и
//     jit из истории замеров ядра — даром и красиво, но НЕСОПОСТАВИМО:
//     история ядра это HEAD раз в 600 с, и её размах — разброс между
//     десятиминутными интервалами, тогда как пороги проекта (FLOOR_JIT 10,
//     VOICE_JIT 30, FLOOR_BL 20) откалиброваны на пяти подряд идущих пробах
//     Loon. Числа выглядели бы теми же, а значили бы другое. История ядра
//     оставлена там, где сопоставимость не нужна: очередь кандидатов и
//     живость узла.
//   * bl — ПРИРОСТ, а не абсолют. Было `bl = медиана(под нагрузкой)`, стало
//     `max(0, медиана(под нагрузкой) − rtt)`, как в Loon. Абсолютная
//     задержка 80–300 мс на шкале, рассчитанной на прирост, означала бы, что
//     ни один узел не годится для звонков, а измеренный узел проигрывает
//     неизмеренному.
//   * ТАЙМ-АУТЫ В СЕКУНДАХ. У Stash `timeout` — секунды (пробы ST1 и ST9
//     отвечают при значениях 3, 5, 8), у Loon — миллисекунды. Перенос
//     значений Loon давал закачке тайм-аут в семь часов.
//   * Правило 1 усилено вторым рубежом: перед активной фазой проверяется,
//     на какой узел смотрит сам пул. Если ядро сейчас выбрало обходной —
//     фаза не запускается вовсе (см. «второй рубеж» ниже).
//   * Вердикт пиновки принимается ТОЛЬКО ПОСЛЕ ДВУХ подряд удачных проверок.
//   * Кэш пишется после каждого узла, а не один раз в конце.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ПРАВКА ЛООНОВСКОГО. Сборщик Loon стоит на трёх
// опорах, из которых у Stash нет ни одной в прежнем виде (ADR-04, §1):
//
//   опора Loon                     | замена на Stash                | статус
//   -------------------------------|--------------------------------|--------
//   $config.getSubPolicys(группа)  | GET /proxies контроллера        | ST3, ST9
//   $config.getConfig().ssid       | на кого смотрит родитель с      | ST9
//                                  | ssid-policy: хвост -W или -C    |
//   $httpClient.get({node:...})    | заголовок                       | НЕ ПРОВЕРЕН,
//                                  | X-Stash-Selected-Proxy          | см. Ф3
//
// ЧТО ДАЁТ ЯДРО. Группы -W/-C — fallback с умолчанием interval 600 с, у
// рабочих узлов стоят benchmark-url и benchmark-timeout (S-draft-3), поэтому
// ядро само непрерывно проверяет каждый узел. Отсюда берутся ЖИВОСТЬ (поле
// alive) и ОЧЕРЕДЬ КАНДИДАТОВ (поле delay: кого мерить первым). Истории
// замеров у Stash 3.4.1 НЕТ — запись узла в /proxies это `address, alive,
// delay, name, state, type` (ST9), одно текущее значение. В балл эти числа
// не идут — см. выше про сопоставимость.
//
// ЧТО СКРИПТ МЕРЯЕТ САМ, через узел, тем же методом, что и Loon:
//   rtt  — минимум из RTT_SAMPLES проб generate_204;
//   med  — медиана тех же проб;
//   jit  — усечённый размах тех же проб (крайние отброшены при 5 и более);
//   bl   — max(0, медиана проб ВО ВРЕМЯ закачки − rtt);
//   down — DOWN_BYTES через узел, Мбит/с.
//
// ПАССИВНАЯ СКОРОСТЬ ИЗ /connections — только нижняя граница. download.max
// (байты в секунду, ST11) даётся даром, но покрывает один-два узла из
// полусотни и говорит о том, что качало приложение, а не о возможностях
// узла. Поэтому она поднимает down у УЖЕ ИЗМЕРЕННОГО узла, если тот выдал
// больше намеренного, и никогда не опускает; и она НЕ ОТМЕНЯЕТ очередной
// активный замер — иначе одно видео замораживало бы узел на сутки.
//
// УЗЕЛ БЕЗ АКТИВНОГО ЗАМЕРА НЕ ОТПРАВЛЯЕТСЯ ВОВСЕ. Контракт /speed не умеет
// сказать «метрика неизвестна»: metricOf превращает отсутствующее поле в 0,
// а нулевые rtt и jit на шкале scoreOf — это МАКСИМАЛЬНЫЙ балл. То есть
// «отправить, чего намерили» означало бы поднять неизмеренный узел на верх
// списка. Отсутствие записи — единственный честный способ сказать «не знаю».
//
// ПРАВИЛО 1 ПРОЕКТА (обходные узлы не тестировать — платный трафик) держится
// на двух рубежах:
//   1) имя с пометкой обхода отбрасывается при сборе пула, до любого вызова;
//   2) ВТОРОЙ РУБЕЖ, на случай если пиновка молча перестанет работать:
//      запрос без действующей пиновки уходит по текущей политике, а
//      последний запас fallback — как раз обходной узел. Поэтому и
//      самопроверка, и активная фаза запускаются, только если пул ПРЯМО
//      СЕЙЧАС смотрит на необходной узел (поле now у группы -W/-C).
// ПРАВИЛО 2 (диагностика не пишет в боевую маршрутизацию): к контроллеру
// идут только GET. PUT /proxies/{имя} и PATCH /configs в этом файле нет и
// быть не должно; тест tests/stash-collect.test.js роняет прогон, если они
// появятся. Журнал выбора групп (v0.2.1) только ЧИТАЕТ поле now: уход
// RH-Главный с DIRECT он показывает, но вернуть его обратно не пытается и
// не должен — это решение Дианы, а не скрипта.
//
// ЧЕГО ЗДЕСЬ ПОКА НЕТ. Лёгкого пинг-свипа (Loon v0.6.0): rtt узла стареет
// вместе с down, до суток. Свип осмыслен, но это отдельный кусок с
// собственной ротацией и бюджетом; вводить его вместе с первой рабочей
// редакцией — значит отлаживать два механизма разом.
// =============================================================

// ── НАСТРОЙКИ ────────────────────────────────────────────────────────
var CACHE_MS = 24 * 3600 * 1000;   // срок годности активного замера
var ACTIVE_N = 3;                  // сколько узлов мерить за прогон
var DOWN_BYTES = 4000000;          // объём пробной закачки (как в Loon)
var RTT_SAMPLES = 5;               // проб задержки без нагрузки (как в Loon)
var BL_SAMPLES = 3;                // проб задержки во время закачки
var BL_GAP = 300;                  // номинальный интервал между ними, мс
var MAX_FAILS = 5;                 // подряд «не жив» по ядру -> dead
var PIN_STREAK = 2;                // удачных самопроверок подряд до вердикта
var LOG_MAX = 40;
// ДОЛЯ ПОТЕРЬ ЯДРА (v0.2.2). Прогон читает alive каждого узла пула из
// /proxies — это итог последней проверки ядра — и дописывает его в окно lw
// записи кэша: '0' — жив, '1' — провал. Счётчики попыток и неудач — длина
// окна и число единиц в нём.
// ОКНО, А НЕ НАКОПЛЕНИЕ. Накопительная доля через месяц прогонов по 20 мин
// (тысячи наблюдений) перестаёт реагировать: узел, который с сегодняшнего
// дня падает через раз, сдвинул бы её на доли процента. 36 прогонов — около
// 12 часов непрерывной работы туннеля; окно считается в попытках, а не в
// часах, потому что Stash поднимают по надобности (см. режим стенда в ADR-04).
// Ядро проверяет узел раз в 600 с, прогон идёт раз в 1200 с, поэтому соседние
// наблюдения — это разные проверки ядра, а не одна прочитанная дважды.
// КЛЮЧ — базовое имя, тот же, что у всего кэша: перевыдача конфига меняет
// хвост метрик в имени, и окно по полному имени обнулялось бы (дефект v0.1.0).
// Кэш раздельный по сетям, значит и доля — отдельно для Wi-Fi и сотовой.
var LOSS_N = 36;                   // длина окна, попыток
var LOSS_MIN = 5;                  // меньше попыток — доля узла не выводится
// Сравнение delay ядра с rtt: меньше CMP_MIN пар — «данных мало», без числа.
var CMP_MIN = 5;

// ТАЙМ-АУТЫ — В СЕКУНДАХ. У Stash поле timeout измеряется секундами: пробы
// ST1 (timeout: 8) и ST9 (timeout: 3 и 5) получали ответы, чего не бывает
// при миллисекундах. У Loon то же поле — миллисекунды; перенос значений
// оттуда дал бы закачке тайм-аут в семь часов.
var CTRL_SEC = 5;
var PING_SEC = 10;
var DOWN_SEC = 25;
var IP_SEC = 8;
var POST_SEC = 15;

// ВРЕМЯ ПРОГОНА — ДВЕ ШКАЛЫ, И ИХ НЕЛЬЗЯ ПУТАТЬ. BUDGET_MS считается по
// Date.now(), то есть настоящий; GUARD_MS — номинал для setTimeout, который
// Stash в фоне растягивает (ST5: 33 с превратились в 120 с, то есть примерно
// втрое-вчетверо), но не укорачивает. Тайм-ауты $httpClient не растягиваются:
// это секунды ядра (ST1, ST9).
//
// СТОРОЖ ОБЯЗАН СРАБАТЫВАТЬ ПОЗЖЕ ХУДШЕГО ЧЕСТНОГО ПУТИ, СЧИТАЯ БЕЗ
// РАСТЯЖЕНИЯ. Растяжение известно по одному замеру и бывает не всегда; если
// на него опереться, сторож в прогоне без растяжения обрежет живой замер, и
// обрыв по своему таймеру прочитается как отказ узла (дефект ST14). Так было
// в v0.2.0: 25 с номинала при пути до 120 с.
//
// ХУДШИЙ ЧЕСТНЫЙ ПУТЬ (v0.2.1). Каждый запрос замера и контроллера получает
// тайм-аут capSec — номинал, подрезанный под остаток бюджета до целых
// секунд вниз, — а когда остатка нет, не отправляется вовсе. Запрос,
// ушедший в момент t, закрывается не позже t + floor(остаток) ≤ BUDGET_MS.
// После бюджета остаётся одна выгрузка с полным POST_SEC. Итого
//   BUDGET_MS + POST_SEC = 60 + 15 = 75 с настоящих;
// сторож в 90 с номинала — это не меньше 90 с настоящих, запас 15 с на
// задержку колбэков и синхронный хвост (merge, запись кэша). В фоне сторож
// растянется до 270–360 с и уступит тайм-ауту манифеста (180 с); 75 с
// помещаются и под ним. Тест tests/stash-collect.test.js гоняет этот путь
// на виртуальных часах и падает, если $done позже GUARD_MS − 10 с.
//
// Бюджет снижен с 70 до 60 с ради этого запаса. Узел запускается, пока до
// конца бюджета не меньше NODE_COST_MS, то есть в первые 20 с прогона
// (было 30). Кэш по-прежнему пишется ПОСЛЕ КАЖДОГО узла: сторож, сработавший
// не вовремя, не отменяет уже сделанной работы.
var BUDGET_MS = 60000;
var GUARD_MS = 90000;
var NODE_COST_MS = 40000;          // сколько времени резервировать на узел
var LOCK_MS = 15 * 60 * 1000;
var PIN_TTL = 24 * 3600 * 1000;

var IP_URL = 'https://api.ipify.org?format=json';
var DOWN_HOST = 'https://speed.cloudflare.com/__down';
var PING_URL = 'http://connectivitycheck.gstatic.com/generate_204';

var PARENTS = ['RH-AI', 'RH-АВТО', 'RH-Звонки'];
// Журнал выбора (v0.2.1): чьё поле now записывается в отчёт. Имена — те же,
// что строит рендерер профиля; сцепку держит tests/stash-collect-coupling.
var WATCH = ['RH-Главный', 'RH-RU', 'RH-Обход', 'RH-AI', 'RH-АВТО', 'RH-Звонки'];
var G_MAIN = 'RH-Главный';
var G_RU = 'RH-RU';
var G_BYP = 'RH-Обход';
var DIRECT = 'DIRECT';
var POOL_W = 'RH-АВТО-W';
var POOL_C = 'RH-АВТО-C';
var BYPASS = 'Обход';
var METRIC_SEP = ' · ';

var K_NONCE = 'rh_nonce';
var K_W = 'rh_stash_wifi';
var K_C = 'rh_stash_cell';
var K_PIN = 'rh_stash_pin';
var K_LOCK = 'rh_stash_lock';
var K_LOG = 'rh_stash_log';

// ── МЕЛОЧЁВКА ────────────────────────────────────────────────────────
var G = (typeof globalThis !== 'undefined') ? globalThis : this;
var T0 = Date.now();

function readRaw(key) { try { return $persistentStore.read(key); } catch (e) { return null; } }
function writeRaw(key, val) { try { return $persistentStore.write(val, key) !== false; } catch (e) { return false; } }
function readJSON(key, def) { var s = readRaw(key); if (!s) return def; try { return JSON.parse(s); } catch (e) { return def; } }
function writeJSON(key, obj) { return writeRaw(key, JSON.stringify(obj)); }

function num(a, b) { return a - b; }
function median(arr) {
  if (!arr || !arr.length) return null;
  var a = arr.slice().sort(num);
  var m = Math.floor(a.length / 2);
  return (a.length % 2) ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}
function minOf(arr) {
  if (!arr || !arr.length) return null;
  var a = arr.slice().sort(num);
  return a[0];
}
// Джиттер — УСЕЧЁННЫЙ размах, как в speedtest v0.6.2: на пяти и более пробах
// крайние отбрасываются, иначе один выброс (узел на секунду пропал или iOS
// придержал планировщик) определял бы метрику целиком.
function trimRange(arr) {
  if (!arr || arr.length < 2) return 0;
  var a = arr.slice().sort(num);
  if (a.length >= 5) a = a.slice(1, a.length - 1);
  return Math.max(0, a[a.length - 1] - a[0]);
}
// Базовое имя узла: всё до разделителя метрик. Имя в профиле выглядит как
// «🇳🇱 Нидерланды [VPN] 01 · 21↓68 / 7↓96», и хвост меняется при каждой
// перевыдаче конфига. Кэш ключуется базовым именем, а запросы пинуются
// полным — ровно как в Loon (baseName там же).
function baseName(n) {
  var s = String(n);
  var i = s.indexOf(METRIC_SEP);
  return (i >= 0 ? s.slice(0, i) : s).replace(/^\s+|\s+$/g, '');
}
function isBypass(name) { return String(name).indexOf(BYPASS) >= 0; }
function looksLikeNode(n) { return typeof n === 'string' && n.length >= 5 && n.indexOf('[') >= 0; }
function isGroup(p) {
  var t = String((p && (p.type || p.Type)) || '').toLowerCase();
  return t === 'selector' || t === 'fallback' || t === 'urltest' || t === 'url-test' ||
    t === 'loadbalance' || t === 'load-balance' || t === 'relay';
}
function left() { return BUDGET_MS - (Date.now() - T0); }
// Тайм-аут запроса в секундах, подрезанный под остаток бюджета; 0 — времени
// нет, запрос не отправлять. Округление ВНИЗ и только целые: так запрос не
// переживёт бюджет, а дробный timeout у Stash ни одной пробой не проверен.
// На этом держится арифметика сторожа (см. GUARD_MS).
function capSec(nominal) {
  var s = Math.floor(left() / 1000);
  return (s >= nominal) ? nominal : ((s >= 1) ? s : 0);
}

var LOG = [];
function say(s) { LOG.push(s); try { console.log('RH-Collect: ' + s); } catch (e) {} }

// ── СОСТОЯНИЕ ПРОГОНА ────────────────────────────────────────────────
var CTRL = 'http://127.0.0.1:9090', AUTH = '';
var KEY = '', ORIGIN = '', OPTS = '', NONCE = '';
var NET = '';            // 'wifi' | 'cell'
var POOL = [];           // [{full, base}] рабочих узлов, порядок = балл
var CORE = {};           // base -> {alive, med, n}
var PASS = {};           // base -> Мбит/с, пассивный пик из /connections
var NOW_OK = false;      // пул смотрит на необходной узел (второй рубеж)
var CACHE = {}, CKEY = '';
var PIN = null;
var FATAL = '';
var ACT = { tried: 0, ok: 0 };
var SEL = null;          // группа -> цепочка выбора [now, now у now, ...]
var SEL_HEAD = '';       // первая строка отчёта: штатно или тревога
var LZ = null, DV = null; // сводки v0.2.2 для журнала прогонов

// ── СЕТЕВЫЕ ПРИМИТИВЫ ────────────────────────────────────────────────
// К контроллеру — только GET (правило 2).
function ctlGet(path, cb) {
  var sec = capSec(CTRL_SEC);
  var o = { url: CTRL + path, timeout: sec };
  if (AUTH) o.headers = { Authorization: AUTH };
  var done = false;
  function once(b, e) { if (done) return; done = true; cb(b, e); }
  if (!sec) { once(null, 'бюджет исчерпан'); return; }
  try {
    G.$httpClient.get(o, function (e, r, body) {
      once(e ? null : body,
        e ? String(e) : ((r && r.status >= 400) ? ('HTTP ' + r.status) : null));
    });
  } catch (e2) { once(null, String(e2)); }
}

// Пиновка запроса на узел: имя прокси URL-кодированным в заголовке
// X-Stash-Selected-Proxy (документация Stash). Имя — ПОЛНОЕ, с хвостом
// метрик: ядро сопоставляет строкой.
function pinned(full, url, sec) {
  return { url: url, timeout: sec, headers: { 'X-Stash-Selected-Proxy': encodeURIComponent(full) } };
}

// ── Ф1. ИНВЕНТАРЬ: /proxies ──────────────────────────────────────────
// Один запрос закрывает четыре вопроса: какая сейчас сеть, из кого состоит
// пул, что ядро думает о живости каждого узла и на кого пул смотрит прямо
// сейчас (второй рубеж правила 1).
// ЗАДЕРЖКА ГЛАЗАМИ ЯДРА. По ST9 запись узла в `/proxies` у Stash 3.4.1
// несёт поля `address, alive, delay, name, state, type`: ОДНО текущее
// значение, поля `history` НЕТ. Поэтому основной путь — `delay`, а разбор
// истории оставлен запасным: она есть у Clash-совместимых ядер и появится,
// если Stash однажды начнёт её отдавать. Разбирать несуществующее поле как
// основной источник — это тихо получать пустоту и не знать об этом.
// Число идёт в очередь кандидатов, в перекрёстную проверку живости и
// (v0.2.2) в сводку «delay ядра против rtt» отчёта; в балл оно не попадает —
// метод замера ядра несопоставим с нашим (шапка).
function delaysOf(p) {
  var out = [];
  var cur = +(p.delay != null ? p.delay : (p.Delay != null ? p.Delay : 0));
  if (cur > 0) out.push(cur);
  function eat(h) {
    if (!h || !h.length) return;
    for (var i = 0; i < h.length; i++) {
      var v = h[i];
      var d = (typeof v === 'number') ? v
        : (v && (v.delay != null ? v.delay : (v.meanDelay != null ? v.meanDelay : null)));
      d = +d;
      if (d > 0) out.push(d);
    }
  }
  if (!out.length) eat(p.history || p.History);
  // Ядро может держать историю в разрезе тест-адреса (поле extra). Точная
  // форма у Stash не документирована, поэтому читается оборонительно.
  if (!out.length && p.extra) {
    for (var k in p.extra) { eat(p.extra[k] && p.extra[k].history); if (out.length) break; }
  }
  return out;
}

// ── ЖУРНАЛ ВЫБОРА СЛУЖЕБНЫХ ГРУПП (v0.2.1) ───────────────────────────
// ТОЛЬКО ЧТЕНИЕ поля now из уже полученного ответа /proxies: ни одного
// нового запроса к контроллеру и ни одного — через узлы (правила 1 и 2).
// Зачем: после S-draft-7 RH-Главный — fallback, и если ядро сочтёт DIRECT
// мёртвым, прочий иностранный трафик уйдёт на узлы, включая обходные. Этот
// уход ничем, кроме поля now, не виден — поэтому он поднимается в первую
// строку отчёта, а не лежит среди прочих.
//
// Цепочка раскрывается до узла: «RH-Главный → RH-АВТО → RH-АВТО-W → узел».
// Иначе тревога сообщала бы только имя группы, а вопрос «платный ли это
// узел» оставался бы открытым. Глубина ограничена, петли отсекаются: форма
// ответа ядра нам не подконтрольна.
function chainOf(MAP, name) {
  var out = [], seen = {}, cur = name;
  for (var d = 0; d < 6 && cur && !seen[cur]; d++) {
    seen[cur] = 1;
    var p = MAP[cur];
    var nx = p ? String(p.now || p.Now || '') : '';
    if (!nx) break;
    out.push(nx);
    cur = nx;
  }
  return out;
}

function chainStr(g) {
  var c = SEL[g];
  var s = [g].concat(c).join(' → ');
  var last = c.length ? c[c.length - 1] : '';
  return (isBypass(last) || c.indexOf(G_BYP) >= 0) ? s + ' (ОБХОД, платный трафик)' : s;
}

function readSelection(MAP) {
  SEL = {};
  var parts = [];
  for (var i = 0; i < WATCH.length; i++) {
    var g = WATCH[i];
    if (!MAP[g]) { parts.push(g + '=нет группы'); continue; }
    SEL[g] = chainOf(MAP, g);
    parts.push(g + '=' + (SEL[g][0] || '?'));
  }
  // Тревога — только по двум группам, которым положено стоять на DIRECT.
  // Отсутствие группы тоже тревога: уход с DIRECT в этом случае не виден.
  var alarm = [];
  var main = SEL[G_MAIN], ru = SEL[G_RU], byp = SEL[G_BYP];
  // Пустое now — тоже тревога: выбор группы неизвестен, а значит неизвестно
  // и то, что она на DIRECT. Молчать здесь — ровно тот тихий отказ, ради
  // которого журнал заведён.
  if (!main) alarm.push(G_MAIN + ' нет в /proxies — уход с DIRECT не виден');
  else if (!main[0]) alarm.push(G_MAIN + ': поле now пусто, выбор неизвестен');
  else if (main[0] !== DIRECT) alarm.push(G_MAIN + ' не на DIRECT: ' + chainStr(G_MAIN));
  if (!ru) alarm.push(G_RU + ' нет в /proxies — уход с DIRECT не виден');
  else if (!ru[0]) alarm.push(G_RU + ': поле now пусто, выбор неизвестен');
  else if (ru[0] === G_BYP && byp && byp[0] && byp[0] !== DIRECT) {
    // RH-Обход, стоящий на DIRECT, — это профиль без обходных узлов:
    // трафик уходит напрямую, платить не за что. Иначе — платит.
    alarm.push('РФ-трафик идёт по ПЛАТНОМУ обходу: ' + chainStr(G_RU));
  } else if (ru[0] !== DIRECT) alarm.push(G_RU + ' не на DIRECT: ' + chainStr(G_RU));
  SEL_HEAD = alarm.length ? ('⚠ ТРЕВОГА ВЫБОРА: ' + alarm.join('; '))
    : ('выбор штатный: ' + G_MAIN + ' и ' + G_RU + ' на DIRECT');
  say('выбор групп: ' + parts.join(' · '));
}

function stepInventory(next) {
  ctlGet('/proxies', function (body, e) {
    if (e || !body) { FATAL = 'контроллер не ответил: ' + (e || 'пусто'); next(); return; }
    var d = null;
    try { d = JSON.parse(body); } catch (e2) { FATAL = 'ответ /proxies не разобран'; next(); return; }
    var MAP = (d && (d.proxies || d.Proxies)) || d || {};
    // Выбор читается ДО проверок сети и пула: тревога о платном трафике
    // нужна и в том прогоне, который дальше споткнётся о FATAL.
    readSelection(MAP);

    // Сеть — это ЧТЕНИЕ решения, уже принятого ядром по ssid-policy, а не
    // своё определение. Родителей трое; расхождение между ними означает, что
    // читать нечего, и прогон честнее пропустить, чем записать наугад.
    var nets = {}, seen = 0;
    for (var i = 0; i < PARENTS.length; i++) {
      var p = MAP[PARENTS[i]];
      if (!p) continue;
      seen++;
      var cur = String(p.now || p.Now || '');
      var tail = cur.slice(-2);
      if (tail === '-W') nets.wifi = 1;
      else if (tail === '-C') nets.cell = 1;
      else if (cur) nets.other = 1;
    }
    var ks = [];
    for (var n in nets) ks.push(n);
    NET = (ks.length === 1 && ks[0] === 'wifi') ? 'wifi'
      : ((ks.length === 1 && ks[0] === 'cell') ? 'cell' : '');
    if (!NET) {
      FATAL = 'сеть не определена (родителей ' + seen + ', признаки: ' + (ks.join('+') || 'нет') + ')';
      next(); return;
    }

    var poolName = (NET === 'wifi') ? POOL_W : POOL_C;
    var g = MAP[poolName];
    if (!g) { FATAL = 'группы ' + poolName + ' нет в /proxies'; next(); return; }

    // ВТОРОЙ РУБЕЖ ПРАВИЛА 1. Если пиновка молча не работает, запрос уходит
    // по текущей политике. Поэтому спрашиваем ядро, кого политика выбрала
    // прямо сейчас: обходной — активной фазы не будет.
    var nowNode = String(g.now || g.Now || '');
    NOW_OK = !!nowNode && !isBypass(nowNode);

    var members = (g.all || g.All) || [];
    for (var m = 0; m < members.length; m++) {
      var nm = members[m];
      if (!nm || isBypass(nm)) continue;      // первый рубеж, до любого вызова
      if (!looksLikeNode(nm)) continue;       // служебные члены (DIRECT и пр.)
      var p2 = MAP[nm];
      if (!p2 || isGroup(p2)) continue;
      var b = baseName(nm);
      if (CORE[b]) continue;                  // дубликат имени — берём первый
      var dl = delaysOf(p2);
      CORE[b] = {
        alive: (p2.alive !== undefined) ? !!p2.alive
          : ((p2.Alive !== undefined) ? !!p2.Alive : (dl.length > 0)),
        med: median(dl),
        n: dl.length,
      };
      POOL.push({ full: nm, base: b });
    }
    if (!POOL.length) { FATAL = 'пул ' + poolName + ' пуст'; next(); return; }
    say('сеть ' + NET + ', пул ' + poolName + ': ' + POOL.length + ' узлов, выбран ' +
      (NOW_OK ? 'рабочий' : 'ОБХОДНОЙ или неизвестно') + ' узел');
    next();
  });
}

// ── Ф2. ПАССИВНАЯ СКОРОСТЬ: /connections ─────────────────────────────
// Счётчики upload/download — ОБЪЕКТЫ {current,last,max,total}; max — пиковая
// скорость в байтах в секунду (ST11). Берётся максимум по всем соединениям,
// у которых наш узел стоит в цепочке.
function stepPassive(next) {
  ctlGet('/connections', function (body, e) {
    if (e || !body) { say('пассив: /connections не ответил (' + (e || 'пусто') + ')'); next(); return; }
    var d = null;
    try { d = JSON.parse(body); } catch (e2) { say('пассив: ответ не разобран'); next(); return; }
    var list = (d && (d.connections || d.Connections)) || [];
    for (var i = 0; i < list.length; i++) {
      var rec = list[i];
      if (!rec) continue;
      var dn = rec.download;
      var bps = (dn && typeof dn === 'object' && typeof dn.max === 'number') ? dn.max : 0;
      if (!(bps > 0)) continue;
      var ch = rec.chains || rec.chain || [];
      for (var c = 0; c < ch.length; c++) {
        var b = baseName(ch[c]);
        if (!CORE[b]) continue;               // не наш узел; обходных в CORE нет
        var mb = Math.round(bps * 8 / 1e6);
        if (mb > (PASS[b] || 0)) PASS[b] = mb;
      }
    }
    var names = [];
    for (var k in PASS) names.push(k);
    say('пассив: соединений ' + list.length + ', узлов со скоростью ' + names.length);
    next();
  });
}

// ── Ф3. САМОПРОВЕРКА ПИНОВКИ ─────────────────────────────────────────
// Заголовок X-Stash-Selected-Proxy документирован, но в проекте НИ РАЗУ не
// подтверждён замером: ST1 доходила до этого шага только при заданном
// аргументе node, а он не задавался. Пока не подтверждён — активная фаза не
// запускается: замер «через узел», который на самом деле идёт мимо узла,
// хуже отсутствия замера, потому что его не отличить от настоящего.
//
// Проверка: адрес выхода через узел A, через узел B и без заголовка.
//   A != B                       -> заголовок работает;
//   A == B == без заголовка      -> заголовок игнорируется;
//   A == B != без заголовка      -> вывод неоднозначен (у двух узлов может
//                                   совпасть выходной адрес).
// ДВА ПОДТВЕРЖДЕНИЯ ПОДРЯД, а не одно: разойтись адреса могут и случайно —
// например, если между запросами fallback сменил выбранный узел. Вердикт
// «работает» записывается только на второй удачной проверке, и каждая
// берёт свою пару узлов.
function ipThrough(full, cb) {
  var sec = capSec(IP_SEC);
  var o = full ? pinned(full, IP_URL, sec) : { url: IP_URL, timeout: sec };
  var done = false;
  function once(v) { if (done) return; done = true; cb(v); }
  if (!sec) { once(null); return; }
  try {
    G.$httpClient.get(o, function (e, r, body) {
      if (e || !body) { once(null); return; }
      var ip = null;
      try { var j = JSON.parse(body); ip = j && j.ip; } catch (e2) { ip = String(body).replace(/\s+/g, ''); }
      once(ip || null);
    });
  } catch (e3) { once(null); }
}

function stepPin(next) {
  var st = readJSON(K_PIN, null);
  if (st && st.ok === true && (Date.now() - (st.ts || 0)) < PIN_TTL) {
    PIN = st; say('пиновка: подтверждена ранее'); next(); return;
  }
  if (st && st.ok === false && st.firm && (Date.now() - (st.ts || 0)) < PIN_TTL) {
    PIN = st; say('пиновка: не работает (' + st.why + '), проверка отложена'); next(); return;
  }
  if (!NOW_OK) { PIN = { ok: false, why: 'пул смотрит на обходной узел, проверка отложена' }; say(PIN.why); next(); return; }
  if (POOL.length < 2) { PIN = { ok: false, why: 'узлов меньше двух' }; next(); return; }

  // Пара берётся с концов списка: он отсортирован по баллу, значит края —
  // как правило, разные страны, и совпадение выходного адреса менее
  // вероятно, чем у соседей. На повторной проверке пара смещается.
  var streak = (st && st.streak) || 0;
  var ai = streak % Math.max(1, POOL.length - 1);
  var a = POOL[ai].full;
  var b = POOL[POOL.length - 1].full;
  if (a === b) b = POOL[0].full;

  ipThrough(null, function (ip0) {
    ipThrough(a, function (ipa) {
      ipThrough(b, function (ipb) {
        var res;
        if (!ipa || !ipb) res = { ok: false, why: 'запрос через узел не ответил', firm: false, streak: 0 };
        else if (ipa !== ipb) {
          streak = streak + 1;
          res = (streak >= PIN_STREAK)
            ? { ok: true, why: 'адреса разошлись дважды подряд', firm: true, streak: streak }
            : { ok: false, why: 'адреса разошлись, нужно второе подтверждение', firm: false, streak: streak };
        } else if (ip0 && ipa === ip0) {
          res = { ok: false, why: 'заголовок игнорируется: адрес тот же, что без него', firm: true, streak: 0 };
        } else {
          res = { ok: false, why: 'адреса совпали, вывод неоднозначен', firm: false, streak: 0 };
        }
        res.ts = Date.now();
        PIN = res;
        writeJSON(K_PIN, res);
        say('пиновка: ' + (res.ok ? 'работает' : 'нет') + ' — ' + res.why);
        next();
      });
    });
  });
}

// ── Ф4. АКТИВНЫЙ ЗАМЕР ВЫБОРКИ ───────────────────────────────────────
// Кандидат — живой узел, у которого активного замера нет или он просрочен.
// Ротации по индексу нет и не нужно: измеренный узел на сутки перестаёт быть
// кандидатом, и следующий прогон сам берёт следующих. Порядок POOL — это
// порядок композитного балла, значит первыми перемеряется верх списка.
// ПАССИВ КАНДИДАТУРУ НЕ СНИМАЕТ: срок считается по ats, времени активного
// замера, а не по ts, который поднимает и пассив.
function isDue(base) {
  var e = CACHE[base];
  if (!e || !(e.down > 0)) return true;
  return (Date.now() - (e.ats || 0)) > CACHE_MS;
}

function pickActive() {
  var out = [];
  for (var i = 0; i < POOL.length && out.length < ACTIVE_N; i++) {
    var it = POOL[i];
    if (!CORE[it.base].alive) continue;
    if (!isDue(it.base)) continue;
    out.push(it);
  }
  return out;
}

function pingSeries(full, n, acc, cb) {
  if (n <= 0) { cb(acc); return; }
  // За бюджетом серия обрывается: недобранные пробы — не отказ узла, а
  // нехватка времени, и measureOne сам отбросит серию короче двух проб.
  var sec = capSec(PING_SEC);
  if (!sec) { cb(acc); return; }
  var t0 = Date.now();
  var done = false;
  function once(okFlag) {
    if (done) return; done = true;
    if (okFlag) acc.push(Date.now() - t0);
    pingSeries(full, n - 1, acc, cb);
  }
  try {
    G.$httpClient.get(pinned(full, PING_URL + '?t=' + Date.now() + Math.random(), sec),
      function (e) { once(!e); });
  } catch (e2) { once(false); }
}

// Закачка и задержка ПОД НАГРУЗКОЙ. Пробы разносятся на BL_GAP номинальных
// миллисекунд; у Stash фоновый setTimeout растягивается (ST5), поэтому
// отложенные пробы могут лечь уже за окном закачки — и тогда bl окажется
// мягче, чем в Loon. Таймеры снимаются, как только закачка закончилась:
// иначе пробы продолжали бы уходить после $done, пинуясь на узел, замер
// которого уже закрыт.
function download(full, cb) {
  var loaded = [], timers = [], done = false;
  function probe() {
    var sec = capSec(PING_SEC);
    if (done || !sec) return;          // за бюджетом или после закачки — не нужна
    var p0 = Date.now();
    try {
      G.$httpClient.get(pinned(full, PING_URL + '?t=L' + Date.now() + Math.random(), sec),
        function (e) { if (!e && !done) loaded.push(Date.now() - p0); });
    } catch (e2) {}
  }
  function once(v) {
    if (done) return; done = true;
    for (var t = 0; t < timers.length; t++) { try { clearTimeout(timers[t]); } catch (e) {} }
    cb(v, loaded);
  }
  // Закачка, подрезанная бюджетом, может не успеть и вернуть отказ: узел
  // останется без замера до следующего прогона. Это честнее, чем тянуть
  // прогон за сторожа.
  var dsec = capSec(DOWN_SEC);
  if (!dsec) { once(null); return; }
  probe();
  for (var k = 1; k < BL_SAMPLES; k++) timers.push(setTimeout(probe, k * BL_GAP));
  var s0 = Date.now();
  try {
    G.$httpClient.get(pinned(full, DOWN_HOST + '?bytes=' + DOWN_BYTES + '&t=' + Date.now(), dsec),
      function (e, r) {
        if (e || !r || r.status !== 200) { once(null); return; }
        var sec = (Date.now() - s0) / 1000;
        once(sec > 0 ? Math.round((DOWN_BYTES * 8 / 1e6) / sec) : 0);
      });
  } catch (e3) { once(null); }
}

function measureOne(it, cb) {
  pingSeries(it.full, RTT_SAMPLES, [], function (samples) {
    if (samples.length < 2) { cb(null); return; }   // узел не отвечает — не замер
    var rtt = minOf(samples);
    download(it.full, function (down, loaded) {
      if (!(down > 0)) { cb(null); return; }
      var lm = median(loaded);
      cb({
        down: down,
        rtt: rtt,
        med: median(samples),
        jit: trimRange(samples),
        // bl — ПРИРОСТ задержки под нагрузкой относительно ненагруженной,
        // как в Loon. Абсолютное значение на шкале FLOOR_BL 20 / VOICE_BL 50
        // означало бы, что для звонков не годится ни один узел.
        bl: (lm == null) ? null : Math.max(0, lm - rtt),
      });
    });
  });
}

function stepActive(next) {
  if (OPTS.indexOf('nospeed') >= 0) { say('актив: выключен опцией nospeed'); next(); return; }
  if (!PIN || !PIN.ok) { say('актив: пропущен, пиновка не подтверждена'); next(); return; }
  if (!NOW_OK) { say('актив: пропущен, пул смотрит на обходной узел (правило 1)'); next(); return; }
  var list = pickActive();
  if (!list.length) { say('актив: мерить нечего, скорость у всех свежая'); next(); return; }
  var i = 0;
  function step() {
    if (i >= list.length || left() < NODE_COST_MS) {
      say('актив: ' + ACT.ok + ' из ' + ACT.tried + ' (кандидатов ' + list.length + ')');
      next(); return;
    }
    var it = list[i++];
    ACT.tried++;
    measureOne(it, function (res) {
      if (res) {
        ACT.ok++;
        var e = CACHE[it.base] || (CACHE[it.base] = {});
        e.down = res.down; e.rtt = res.rtt; e.med = res.med; e.jit = res.jit;
        if (res.bl != null) e.bl = res.bl;
        e.ts = Date.now();
        e.ats = e.ts;                 // отметка ИМЕННО активного замера
        // Кэш пишется после каждого узла: сторож, сработавший не вовремя,
        // не должен отменять уже оплаченную трафиком работу.
        writeJSON(CKEY, CACHE);
      }
      step();
    });
  }
  step();
}

// ── Ф5. СЛИЯНИЕ И ОТПРАВКА ───────────────────────────────────────────
function merge() {
  var pruned = 0, inPool = {};
  for (var i = 0; i < POOL.length; i++) inPool[POOL[i].base] = 1;
  for (var old in CACHE) {
    if (!CACHE.hasOwnProperty(old)) continue;
    if (!inPool[old]) { delete CACHE[old]; pruned++; }
  }
  for (var j = 0; j < POOL.length; j++) {
    var b = POOL[j].base;
    var cs = CORE[b];
    var e = CACHE[b];
    // Живость — по ядру, а не по нашему замеру: неудача активной пробы может
    // означать сбой пиновки, а не смерть узла. Запись заводится для КАЖДОГО
    // узла пула (v0.2.2): ей нужно окно потерь lw, иначе первые провалы
    // живого прежде узла было бы не с чем сложить. Запись без down наружу
    // не уходит (buildArr) и кандидатуру на замер не снимает (isDue).
    if (!e) e = CACHE[b] = {};
    if (cs.alive) e.fails = 0; else e.fails = (e.fails || 0) + 1;
    // «Жив» без delay — ядро этот узел ещё не проверяло (туннель только
    // поднят): это не удача, а незнание, и в окно оно не пишется.
    var lw = String(e.lw || '').replace(/[^01]/g, '');
    if (!cs.alive || cs.med > 0) e.lw = (lw + (cs.alive ? '0' : '1')).slice(-LOSS_N);
    else if (lw) e.lw = lw;
    // Пассив только поднимает: узел выдал больше, чем мы намеряли, — значит
    // наш замер занижен. Опустить он не может: низкий пик обычно говорит о
    // том, что приложение больше и не просило. Отметку ats НЕ трогает,
    // поэтому очередной активный замер не отменяется.
    var p = PASS[b];
    if (p > 0 && e.down > 0 && p > e.down) { e.down = p; e.ts = Date.now(); }
  }
  writeJSON(CKEY, CACHE);
  return pruned;
}

// ── ОТЧЁТ: ДОЛЯ ПОТЕРЬ И delay ЯДРА ПРОТИВ rtt (v0.2.2) ───────────────
// Обе сводки — чтение CORE (ответ /proxies) и CACHE после merge(). Сети
// они не касаются; в выгрузку /speed не попадают (контракт не тронут —
// отправлять ли долю в Worker, решается отдельной задачей).
function lossStat() {
  var rows = [], few = 0;
  for (var i = 0; i < POOL.length; i++) {
    var b = POOL[i].base, e = CACHE[b];
    var w = (e && e.lw) || '';
    if (w.length < LOSS_MIN) { few++; continue; }
    var f = w.replace(/0/g, '').length;
    rows.push({ b: b, n: w.length, f: f });
  }
  var bad = [];
  for (var j = 0; j < rows.length; j++) if (rows[j].f > 0) bad.push(rows[j]);
  bad.sort(function (x, y) { return (y.f / y.n - x.f / x.n) || (y.f - x.f); });
  var s;
  if (!rows.length) s = 'потери ядра: у всех ' + few + ' узлов меньше ' + LOSS_MIN + ' попыток, доля не выводится';
  else {
    var top = [];
    for (var k = 0; k < bad.length && k < 3; k++) {
      top.push(bad[k].b + ' ' + bad[k].f + '/' + bad[k].n + ' (' + Math.round(bad[k].f * 100 / bad[k].n) + '%)');
    }
    s = 'потери ядра (окно ' + LOSS_N + '): узлов с долей ' + rows.length + ', с потерями ' + bad.length +
      (top.length ? '; хуже всех: ' + top.join(', ') : '') +
      (few ? '; мало попыток (<' + LOSS_MIN + '): ' + few : '');
  }
  return { line: s, bad: bad.length, rows: rows.length };
}

// delay ЯДРА ПРОТИВ НАШЕГО rtt. Пара складывается у узла, который ядро
// сейчас считает живым, с delay > 0, и у которого в кэше есть rtt активного
// замера не старше CACHE_MS. Расхождение — delay − rtt, мс; отношение —
// delay / rtt. Обе сводки — МЕДИАНЫ по узлам: один узел с выбросом не
// решает. Что заложено в сравнение и почему число не вывод само по себе:
//   * delay ядра — ОДНА проверка (у Stash 3.4.1 истории нет, ST9), rtt —
//     МИНИМУМ из RTT_SAMPLES проб; отношение больше единицы ожидаемо уже
//     по методу, и смотреть надо на его устойчивость, а не на величину;
//   * первый замер у проекта систематически смещён, одиночное измерение —
//     не вывод: поэтому порог CMP_MIN узлов, а сводка каждого прогона
//     пишется в журнал (поле dv), чтобы судить по ряду прогонов;
//   * rtt бывает до суток старым, delay — текущий: разница включает и
//     дрейф узла за это время.
function delayVsRtt() {
  var diffs = [], ratios = [], now = Date.now();
  for (var i = 0; i < POOL.length; i++) {
    var b = POOL[i].base, cs = CORE[b], e = CACHE[b];
    if (!cs || !cs.alive || !(cs.med > 0)) continue;
    if (!e || !(e.rtt > 0) || !((now - (e.ats || 0)) <= CACHE_MS)) continue;
    diffs.push(cs.med - e.rtt);
    ratios.push(Math.round(cs.med * 100 / e.rtt));   // сотые: median округляет до целых
  }
  var n = diffs.length;
  if (n < CMP_MIN) {
    return { n: n, line: 'delay ядра против rtt: данных мало — пар ' + n + ', нужно не меньше ' + CMP_MIN + '; число не выводится' };
  }
  var d = median(diffs), r = median(ratios) / 100;
  return { n: n, d: d, r: r,
    line: 'delay ядра против rtt: узлов ' + n + ', медиана расхождения ' + (d > 0 ? '+' : '') + d +
      ' мс, отношение ×' + r.toFixed(2) + ' (delay — одна проверка ядра, rtt — минимум ' + RTT_SAMPLES + ' проб)' };
}

function buildArr(key) {
  var c = readJSON(key, {}), out = [];
  for (var nm in c) {
    if (!c.hasOwnProperty(nm) || !looksLikeNode(nm)) continue;
    var e = c[nm];
    if ((e.fails || 0) >= MAX_FAILS) {
      var d = { name: nm, dead: true };
      if (e.ts) d.ts = e.ts;
      out.push(d); continue;
    }
    // Узел без ПОЛНОГО активного замера не отправляется: контракт /speed не
    // умеет сказать «неизвестно», а нулевые rtt и jit — это максимальный
    // балл (scoreOf). См. шапку файла.
    if (!(e.down > 0) || !(e.rtt > 0)) continue;
    var it = { name: nm, down: e.down, rtt: e.rtt, jit: e.jit || 0 };
    if (e.med != null) it.med = e.med;
    if (e.bl != null) it.bl = e.bl;
    if (e.ts) it.ts = e.ts;
    if (e.ats) it.tsp = e.ats;
    out.push(it);
  }
  return out;
}

function stepSend(done) {
  var wifi = buildArr(K_W), cell = buildArr(K_C);
  if (!wifi.length && !cell.length) { say('отправлять нечего'); done(); return; }
  try {
    G.$httpClient.post({
      url: ORIGIN + '/speed',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: KEY, nonce: NONCE, wifi: wifi, cell: cell }),
      timeout: POST_SEC,
    }, function (e, r) {
      if (e) say('POST ошибка ' + e);
      else say('отправлено wifi=' + wifi.length + ' cell=' + cell.length + ', статус ' + (r && r.status));
      done();
    });
  } catch (e2) { say('POST не запустился: ' + e2); done(); }
}

// ── ЗАПУСК ───────────────────────────────────────────────────────────
var FINISHED = false;
var GUARD = null;        // сторож; снимается в finish, иначе таймер живёт
                         // дальше и снимает блокировку чужого прогона

function finish() {
  if (FINISHED) return;
  FINISHED = true;
  try { clearTimeout(GUARD); } catch (e) {}
  writeRaw(K_LOCK, '');
  // ОТЧЁТ ПРОГОНА. Первая строка — вердикт журнала выбора: уход RH-Главный
  // или RH-RU с DIRECT должен быть виден сразу, а не среди строк замера.
  // Построчные записи say() выше уже ушли в журнал сценариев по ходу дела —
  // на случай, если прогон оборвёт сам клиент и до сюда он не дойдёт.
  var head = SEL_HEAD || 'выбор групп не прочитан: /proxies не получен';
  try { console.log('RH-Collect отчёт:\n' + [head].concat(LOG).join('\n')); } catch (e1) {}
  var log = readJSON(K_LOG, []);
  var sel;
  if (SEL) { sel = {}; for (var g in SEL) sel[g] = SEL[g][0] || ''; }
  log.push({ sel: head, t: new Date().toISOString(), net: NET, pool: POOL.length, a: ACT.ok, ms: Date.now() - T0, g: sel, lz: (LZ == null) ? undefined : LZ, dv: DV || undefined, x: FATAL || undefined });
  while (log.length > LOG_MAX) log.shift();
  writeJSON(K_LOG, log);
  // Молчание — худший исход: прогон за прогоном упирается в FATAL, а увидеть
  // это можно только вручную в журнале сценариев. Уведомление шлётся ТОЛЬКО
  // на отказ, чтобы не будить телефон каждые двадцать минут.
  if (FATAL) { try { $notification.post('RouteHub — сборщик', 'прогон не состоялся', FATAL); } catch (e2) {} }
  try { G.$done(); } catch (e3) {}
}

function main() {
  say(VERSION);

  var lockTs = parseInt(readRaw(K_LOCK) || '0', 10) || 0;
  if (lockTs && (Date.now() - lockTs) < LOCK_MS) {
    // Выход по чужой блокировке ОБЯЗАН снять сторожа и не трогать замок:
    // иначе через полминуты сторож этого прогона снимет замок работающего.
    say('занято, выход');
    FINISHED = true;
    try { clearTimeout(GUARD); } catch (e) {}
    try { G.$done(); } catch (e2) {}
    return;
  }
  writeRaw(K_LOCK, String(Date.now()));

  var arg = (typeof G.$argument === 'string') ? G.$argument : '';
  var p = arg.split('|');
  KEY = p[0] || ''; ORIGIN = (p[1] || '').replace(/\/+$/, ''); OPTS = p[2] || '';
  if (!/^k\d+$/.test(KEY) || !/^https?:\/\//.test(ORIGIN)) {
    // Сам аргумент в журнал НЕ пишется: в нём может быть токен ссылки, а
    // журнал — это то, что копируется в переписку.
    FATAL = 'битый argument: частей ' + p.length + ', ключ ' + (/^k\d+$/.test(KEY) ? 'годный' : 'негодный') +
      ', origin ' + (/^https?:\/\//.test(ORIGIN) ? 'годный' : 'негодный');
    say(FATAL); finish(); return;
  }

  try {
    CTRL = (G.$environment && G.$environment['controller-url']) || CTRL;
    AUTH = (G.$environment && G.$environment['controller-authorization']) || '';
  } catch (e) { say('нет $environment'); }
  CTRL = String(CTRL).replace(/\/+$/, '');

  // NONCE. Потеря записи здесь дороже всего: следующий прогон сгенерирует
  // другой, Worker переведёт ключ в conflict и будет отвечать 409, пока
  // Диана не отвяжет ключ руками. Поэтому неудачная запись — повод НЕ
  // отправлять выгрузку вовсе, а не повод продолжать наугад.
  NONCE = readRaw(K_NONCE);
  var nonceOk = true;
  if (!NONCE) {
    NONCE = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    nonceOk = writeRaw(K_NONCE, NONCE) && readRaw(K_NONCE) === NONCE;
  }

  stepInventory(function () {
    if (FATAL) { say(FATAL); finish(); return; }
    CKEY = (NET === 'wifi') ? K_W : K_C;
    CACHE = readJSON(CKEY, {});
    stepPassive(function () {
      stepPin(function () {
        stepActive(function () {
          var pruned = merge();
          if (pruned) say('из кэша убрано ' + pruned + ' узлов, которых нет в пуле');
          var ls = lossStat(), dv = delayVsRtt();
          say(ls.line); say(dv.line);
          LZ = ls.rows ? ls.bad : null;
          DV = (dv.n >= CMP_MIN) ? { n: dv.n, d: dv.d, r: dv.r } : { n: dv.n };
          if (!nonceOk) { FATAL = 'nonce не сохранился, выгрузка не отправлена'; say(FATAL); finish(); return; }
          stepSend(finish);
        });
      });
    });
  });
}

// Сторож. Номинал БОЛЬШЕ худшего честного пути даже без растяжения таймеров
// (расчёт у GUARD_MS), потому что его дело — поймать зависшую цепочку, а не
// обрезать нормальный прогон. Работу он не отменяет: кэш пишется после
// каждого узла.
GUARD = setTimeout(function () {
  if (!FINISHED) { say('сторож: цепочка не завершилась'); finish(); }
}, GUARD_MS);

main();
// конец файла — хвостовой страж (вывод 49)
