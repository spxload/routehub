// =============================================================
// routehub-worker.js — Cloudflare Worker (Этап E, личные подписки)
// VERSION: worker v1.9.1 (2026-08-06) — СЕССИЯ АДМИН-ПАНЕЛИ:
//   ПРИЧИНА: ADMIN_KEY жил только в памяти вкладки, поэтому при каждой
//   перезагрузке страницы его приходилось вводить заново.
//   РЕШЕНИЕ: POST /admin/login принимает ключ ОДИН раз и выдаёт cookie rh_adm
//   вида <exp>.<подпись>, где подпись = HMAC-SHA256 по строке 'rh-admin-v1|<exp>'
//   с ключом ADMIN_KEY. Состояние на сервере НЕ хранится — в D1 ничего не
//   пишется, расхода квоты нет. Атрибуты cookie: HttpOnly (скриптам страницы
//   значение недоступно, в отличие от localStorage), Secure, SameSite=Strict
//   (закрывает CSRF), Path=/admin (на эндпоинты устройств cookie не уходит),
//   Max-Age = 30 суток.
//   Отзыв: POST /admin/logout гасит cookie в текущем браузере; смена секрета
//   ADMIN_KEY в Cloudflare обнуляет ВСЕ выданные сессии разом, поскольку он же
//   служит ключом подписи.
//   adminGate стал async и проверяет в порядке: X-Admin-Key -> ?key= -> cookie.
//   Прежние способы входа сохранены: ручной заход по ?key= не сломан.
//   Неверный ключ в /admin/login отвечает 403 с задержкой ~300 мс (грубая
//   помеха перебору; счётчики попыток не заводились — они требовали бы записей
//   в D1 на каждый запрос).
// VERSION: worker v1.9.0 (2026-08-05) — БЛОК 1 (уборка после D1) + БЛОК 3 (админ-панель):
//   * FRESH_MS 10 мин -> 60 мин. Loon дёргает /config раз в 15-20 мин, поэтому при
//     пороге 10 мин кэш почти всегда протухший и Worker СИНХРОННО ждал Lastdep.
//     Верхняя граница свежести и так задана cron'ом (раз в 2 ч) — он обновляет
//     кэш принудительно, независимо от FRESH_MS.
//   * handleSpeed отсекает МЁРТВЫЕ МЕТРИКИ: ключи, которых нет в текущей подписке
//     (в metrics:k1 накопилось 87 записей при 72 узлах). Критерий — фактический
//     состав sub_cache, без порогов по возрасту. ПРЕДОХРАНИТЕЛЬ: если подписка
//     недоступна/пуста/не распарсилась — чистка пропускается целиком, метрики
//     пишутся как есть (иначе один сбой Lastdep обнулил бы накопленное).
//   * УДАЛЕНЫ миграционные /admin/backup, /admin/migrate, /admin/verify и функция
//     kvDumpAll. Биндинг RH_KV убран из wrangler.toml — в коде обращений к KV
//     больше нет. Сам namespace routehub-kv в аккаунте ОСТАВЛЕН (удаляет Диана);
//     путь отката — возврат предыдущей версии файлов.
//   * TOKEN_REQUIRED ПЕРЕЕХАЛ ИЗ КОНСТАНТЫ В D1 (ключ settings). Включение фазы 2
//     стало обратимым тумблером админ-панели и больше не требует деплоя. Чтение
//     settings происходит ТОЛЬКО когда токен в запросе не передан, то есть по
//     новой ссылке лишних обращений к D1 нет вовсе.
//   * АДМИН-ПАНЕЛЬ: GET /admin отдаёт routehub-admin.html. Файл лежит в репозитории
//     отдельно и ВБИРАЕТСЯ В БАНДЛ при сборке (import + [[rules]] type=Text в
//     wrangler.toml) — панель отдаётся мгновенно, без обращения к raw GitHub и без
//     его 5-минутного кэша, браузеру нужен один origin.
//     Новое: GET /admin/state, POST /admin/device, /admin/settings, /admin/action,
//     /admin/mylist. adminGate теперь принимает ключ из заголовка X-Admin-Key
//     (в URL ключ больше не обязателен; ?key= оставлен для старых ссылок).
// VERSION: worker v1.8.2 (2026-08-03) — ТОКЕН ДОСТУПА (ЗАКРЫТИЕ ПОДПИСКИ):
//   ПРИЧИНА: /nodes был защищён только значением kN (k1/k2/k3 подбираются за
//   минуту), а полная ссылка лежала в ПУБЛИЧНОМ репозитории строкой Lastdep.
//   Любой, кто нашёл репо, забирал оплаченную подписку целиком.
//   РЕШЕНИЕ: у каждого устройства свой token (32 симв., crypto.getRandomValues),
//   передаётся ПРЕФИКСОМ ПУТИ: /t/<token>/nodes?key=kN.
//   Почему префиксом, а не полем аргумента: все 5 скриптов на устройстве строят
//   запрос как ORIGIN + '/путь'. Достаточно подставить им ORIGIN со встроенным
//   токеном — и скрипты править НЕ НУЖНО вообще (проверено по исходникам
//   speedtest/netwatch/rkn/dash/dashcache). Меньше правок = меньше риск.
//   Дополнительно принимается ?token=<token> — для ручных заходов из браузера.
//   ФАЗА 1 (сейчас): TOKEN_REQUIRED=false — запрос БЕЗ токена ещё работает,
//   чтобы не потерять доступ при переходе. Токены уже выдаются и проверяются:
//   если токен передан и НЕ совпал — отказ немедленно.
//   ФАЗА 2 (после подтверждения Дианы): TOKEN_REQUIRED=true — запрос без токена
//   получает 403 с ТЕКСТОВОЙ ПОДСКАЗКОЙ, где взять новую ссылку.
//   GET /admin/keys?key=<ADMIN_KEY> — готовые ссылки по всем устройствам.
// VERSION: worker v1.8.1 (2026-08-03) — РЕГИОНАЛЬНЫЙ ПОРЯДОК AI-ТИЕРОВ:
//   buildAiTiers сортировал страны ТОЛЬКО по числу узлов -> Турция (4 узла)
//   попадала выше Латвии и наравне с NL/EE, а США — ниже Турции. Для ИИ-сервисов
//   это плохо: не-европейские выходы чаще ловят геоблок/иную выдачу.
//   ТЕПЕРЬ ключ сортировки: (регион, число узлов, скорость, близость).
//   Регионы: 0 Европа -> 1 Америка -> 2 Россия/СНГ -> 3 прочие (Турция, ОАЭ,
//   Индия, Азия, Африка). DE по-прежнему принудительно первой.
//   ИЗ AI ИСКЛЮЧЁН ВЕСЬ РЕГИОН СНГ (regionOf==2): RU, BY, KZ, AM, GE, AZ, UZ,
//   KG, TJ. Раньше жёстко исключались только RU и BY, из-за чего Казахстан
//   (3 узла) попадал в AI-тиеры. Для ИИ-сервисов у СНГ та же проблема, что
//   у РФ: иная выдача и риск блокировок. Исключение сквозное — СНГ убран и из
//   AI-тиеров, и из запасного фильтра AIrest (иначе узлы вернулись бы туда).
//   На обычный трафик (RH-АВТО) это НЕ влияет — там СНГ третьим тиром.
//   Синхронно с routehub.conf C-draft-36 (там же региональный каскад RH-АВТО).
// VERSION: worker v1.8.0 (2026-08-03) — ХРАНИЛИЩЕ ПЕРЕВЕДЕНО НА D1:
//   ПРИЧИНА: KV free-план — 1000 записей/сутки НА АККАУНТ. При двух устройствах
//   расход был 760-800/сутки (замер Дианы), третье устройство пробивало лимит.
//   Интервалы cron и состав записываемых данных НЕ меняли принципиально —
//   вместо этого сменили хранилище: D1 free — 100 000 строк/сутки (в 100 раз).
//   * kvGetJSON/kvPutJSON теперь работают с D1 (binding RH_DB, база routehub-db,
//     таблица kv: key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER).
//     Модель данных ПРЕЖНЯЯ: один ключ = один JSON-блок (metrics:<kN> — все узлы
//     одним объектом). Один kvPutJSON = одна записанная строка, как один put в KV.
//     Все вызывающие места (handleConfig/handleNodes/handleSpeed/handleRkn/
//     handleRule/handleDashboard/getSub/loadRegistry) НЕ изменены — они и раньше
//     обращались только к обёрткам.
//   * kvPutManyJSON() — парные записи одним RH_DB.batch() (транзакция):
//     handleSpeed (metrics+devices), handleRkn при смене режима (rkn+rkn_hist).
//     Квоту НЕ экономит (каждая строка считается отдельно) — даёт атомарность
//     и меньше сетевых обращений; раньше два независимых await могли разъехаться.
//   * handleConfig: реестр devices пишется ОДИН раз за запрос. Раньше при смене
//     C-draft писалось дважды подряд (last_config_ts, затем conf_ver).
//   ДАННЫЕ перенесены из KV разово через /admin/migrate (v1.7.6) и сверены:
//   9 ключей, привязки nonce и флаги устройств сохранены.
//   KV-биндинг RH_KV ОСТАВЛЕН в wrangler.toml как путь отката и для работы
//   /admin/backup, /admin/migrate, /admin/verify. Удаление namespace — Диана,
//   после нескольких суток стабильной работы на D1.
// VERSION: worker v1.7.6 (2026-08-03) — ШАГ 1 МИГРАЦИИ НА D1 (данные ещё в KV):
//   * Добавлен биндинг RH_DB (D1, база routehub-db) в wrangler.toml.
//   * GET /admin/migrate?key=<ADMIN_KEY> — РАЗОВЫЙ перенос всех ключей KV -> D1.
//   * GET /admin/verify?key=<ADMIN_KEY> — сверка KV и D1. Только чтение.
//   Порядок критичен: если переключить обёртки ДО переноса, D1 будет пуст,
//   loadRegistry() создаст devices заново и POST /speed перепривяжет nonce.
// VERSION: worker v1.7.5 (2026-08-03) — ВРЕМЕННЫЙ ДИАГНОСТИЧЕСКИЙ ЭНДПОИНТ:
//   GET /admin/backup?key=<ADMIN_KEY> — полный дамп всех ключей KV для бэкапа
//   перед миграцией. Гейт — секрет ADMIN_KEY (тип Secret, НЕ Text). Без него
//   всегда 403. ВАЖНО: sub_cache содержит сырые vless:// URI — результат не
//   публиковать и не коммитить в репозиторий (публичный).
// VERSION: worker v1.7.4 (2026-06-18) — ПАРАМЕТРЫ ПОДПИСКИ ИЗ КОНФИГА:
//   handleConfig больше НЕ срезает хвост параметров строки Lastdep. Раньше
//   подставлялось жёстко '?key=kN,udp=true,enabled=true' — все параметры из
//   конфига (block-quic, fast-open, vmess-aead, skip-cert-verify, flexible-sni)
//   терялись, и Loon ставил их по умолчанию (block-quic=true!). Теперь Worker
//   берёт хвост параметров из строки [Remote Proxy] конфига и сохраняет его,
//   меняя только URL на свой origin/nodes?key=kN.
// VERSION: worker v1.7.3 (2026-06-13) — иконка приложения обновлена.
// VERSION: worker v1.7.2 (2026-06-12) — иконка приложения как SVG.
// VERSION: worker v1.7.1 (2026-06-12) — ДАШБОРД-ЭТАП: иконка приложения.
// VERSION: worker v1.7.0 (2026-06-12) — ДАШБОРД-ЭТАП, шаг 0:
//   * CORS: Access-Control-Allow-Origin:* на JSON-ответах + обработка OPTIONS.
//   * Личный список RH-RU: GET /mylist, POST /addrule, POST /delrule.
//   * История режима РКН: кольцевой буфер rkn_hist:<kN> (последние 50).
// VERSION: worker v1.6.0 (2026-06-12) — AI-группы: interval=120, max-timeout=2000.
// VERSION: worker v1.5.0 (2026-06-11) — POST /rkn: приём режима сети.
// VERSION: worker v1.4.1 (2026-06-11) — argument для RH-Dash/RH-DashCache.
// VERSION: worker v1.4.0 (2026-06-11) — ДАШБОРД: GET /dashboard?key=kN (JSON).
// VERSION: worker v1.3.0 (2026-06-11) — ОБХОД КЭША КОНФИГА (no-store + ?t=now).
// VERSION: worker v1.2.0 (2026-06-11) — ЗВОНКИ: маркер ☎ (voiceOk) в метке узлов.
// VERSION: worker v1.1.0 (2026-06-11) — ЧИСТКА: гист-сид удалён.
// VERSION: worker v1.0.1 — /refresh ходит к Lastdep напрямую.
// VERSION: worker v1.0.0 — МИГРАЦИЯ НА KV (историческое; с v1.8.0 хранилище — D1):
//   * Worker САМ качает подписку Lastdep: stale-while-revalidate, FRESH_MS 10 мин.
//   * Cron Trigger (раз в 2 ч) — фоновое обновление кэша.
//   * Балл: задержка = med (медиана проб), фолбэк rtt.
//
// ОДНА ССЫЛКА НА ВСЕХ — НЕВОЗМОЖНА без ?key: Loon не передаёт идентификатора
//   устройства. key=kN — идентификатор, token — секрет; привязка АВТОМАТИЧЕСКАЯ
//   (nonce при первом POST /speed), запасной свободный ключ создаётся сам.
//
// ВСЕ эндпоинты устройства доступны как /t/<token>/<путь> либо с ?token=<token>.
// GET  /config?key=kN  -> конфиг (AI-тиеры, script-path, argument с токеном).
// GET  /nodes?key=kN   -> оба набора (🛜+📱) + обход; base64; no-store.
// GET  /refresh?key=kN -> принудительно обновить подписку СЕЙЧАС.
// GET  /dashboard?key=kN -> JSON для дашборда.
// GET  /mylist?key=kN  -> личный список RH-RU для [Remote Rule].
// GET  /icon.svg /icon.png /apple-touch-icon.png -> SVG-иконка (без токена).
// GET  /status?key=kN  -> диагностика.
// POST /speed          -> метрики устройства (D1).
// POST /rkn            -> режим сети от routehub-rkn.
// POST /addrule /delrule -> {key, domain} личный список.
// GET  /whoami         -> детект сети/оператора по request.cf (без токена).
// GET  /admin          -> HTML админ-панели (ключ вводится внутри страницы).
// POST /admin/login    -> обмен ADMIN_KEY на сессионную cookie (30 суток).
// POST /admin/logout   -> погасить сессию в этом браузере.
// GET  /admin/keys     -> ссылки устройств с токенами (JSON).
// GET  /admin/state    -> сводка панели: настройки, подписка, устройства,
//                         хранилище, каскад регионов.
// POST /admin/device   -> флаги устройства, перевыпуск токена, отвязка.
// POST /admin/settings -> переключатель token_required (фаза 2 токенов).
// POST /admin/action   -> refresh_sub (обновить подписку сейчас).
// POST /admin/mylist   -> личный список RH-RU из панели.
// Все /admin/* — под ADMIN_KEY: заголовок X-Admin-Key, ?key=<ADMIN_KEY> либо
// сессионная cookie rh_adm, выданная /admin/login.
// env: RH_DB (D1 — ЕДИНСТВЕННОЕ ХРАНИЛИЩЕ),
//      SUBSCRIPTION_URL + SUB_HWID + ADMIN_KEY (секреты CF), CONFIG_URL.
// =============================================================

// HTML админ-панели. Отдельный файл репозитория, вбирается в бандл при сборке
// ([[rules]] type = "Text", globs = ["**/*.html"] в wrangler.toml). Поэтому
// панель отдаётся мгновенно, без обращения к raw GitHub и его кэша.
import ADMIN_HTML from './routehub-admin.html';

const METRIC_SEP = ' \u00B7 ';
const DEAD = '\u26D4';                 // ⛔
const ICON_WIFI = '\uD83D\uDEDC';      // 🛜
const ICON_CELL = '\uD83D\uDCF1';      // 📱
const NODATA = '\u2205';               // ∅
const BLK = ['\u2581', '\u2583', '\u2585', '\u2587', '\u2588']; // ▁▃▅▇█
const SUP_PLUS = '\u207A';             // ⁺
const SUP_DIG = ['\u2070', '\u00B9', '\u00B2', '\u00B3', '\u2074', '\u2075', '\u2076', '\u2077', '\u2078', '\u2079'];
const KEY_RE = /^k\d+$/;
// ФАЗА 2 миграции на токены. С v1.9.0 значение живёт в D1 (ключ settings) и
// переключается тумблером админ-панели — включение стало обратимым и не требует
// деплоя. Константа ниже — значение по умолчанию при отсутствии ключа settings.
const TOKEN_REQUIRED_DEFAULT = false;
const SETTINGS_KEY = 'settings';
const WORKER_VER = 'v1.9.1';
const TOKEN_LEN = 32;
const TOKEN_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TOKEN_RE = /^[A-Za-z0-9]{16,64}$/;
const PATH_TOKEN_RE = /^\/t\/([A-Za-z0-9]{16,64})(\/.*)?$/;
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/;
const FLAGS = ['cell_unlim', 'ewma', 'show_rtt', 'auto_refresh'];
const CELL_HINTS = ['mts', 'mobile telesystems', 'megafon', 'vimpelcom', 'beeline',
  'tele2', 't2 mobile', 'yota', 'mobile', 'cellular', 'wireless', 'lte', 'gsm'];

// v1.9.0: 60 мин вместо 10. Loon ходит за /config раз в 15-20 мин — при пороге
// 10 мин кэш почти всегда протухал и запрос СИНХРОННО ждал ответа Lastdep.
// Верхнюю границу свежести держит cron (раз в 2 ч, getSub(env, true)).
const FRESH_MS = 60 * 60 * 1000;
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
  '\uD83C\uDDEE\uD83C\uDDF9': 18, '\uD83C\uDDF7\uD83C\uDDF4': 19, [BY]: 20,
  '\uD83C\uDDF9\uD83C\uDDF7': 22, '\uD83C\uDDF7\uD83C\uDDFA': 23, '\uD83C\uDDF0\uD83C\uDDFF': 24,
  '\uD83C\uDDE6\uD83C\uDDF2': 25, '\uD83C\uDDE6\uD83C\uDDEA': 26, '\uD83C\uDDEE\uD83C\uDDF3': 27,
  '\uD83C\uDDF8\uD83C\uDDEC': 28, '\uD83C\uDDF9\uD83C\uDDED': 29, '\uD83C\uDDEF\uD83C\uDDF5': 30,
  '\uD83C\uDDF0\uD83C\uDDF7': 31, '\uD83C\uDDFA\uD83C\uDDF8': 32, '\uD83C\uDDE8\uD83C\uDDE6': 33,
  '\uD83C\uDDE7\uD83C\uDDF7': 34, '\uD83C\uDDE6\uD83C\uDDF7': 35, '\uD83C\uDDF3\uD83C\uDDEC': 36,
};
function proxOf(fl) { return (fl in PROX) ? PROX[fl] : 99; }

// РЕГИОНЫ (v1.8.1) — порядок предпочтения для ИИ и обычного трафика:
// 0 Европа, 1 Америка, 2 Россия/СНГ, 3 прочие (незнакомый флаг -> 3).
// Списки синхронны с региональными фильтрами routehub.conf (C-draft-36).
const REGION_EU = ['\uD83C\uDDE9\uD83C\uDDEA', '\uD83C\uDDF3\uD83C\uDDF1', '\uD83C\uDDEB\uD83C\uDDEE',
  '\uD83C\uDDF5\uD83C\uDDF1', '\uD83C\uDDEA\uD83C\uDDEA', '\uD83C\uDDF1\uD83C\uDDFB', '\uD83C\uDDF1\uD83C\uDDF9',
  '\uD83C\uDDF8\uD83C\uDDEA', '\uD83C\uDDF3\uD83C\uDDF4', '\uD83C\uDDE9\uD83C\uDDF0', '\uD83C\uDDEE\uD83C\uDDEA',
  '\uD83C\uDDEC\uD83C\uDDE7', '\uD83C\uDDEB\uD83C\uDDF7', '\uD83C\uDDEA\uD83C\uDDF8', '\uD83C\uDDEE\uD83C\uDDF9',
  '\uD83C\uDDE8\uD83C\uDDED', '\uD83C\uDDE6\uD83C\uDDF9', '\uD83C\uDDE7\uD83C\uDDEA', '\uD83C\uDDE8\uD83C\uDDFF',
  '\uD83C\uDDF7\uD83C\uDDF4', '\uD83C\uDDF7\uD83C\uDDF8', '\uD83C\uDDF5\uD83C\uDDF9', '\uD83C\uDDEC\uD83C\uDDF7',
  '\uD83C\uDDED\uD83C\uDDFA', '\uD83C\uDDF8\uD83C\uDDF0', '\uD83C\uDDF8\uD83C\uDDEE', '\uD83C\uDDED\uD83C\uDDF7',
  '\uD83C\uDDE7\uD83C\uDDEC', '\uD83C\uDDF1\uD83C\uDDFA', '\uD83C\uDDEE\uD83C\uDDF8', '\uD83C\uDDF2\uD83C\uDDE9',
  '\uD83C\uDDFA\uD83C\uDDE6'];
const REGION_AM = ['\uD83C\uDDFA\uD83C\uDDF8', '\uD83C\uDDE8\uD83C\uDDE6', '\uD83C\uDDE7\uD83C\uDDF7',
  '\uD83C\uDDE6\uD83C\uDDF7', '\uD83C\uDDF2\uD83C\uDDFD', '\uD83C\uDDE8\uD83C\uDDF1', '\uD83C\uDDE8\uD83C\uDDF4',
  '\uD83C\uDDF5\uD83C\uDDEA'];
const REGION_RU = ['\uD83C\uDDF7\uD83C\uDDFA', '\uD83C\uDDE7\uD83C\uDDFE', '\uD83C\uDDF0\uD83C\uDDFF',
  '\uD83C\uDDE6\uD83C\uDDF2', '\uD83C\uDDEC\uD83C\uDDEA', '\uD83C\uDDE6\uD83C\uDDFF', '\uD83C\uDDFA\uD83C\uDDFF',
  '\uD83C\uDDF0\uD83C\uDDEC', '\uD83C\uDDF9\uD83C\uDDEF'];
function regionOf(fl) {
  if (REGION_EU.indexOf(fl) >= 0) return 0;
  if (REGION_AM.indexOf(fl) >= 0) return 1;
  if (REGION_RU.indexOf(fl) >= 0) return 2;
  return 3;
}

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

const CORS = { 'Access-Control-Allow-Origin': '*' };
const RH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#05352C"/><stop offset="1" stop-color="#04221C"/></linearGradient><radialGradient id="hub" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#9FE1CB"/><stop offset="0.55" stop-color="#5DCAA5"/><stop offset="1" stop-color="#3FB389"/></radialGradient></defs><rect width="1024" height="1024" rx="228" fill="url(#bg)"/><g fill="none" stroke="#5DCAA5" stroke-width="34" stroke-linecap="round" opacity="0.9"><path d="M512 512 L246 246"/><path d="M512 512 L778 246"/><path d="M512 512 L214 540"/><path d="M512 512 L810 540"/><path d="M512 512 L330 802"/><path d="M512 512 L694 802"/></g><g fill="#7FE0C0"><circle cx="246" cy="246" r="46"/><circle cx="778" cy="246" r="46"/><circle cx="214" cy="540" r="46"/><circle cx="810" cy="540" r="46"/><circle cx="330" cy="802" r="46"/><circle cx="694" cy="802" r="46"/></g><circle cx="512" cy="512" r="118" fill="url(#hub)"/><circle cx="512" cy="512" r="118" fill="none" stroke="#04221C" stroke-width="10" opacity="0.35"/></svg>`;
function iconResp() {
  return new Response(RH_ICON_SVG, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' } });
}
function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
}

// ХРАНИЛИЩЕ — Cloudflare D1 (таблица kv: key/value/updated_at), эмуляция KV.
// Модель прежняя: один ключ = один JSON-блок (metrics:<kN> — ВСЕ узлы одним
// объектом, не строка на узел). Одна запись = одна строка -> расход как у KV,
// но лимит в 100 раз выше (100 000 строк/сутки против 1000 записей/сутки).
const KV_UPSERT = 'INSERT INTO kv(key,value,updated_at) VALUES(?,?,?) ' +
  'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at';
async function kvGetJSON(env, k) {
  const r = await env.RH_DB.prepare('SELECT value FROM kv WHERE key = ?').bind(k).first();
  if (!r || r.value == null) return null;
  try { return JSON.parse(r.value); } catch (e) { return null; }
}
async function kvPutJSON(env, k, o) {
  await env.RH_DB.prepare(KV_UPSERT).bind(k, JSON.stringify(o), Date.now()).run();
}
// Несколько записей одним обращением к D1 (транзакция: пройдут все или ни одной).
// На расход квоты НЕ влияет — каждая строка считается отдельно; выигрыш в
// задержке и атомарности (раньше два независимых await могли разъехаться).
async function kvPutManyJSON(env, pairs) {
  const stmt = env.RH_DB.prepare(KV_UPSERT);
  const now = Date.now();
  await env.RH_DB.batch(pairs.map(function (p) { return stmt.bind(p[0], JSON.stringify(p[1]), now); }));
}
async function loadMylist(env, key) { return (await kvGetJSON(env, 'mylist:' + key)) || []; }

// Настройки Worker'а (ключ settings в D1). Пока единственная — token_required.
// Читается ТОЛЬКО когда запрос пришёл без токена, поэтому по новым ссылкам
// дополнительных обращений к D1 не возникает.
async function loadSettings(env) {
  const s = await kvGetJSON(env, SETTINGS_KEY);
  return { token_required: (s && typeof s.token_required === 'boolean') ? s.token_required : TOKEN_REQUIRED_DEFAULT };
}
async function saveSettings(env, s) { await kvPutJSON(env, SETTINGS_KEY, s); }

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

// Извлечь хвост параметров Loon из строки [Remote Proxy] конфига.
// Строка вида: "Lastdep = <url>,p1=v1,p2=v2,...". URL запятых не содержит,
// поэтому всё ПОСЛЕ первой запятой — параметры подписки (block-quic, udp, ...).
function subParamsFromConf(conf) {
  const m = String(conf).match(/^Lastdep\s*=\s*(.*)$/m);
  if (!m) return ',udp=true,enabled=true';
  const rhs = m[1].trim();
  const ci = rhs.indexOf(',');
  if (ci < 0) return ',udp=true,enabled=true'; // параметров нет — запасной дефолт
  const params = rhs.slice(ci + 1).trim();      // всё после URL (без ведущей запятой)
  return params ? (',' + params) : ',udp=true,enabled=true';
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
  if (reg) {
    // Разовая доводка: у старых ключей токена нет — выдать и сохранить.
    if (ensureTokens(reg)) { try { await kvPutJSON(env, 'devices', reg); } catch (e) {} }
    return reg;
  }
  reg = { k1: { status: 'free' } };
  ensureTokens(reg);
  await kvPutJSON(env, 'devices', reg);
  return reg;
}
function ensureFreeSpare(reg) {
  for (const k in reg) if (reg[k].status === 'free') return;
  let max = 0;
  for (const k in reg) { const n = parseInt(k.slice(1), 10); if (n > max) max = n; }
  reg['k' + (max + 1)] = { status: 'free', token: makeToken() };
}

// Токен устройства: 32 символа без похожих (0/O/l/1) — читаемо при переносе руками.
function makeToken() {
  const buf = new Uint8Array(TOKEN_LEN);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < TOKEN_LEN; i++) out += TOKEN_ALPHABET[buf[i] % TOKEN_ALPHABET.length];
  return out;
}
// Выдать токен каждому ключу, у которого его ещё нет. true -> реестр изменён.
function ensureTokens(reg) {
  let ch = false;
  for (const k in reg) {
    if (!TOKEN_RE.test(String(reg[k].token || ''))) { reg[k].token = makeToken(); ch = true; }
  }
  return ch;
}
// Проверка доступа. Возвращает null если можно, иначе Response с отказом.
// ФАЗА 1: токен не передан -> пропускаем. Передан и не совпал -> отказ всегда.
async function tokenGate(env, reg, key, tok, asText) {
  const want = reg[key] && reg[key].token;
  if (tok) return (want && tok === want) ? null : denyToken(asText, 'токен не подходит');
  const st = await loadSettings(env);
  if (!st.token_required) return null;
  return denyToken(asText, 'ссылка устарела');
}
function denyToken(asText, why) {
  const hint = 'RouteHub: ' + why + '.\n' +
    'Нужна новая ссылка с токеном. Открой /admin/keys?key=<ADMIN_KEY> и скопируй строку своего устройства.\n' +
    'Формат: <origin>/t/<token>/config?key=kN';
  if (asText) return new Response(hint, { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return jsonResp({ error: why, hint: hint }, 403);
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
  const others = Object.keys(cnt).filter(function (f) { return f !== DE && regionOf(f) !== 2; });
  // v1.8.1: сначала РЕГИОН (Европа -> Америка -> СНГ -> прочие), потом число узлов.
  const multi = others.filter(function (f) { return cnt[f] >= 2; }).sort(function (a, b) {
    return (regionOf(a) - regionOf(b)) || (cnt[b] - cnt[a]) ||
      ((spd[b] || 0) - (spd[a] || 0)) || (proxOf(a) - proxOf(b));
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
  // Запасной фильтр AIrest: исключаем ВЕСЬ СНГ + уже занятые тиеры, иначе
  // исключённые из тиеров узлы СНГ вернулись бы в AI через AIrest.
  const exclAlt = REGION_RU.concat(tiers).join('|');
  fW.push('RH-Filter-W-AIrest = NameRegex, Lastdep, FilterKey = ^(?!.*(' + exclAlt + ')).*\\[VPN\\].*' + ICON_WIFI);
  fC.push('RH-Filter-C-AIrest = NameRegex, Lastdep, FilterKey = ^(?!.*(' + exclAlt + ')).*\\[VPN\\].*' + ICON_CELL);
  gW.push('RH-Filter-W-AIrest');
  gC.push('RH-Filter-C-AIrest');
  const filters = fW.join('\n') + '\n' + fC.join('\n');
  const u = 'url=http://cp.cloudflare.com/generate_204, interval=120, max-timeout=2000';
  const groups =
    'RH-AI = select, RH-AI-W, RH-AI-C, img-url=https://cdn.jsdelivr.net/gh/Orz-3/mini@master/Color/AI.png\n' +
    'RH-AI-W = fallback, ' + gW.join(', ') + ', RH-Filter-\u041e\u0431\u0445\u043e\u0434, ' + u + '\n' +
    'RH-AI-C = fallback, ' + gC.join(', ') + ', RH-Filter-\u041e\u0431\u0445\u043e\u0434, ' + u;
  return { filters: filters, groups: groups };
}

async function handleConfig(url, env, tok) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return new Response('bad key', { status: 400 });

  const reg = await loadRegistry(env);
  if (!reg[key]) return new Response('unknown key', { status: 403 });
  const bad = await tokenGate(env, reg, key, tok, true); if (bad) return bad;
  ensureFlags(reg);
  reg[key].last_config_ts = new Date().toISOString();

  // Обход кэша: no-store (кэш Workers) + ?t=now (CDN GitHub считает ресурс новым)
  const cfgUrl = env.CONFIG_URL + (env.CONFIG_URL.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
  const cr = await fetch(cfgUrl, { headers: { 'User-Agent': 'routehub-worker' }, cache: 'no-store' });
  if (!cr.ok) throw new Error('config fetch ' + cr.status);
  let conf = await cr.text();
  const cv = confVersion(conf);
  if (cv && reg[key].conf_ver !== cv) reg[key].conf_ver = cv;
  // Одна запись реестра на запрос (раньше при смене C-draft писалось дважды).
  try { await kvPutJSON(env, 'devices', reg); } catch (e) {}

  // Параметры подписки берём ИЗ КОНФИГА ДО переписывания строки Lastdep.
  const subParams = subParamsFromConf(conf);
  // База со встроенным токеном: скрипты на устройстве строят запрос как
  // ORIGIN + '/путь', поэтому токен доезжает до них без правки самих скриптов.
  const base = url.origin + '/t/' + reg[key].token;

  const sub = await getSub(env, false);
  const masterLines = sub.text.split('\n').filter(Boolean);
  const state = (await kvGetJSON(env, 'metrics:' + key)) || {};
  const blocks = aiBlocks(buildAiTiers(masterLines, state));
  conf = conf.replace('# __RH_AI_FILTERS__', blocks.filters);
  conf = conf.replace('# __RH_AI_GROUPS__', blocks.groups);

  const subUrl = base + '/nodes?key=' + key + subParams;
  conf = conf.replace(/^Lastdep = .*$/m, 'Lastdep = ' + subUrl);
  const mylistUrl = base + '/mylist?key=' + key;
  conf = conf.replace('# __RH_MYLIST_URL__', mylistUrl);
  const scriptBase = env.CONFIG_URL.replace(/[^/]+$/, '');
  conf = conf.replace(/script-path=(routehub-[^,\s]+)/g, 'script-path=' + scriptBase + '$1');
  const sFlags = [];
  if (reg[key].cell_unlim) sFlags.push('cellall');
  if (reg[key].ewma) sFlags.push('ewma');
  conf = conf.replace('tag=RH-Speed', 'tag=RH-Speed, argument=' + key + '|' + base + '|' + sFlags.join(','));
  const nOpts = reg[key].auto_refresh ? 'autorefresh' : '';
  conf = conf.replace('tag=RH-Net', 'tag=RH-Net, argument=' + key + '|' + base + '|' + nOpts);
  conf = conf.replace('tag=RH-DashCache,', 'tag=RH-DashCache, argument=' + key + '|' + base + ',');
  conf = conf.replace('tag=RH-Dash,', 'tag=RH-Dash, argument=' + key + '|' + base + ',');
  conf = conf.replace('tag=RH-RKN,', 'tag=RH-RKN, argument=' + key + '|' + base + ',');

  return new Response(conf, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function handleStatus(url, env, tok) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  const reg = await loadRegistry(env);
  const e = reg[key];
  if (!e) return jsonResp({ error: 'unknown key' }, 403);
  const bad = await tokenGate(env, reg, key, tok, false); if (bad) return bad;
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

async function handleNodes(url, env, tok) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return new Response('bad key', { status: 400 });
  const reg = await loadRegistry(env);
  if (!reg[key]) return new Response('unknown key', { status: 403 });
  const bad = await tokenGate(env, reg, key, tok, true); if (bad) return bad;
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

async function handleRefresh(url, env, tok) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  const reg = await loadRegistry(env);
  if (!reg[key]) return jsonResp({ error: 'unknown key' }, 403);
  const bad = await tokenGate(env, reg, key, tok, false); if (bad) return bad;
  try {
    const fresh = await fetchUpstream(env);
    await kvPutJSON(env, 'sub_cache', fresh);
    return jsonResp({ ok: true, nodes: fresh.n, updated: new Date(fresh.ts).toISOString() });
  } catch (e) {
    return jsonResp({ ok: false, error: String(e && e.message || e) }, 502);
  }
}

async function handleMylist(url, env, tok) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return new Response('bad key', { status: 400 });
  const reg = await loadRegistry(env);
  if (!reg[key]) return new Response('unknown key', { status: 403 });
  const bad = await tokenGate(env, reg, key, tok, true); if (bad) return bad;
  const list = await loadMylist(env, key);
  const lines = ['# RouteHub личный список RH-RU (' + key + '), доменов: ' + list.length];
  for (const d of list) lines.push('DOMAIN-SUFFIX,' + d);
  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function handleRule(req, env, add, tok) {
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }
  const key = (data && data.key) || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  const reg = await loadRegistry(env);
  if (!reg[key]) return jsonResp({ error: 'unknown key' }, 403);
  const badT = await tokenGate(env, reg, key, tok, false); if (badT) return badT;
  const domain = String((data && data.domain) || '').trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) return jsonResp({ error: 'bad domain' }, 400);
  let list = await loadMylist(env, key);
  if (add) {
    if (list.indexOf(domain) < 0) list.push(domain);
  } else {
    list = list.filter(function (d) { return d !== domain; });
  }
  await kvPutJSON(env, 'mylist:' + key, list);
  return jsonResp({ ok: true, key: key, domains: list });
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

async function handleDashboard(url, env, tok) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  const reg = await loadRegistry(env);
  const e = reg[key];
  if (!e) return jsonResp({ error: 'unknown key' }, 403);
  const bad = await tokenGate(env, reg, key, tok, false); if (bad) return bad;
  const c = await kvGetJSON(env, 'sub_cache');
  const state = (await kvGetJSON(env, 'metrics:' + key)) || {};
  const masterLines = (c && c.text) ? c.text.split('\n').filter(Boolean) : [];
  const nodes = nodesForDash(masterLines, state);
  const rkn = (await kvGetJSON(env, 'rkn:' + key)) || null;
  const rknHist = (await kvGetJSON(env, 'rkn_hist:' + key)) || [];
  const mylist = await loadMylist(env, key);
  const traffic = c ? parseUserinfo(c.meta || {}) : null;
  return jsonResp({
    key: key,
    worker: WORKER_VER,
    conf_ver: e.conf_ver || null,
    status: e.status || null,
    sub_age_min: c ? Math.round((Date.now() - c.ts) / 60000) : null,
    sub_nodes: c ? (c.n || masterLines.length) : 0,
    sub_ts: c ? new Date(c.ts).toISOString() : null,
    last_config_ts: e.last_config_ts || null,
    last_nodes_ts: e.last_nodes_ts || null,
    traffic: traffic,
    rkn: rkn,
    rkn_hist: rknHist.slice(-20),
    mylist: mylist,
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

async function handleRkn(req, env, tok) {
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }
  const key = (data && data.key) || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  const reg = await loadRegistry(env);
  if (!reg[key]) return jsonResp({ error: 'unknown key' }, 403);
  const badT = await tokenGate(env, reg, key, tok, false); if (badT) return badT;
  const mode = String((data && data.mode) || '');
  if (['normal', 'whitelist', 'block'].indexOf(mode) < 0) return jsonResp({ error: 'bad mode' }, 400);
  const rec = { mode: mode, ts: (data && data.ts) || new Date().toISOString() };
  let hist = (await kvGetJSON(env, 'rkn_hist:' + key)) || [];
  if (!hist.length || hist[hist.length - 1].mode !== mode) {
    hist.push(rec);
    if (hist.length > 50) hist = hist.slice(-50);
    // Смена режима: текущее состояние + история — одной транзакцией.
    await kvPutManyJSON(env, [['rkn:' + key, rec], ['rkn_hist:' + key, hist]]);
  } else {
    await kvPutJSON(env, 'rkn:' + key, rec);
  }
  return jsonResp({ ok: true, key: key, mode: mode });
}

async function handleSpeed(req, env, tok) {
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }

  const key = (data && data.key) || '';
  const nonce = String((data && data.nonce) || '');
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  if (!nonce) return jsonResp({ error: 'no nonce' }, 400);

  const reg = await loadRegistry(env);
  if (!reg[key]) return jsonResp({ error: 'unknown key' }, 403);
  const badT = await tokenGate(env, reg, key, tok, false); if (badT) return badT;
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

  // v1.9.0: отсечение МЁРТВЫХ МЕТРИК — ключей, которых нет в текущей подписке.
  // Критерий один: фактический состав sub_cache (без порогов по возрасту).
  // ПРЕДОХРАНИТЕЛЬ: подписка недоступна, не распарсилась или дала 0 строк ->
  // чистка пропускается целиком. Иначе один сбой Lastdep стёр бы накопленное.
  let pruned = 0;
  try {
    const sub = await kvGetJSON(env, 'sub_cache');
    const lines = (sub && sub.text) ? sub.text.split('\n').filter(Boolean) : [];
    if (lines.length) {
      const live = {};
      for (const line of lines) live[matchKey(decodeName(fragOf(line)))] = 1;
      for (const k in state) if (!(k in live)) { delete state[k]; pruned++; }
    }
  } catch (e) { pruned = 0; }

  let labeled = 0;
  for (const k in state) if (state[k] && (state[k].w || state[k].c)) labeled++;

  // Парная запись одним обращением к D1 (атомарно): метрики + реестр.
  await kvPutManyJSON(env, [['metrics:' + key, state], ['devices', reg]]);

  return jsonResp({ ok: true, key: key, status: e.status, labeled: labeled, pruned: pruned, sent_wifi: sentW, sent_cell: sentC });
}

// ======================== АДМИН-ПАНЕЛЬ (v1.9.0) ============================
// СЕССИЯ (v1.9.1). Cookie rh_adm = '<exp>.<подпись>', подпись — HMAC-SHA256 по
// строке 'rh-admin-v1|<exp>' с ключом ADMIN_KEY. Проверяется пересчётом, поэтому
// на сервере ничего не хранится (в D1 записей нет). Смена ADMIN_KEY обнуляет все
// выданные сессии автоматически: подпись перестаёт сходиться.
const ADMIN_COOKIE = 'rh_adm';
const ADMIN_SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 суток
const ADMIN_SESSION_TAG = 'rh-admin-v1';

function b64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// Сравнение за постоянное время: посимвольный XOR без раннего выхода.
// Разная длина отвергается сразу — длина секретом не является.
function timingEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return d === 0;
}
async function signSession(secret, exp) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(ADMIN_SESSION_TAG + '|' + exp));
  return b64url(new Uint8Array(sig));
}
async function makeSession(secret) {
  const exp = Date.now() + ADMIN_SESSION_MS;
  return exp + '.' + (await signSession(secret, exp));
}
// Любая невнятность (нет точки, срок истёк, подпись не сошлась) -> false.
async function verifySession(secret, val) {
  const s = String(val || '');
  const i = s.indexOf('.');
  if (i <= 0) return false;
  const exp = Number(s.slice(0, i));
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  return timingEq(s.slice(i + 1), await signSession(secret, exp));
}
function readCookie(req, name) {
  const raw = req.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const p = part.trim();
    const i = p.indexOf('=');
    if (i > 0 && p.slice(0, i) === name) return p.slice(i + 1);
  }
  return '';
}
// Path=/admin — на эндпоинты устройств (/config, /nodes, /speed) cookie не уходит.
// SameSite=Strict закрывает CSRF, HttpOnly прячет значение от скриптов страницы.
function sessionCookie(value, maxAgeSec) {
  return ADMIN_COOKIE + '=' + value + '; Path=/admin; Max-Age=' + maxAgeSec +
    '; HttpOnly; Secure; SameSite=Strict';
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Гейт: X-Admin-Key (панель шлёт его только при входе) -> ?key= (ручные заходы)
// -> сессионная cookie. Async из-за пересчёта HMAC.
async function adminGate(req, url, env) {
  if (!env.ADMIN_KEY) return jsonResp({ error: 'admin disabled' }, 403);
  const key = req.headers.get('X-Admin-Key') || url.searchParams.get('key') || '';
  if (key && timingEq(key, env.ADMIN_KEY)) return null;
  const c = readCookie(req, ADMIN_COOKIE);
  if (c && await verifySession(env.ADMIN_KEY, c)) return null;
  return jsonResp({ error: 'forbidden' }, 403);
}

// Обмен ADMIN_KEY на сессию. Неверный ключ — 403 с задержкой ~300 мс: грубая
// помеха перебору. Счётчики попыток не заводились намеренно — они потребовали
// бы записи в D1 на КАЖДЫЙ запрос, а ключ и без того длинный секрет.
async function handleAdminLogin(req, env) {
  if (!env.ADMIN_KEY) return jsonResp({ error: 'admin disabled' }, 403);
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }
  const key = String((data && data.key) || '');
  if (!key || !timingEq(key, env.ADMIN_KEY)) {
    await sleep(300);
    return jsonResp({ error: 'forbidden' }, 403);
  }
  const val = await makeSession(env.ADMIN_KEY);
  return new Response(JSON.stringify({
    ok: true, expires: new Date(Date.now() + ADMIN_SESSION_MS).toISOString(),
  }), { status: 200, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Set-Cookie': sessionCookie(val, Math.round(ADMIN_SESSION_MS / 1000)),
  } });
}

// Погасить сессию в этом браузере. Гейт не нужен: операция ничего не открывает.
function handleAdminLogout() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Set-Cookie': sessionCookie('', 0),
  } });
}

// Страница панели. Без гейта: сама разметка секретов не содержит, ключ вводится
// в ней и уходит в /admin/login. HTML вбирается в бандл при сборке.
function handleAdminPage() {
  return new Response(ADMIN_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function deviceRow(url, k, e) {
  const flags = {};
  for (const f of FLAGS) flags[f] = !!e[f];
  return {
    key: k, status: e.status || null,
    first_seen: e.first_seen || null, last_seen: e.last_seen || null,
    last_config_ts: e.last_config_ts || null, last_nodes_ts: e.last_nodes_ts || null,
    conf_ver: e.conf_ver || null, nodes_n: e.nodes_n || 0,
    token: e.token || null, flags: flags,
    config_url: url.origin + '/t/' + e.token + '/config?key=' + k,
    dashboard_url: url.origin + '/t/' + e.token + '/dashboard?key=' + k,
    refresh_url: url.origin + '/t/' + e.token + '/refresh?key=' + k,
  };
}

// Готовые ссылки по устройствам — отсюда Диана берёт строку для нового телефона.
// Токен показывается ТОЛЬКО здесь и в /admin/state, и только под ADMIN_KEY.
async function handleAdminKeys(req, url, env) {
  const denied = await adminGate(req, url, env); if (denied) return denied;
  const reg = await loadRegistry(env);
  const st = await loadSettings(env);
  const out = [];
  for (const k in reg) out.push(deviceRow(url, k, reg[k]));
  return jsonResp({ ok: true, token_required: st.token_required, devices: out });
}

// Каскад регионов конфига: сколько узлов в каждом тире и сколько из них живых
// по метрикам выбранного устройства. Порядок тиров совпадает с [Proxy Group]
// главного конфига (RH-АВТО): EU -> AM -> RU/СНГ -> прочие -> игры -> обход.
const CASCADE_TIERS = ['EU', 'AM', 'RU', 'REST', 'GAME', 'BYPASS'];
function cascadeOf(masterLines, state) {
  const out = {};
  for (const t of CASCADE_TIERS) out[t] = { total: 0, live: 0 };
  for (const line of masterLines) {
    const name = decodeName(fragOf(line));
    const tag = tagOf(name);
    let tier;
    if (tag === 'bypass') tier = 'BYPASS';
    else if (tag === 'game') tier = 'GAME';
    else if (tag === 'vpn') tier = CASCADE_TIERS[regionOf(flagOf(name))];
    else continue;
    out[tier].total++;
    const st = state[matchKey(name)];
    const m = st ? (st.w || st.c) : null;
    if (m && !m.dead) out[tier].live++;
  }
  return out;
}

// Сводка для панели: один GET на всё, чтобы не плодить обращения к D1.
// ?dev=kN — устройство, по которому считаются каскад, метрики и личный список;
// по умолчанию первое привязанное.
async function handleAdminState(req, url, env) {
  const denied = await adminGate(req, url, env); if (denied) return denied;
  const reg = await loadRegistry(env);
  const st = await loadSettings(env);
  const c = await kvGetJSON(env, 'sub_cache');
  const masterLines = (c && c.text) ? c.text.split('\n').filter(Boolean) : [];

  let dev = url.searchParams.get('dev') || '';
  if (!reg[dev]) {
    dev = '';
    for (const k in reg) if (reg[k].status === 'bound') { dev = k; break; }
    if (!dev) for (const k in reg) { dev = k; break; }
  }
  const state = dev ? ((await kvGetJSON(env, 'metrics:' + dev)) || {}) : {};
  const mylist = dev ? await loadMylist(env, dev) : [];
  const rkn = dev ? ((await kvGetJSON(env, 'rkn:' + dev)) || null) : null;

  const devices = [];
  for (const k in reg) devices.push(deviceRow(url, k, reg[k]));

  // Раздел «хранилище»: тот же запрос, что стоял в снятом /admin/verify.
  let storage = [];
  try {
    const rows = await env.RH_DB.prepare(
      'SELECT key, LENGTH(value) AS len, updated_at FROM kv ORDER BY key').all();
    storage = (rows.results || []).map(function (r) {
      return { key: r.key, len: r.len, updated_at: r.updated_at || null };
    });
  } catch (e) { storage = []; }

  return jsonResp({
    ok: true, worker: WORKER_VER,
    token_required: st.token_required,
    dev: dev || null,
    sub: {
      ts: c ? new Date(c.ts).toISOString() : null,
      age_min: c ? Math.round((Date.now() - c.ts) / 60000) : null,
      nodes: c ? (c.n || masterLines.length) : 0,
      fresh_min: Math.round(FRESH_MS / 60000),
      traffic: c ? parseUserinfo(c.meta || {}) : null,
    },
    cascade: cascadeOf(masterLines, state),
    metrics_n: Object.keys(state).length,
    mylist: mylist, rkn: rkn,
    devices: devices, storage: storage,
    server_now: new Date().toISOString(),
  });
}

// Настройки устройства: флаги (заменяют правку SQL в консоли D1), перевыпуск
// токена, отвязка. Две последние операции способны отрезать устройство —
// панель запрашивает подтверждение.
async function handleAdminDevice(req, url, env) {
  const denied = await adminGate(req, url, env); if (denied) return denied;
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }
  const key = (data && data.key) || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  const reg = await loadRegistry(env);
  const e = reg[key];
  if (!e) return jsonResp({ error: 'unknown key' }, 404);
  ensureFlags(reg);

  const flags = (data && data.flags) || null;
  if (flags) for (const f of FLAGS) if (typeof flags[f] === 'boolean') e[f] = flags[f];

  const action = String((data && data.action) || '');
  if (action === 'regen_token') e.token = makeToken();
  else if (action === 'unbind') { e.status = 'free'; delete e.nonce; }
  else if (action && action !== 'flags') return jsonResp({ error: 'bad action' }, 400);

  ensureFreeSpare(reg);
  await kvPutJSON(env, 'devices', reg);
  return jsonResp({ ok: true, device: deviceRow(url, key, e) });
}

// Переключатель фазы 2 токенов. Значение живёт в D1, деплой не требуется.
async function handleAdminSettings(req, url, env) {
  const denied = await adminGate(req, url, env); if (denied) return denied;
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }
  if (!data || typeof data.token_required !== 'boolean') return jsonResp({ error: 'bad settings' }, 400);
  const st = await loadSettings(env);
  st.token_required = data.token_required;
  await saveSettings(env, st);
  return jsonResp({ ok: true, settings: st });
}

// Действия панели. Пока одно: обновить подписку немедленно.
async function handleAdminAction(req, url, env) {
  const denied = await adminGate(req, url, env); if (denied) return denied;
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }
  const action = String((data && data.action) || '');
  if (action !== 'refresh_sub') return jsonResp({ error: 'bad action' }, 400);
  try {
    const fresh = await fetchUpstream(env);
    await kvPutJSON(env, 'sub_cache', fresh);
    return jsonResp({ ok: true, nodes: fresh.n, updated: new Date(fresh.ts).toISOString() });
  } catch (e) {
    return jsonResp({ ok: false, error: String(e && e.message || e) }, 502);
  }
}

// Личный список RH-RU из панели. Модель та же, что у POST /addrule /delrule:
// один ключ mylist:<kN> = массив доменов. add=false — удаление.
async function handleAdminMylist(req, url, env) {
  const denied = await adminGate(req, url, env); if (denied) return denied;
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }
  const key = (data && data.key) || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  const reg = await loadRegistry(env);
  if (!reg[key]) return jsonResp({ error: 'unknown key' }, 404);
  const domain = String((data && data.domain) || '').trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) return jsonResp({ error: 'bad domain' }, 400);
  let list = await loadMylist(env, key);
  if (data.add === false) list = list.filter(function (d) { return d !== domain; });
  else if (list.indexOf(domain) < 0) list.push(domain);
  await kvPutJSON(env, 'mylist:' + key, list);
  return jsonResp({ ok: true, key: key, domains: list });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // Токен: префикс пути /t/<token>/... (так его получают скрипты через ORIGIN)
    // либо ?token=... для ручных заходов из браузера. Префикс срезаем и дальше
    // маршрутизируем как раньше — все обработчики видят прежние пути.
    let tok = '';
    const pm = url.pathname.match(PATH_TOKEN_RE);
    if (pm) { tok = pm[1]; url.pathname = pm[2] || '/'; }
    else {
      const qt = url.searchParams.get('token') || '';
      if (TOKEN_RE.test(qt)) tok = qt;
    }
    try {
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
          'Access-Control-Max-Age': '86400',
        } });
      }
      if (req.method === 'GET' && (url.pathname === '/icon.svg' || url.pathname === '/icon.png' || url.pathname === '/apple-touch-icon.png')) return iconResp();
      if (req.method === 'GET' && url.pathname === '/whoami') return handleWhoami(req);
      if (req.method === 'GET' && url.pathname === '/config') return await handleConfig(url, env, tok);
      if (req.method === 'GET' && url.pathname === '/nodes') return await handleNodes(url, env, tok);
      if (req.method === 'GET' && url.pathname === '/refresh') return await handleRefresh(url, env, tok);
      if (req.method === 'GET' && url.pathname === '/dashboard') return await handleDashboard(url, env, tok);
      if (req.method === 'GET' && url.pathname === '/mylist') return await handleMylist(url, env, tok);
      if (req.method === 'GET' && url.pathname === '/status') return await handleStatus(url, env, tok);
      if (req.method === 'GET' && url.pathname === '/admin') return handleAdminPage();
      if (req.method === 'POST' && url.pathname === '/admin/login') return await handleAdminLogin(req, env);
      if (req.method === 'POST' && url.pathname === '/admin/logout') return handleAdminLogout();
      if (req.method === 'GET' && url.pathname === '/admin/state') return await handleAdminState(req, url, env);
      if (req.method === 'GET' && url.pathname === '/admin/keys') return await handleAdminKeys(req, url, env);
      if (req.method === 'POST' && url.pathname === '/admin/device') return await handleAdminDevice(req, url, env);
      if (req.method === 'POST' && url.pathname === '/admin/settings') return await handleAdminSettings(req, url, env);
      if (req.method === 'POST' && url.pathname === '/admin/action') return await handleAdminAction(req, url, env);
      if (req.method === 'POST' && url.pathname === '/admin/mylist') return await handleAdminMylist(req, url, env);
      if (req.method === 'POST' && url.pathname === '/rkn') return await handleRkn(req, env, tok);
      if (req.method === 'POST' && url.pathname === '/addrule') return await handleRule(req, env, true, tok);
      if (req.method === 'POST' && url.pathname === '/delrule') return await handleRule(req, env, false, tok);
      if (req.method === 'POST' && url.pathname === '/speed') return await handleSpeed(req, env, tok);
      return new Response('routehub-worker: not found', { status: 404 });
    } catch (err) {
      return new Response('error: ' + (err && err.message ? err.message : 'unknown'), { status: 500 });
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(getSub(env, true).catch(function () {}));
  },
};

// Экспорт чистых функций для тестов (tests/routehub-worker.test.js).
// На работу Worker'а не влияет: рантайм обращается только к default-экспорту.
export const __test = {
  matchKey, stripMetric, norm, flagOf, startFlag, tagOf, regionOf, proxOf,
  subParamsFromConf, confVersion, sortMaster, buildAiTiers, aiBlocks,
  scoreOf, voiceOk, speedBlock, supNum, parseUserinfo, classifyNet,
  cascadeOf, deviceRow, makeToken, ensureTokens, ensureFlags, ensureFreeSpare,
  b64ToUtf8, utf8ToB64, decodeName, fragOf, withFrag, renderNodesBoth,
  loadSettings, saveSettings, tokenGate, FRESH_MS, WORKER_VER, FLAGS,
  makeSession, verifySession, signSession, readCookie, timingEq,
  ADMIN_COOKIE, ADMIN_SESSION_MS,
};
