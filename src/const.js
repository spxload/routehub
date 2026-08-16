// routehub — модуль const.js
// Константы: разметка имён узлов, регионы, токены, заголовки, иконка.
// Разделён из routehub-worker.js 2026-08-15 (v1.9.5). Логика не менялась.
// История версий — CHANGELOG.md в корне репозитория.

const METRIC_SEP = ' · ';

const DEAD = '⛔';                 // ⛔

const ICON_WIFI = '🛜';      // 🛜

const ICON_CELL = '📱';      // 📱

const NODATA = '∅';               // ∅

const BLK = ['▁', '▃', '▅', '▇', '█']; // ▁▃▅▇█

const SUP_PLUS = '⁺';             // ⁺

const SUP_DIG = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

const KEY_RE = /^k\d+$/;
// ФАЗА 2 миграции на токены. С v1.9.0 значение живёт в D1 (ключ settings) и
// переключается тумблером админ-панели — включение стало обратимым и не требует
// деплоя. Константа ниже — значение по умолчанию при отсутствии ключа settings.

const TOKEN_REQUIRED_DEFAULT = false;

const SETTINGS_KEY = 'settings';

const WORKER_VER = 'v1.9.8';

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

const DE = '🇩🇪'; // 🇩🇪

const RU = '🇷🇺'; // 🇷🇺

const BY = '🇧🇾'; // 🇧🇾

const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/u;

const FLAG_START_RE = /^\s*([\u{1F1E6}-\u{1F1FF}]{2})/u;

const PROX = {
  '🇩🇪': 0,  '🇳🇱': 1,  '🇨🇿': 2,
  '🇦🇹': 3,  '🇵🇱': 4,  '🇫🇷': 5,
  '🇧🇪': 6,  '🇨🇭': 7,  '🇩🇰': 8,
  '🇸🇪': 9,  '🇳🇴': 10, '🇫🇮': 11,
  '🇪🇪': 12, '🇱🇻': 13, '🇱🇹': 14,
  '🇬🇧': 15, '🇮🇪': 16, '🇪🇸': 17,
  '🇮🇹': 18, '🇷🇴': 19, [BY]: 20,
  '🇹🇷': 22, '🇷🇺': 23, '🇰🇿': 24,
  '🇦🇲': 25, '🇦🇪': 26, '🇮🇳': 27,
  '🇸🇬': 28, '🇹🇭': 29, '🇯🇵': 30,
  '🇰🇷': 31, '🇺🇸': 32, '🇨🇦': 33,
  '🇧🇷': 34, '🇦🇷': 35, '🇳🇬': 36,
};

const REGION_EU = ['🇩🇪', '🇳🇱', '🇫🇮',
  '🇵🇱', '🇪🇪', '🇱🇻', '🇱🇹',
  '🇸🇪', '🇳🇴', '🇩🇰', '🇮🇪',
  '🇬🇧', '🇫🇷', '🇪🇸', '🇮🇹',
  '🇨🇭', '🇦🇹', '🇧🇪', '🇨🇿',
  '🇷🇴', '🇷🇸', '🇵🇹', '🇬🇷',
  '🇭🇺', '🇸🇰', '🇸🇮', '🇭🇷',
  '🇧🇬', '🇱🇺', '🇮🇸', '🇲🇩',
  '🇺🇦'];

const REGION_AM = ['🇺🇸', '🇨🇦', '🇧🇷',
  '🇦🇷', '🇲🇽', '🇨🇱', '🇨🇴',
  '🇵🇪'];

const REGION_RU = ['🇷🇺', '🇧🇾', '🇰🇿',
  '🇦🇲', '🇬🇪', '🇦🇿', '🇺🇿',
  '🇰🇬', '🇹🇯'];

const SCORE_WS = 0.40, SCORE_WR = 0.30, SCORE_WJ = 0.20, SCORE_WB = 0.10;

const FLOOR_RTT = 30, FLOOR_JIT = 10, FLOOR_BL = 20;

const VOICE_JIT = 30, VOICE_BL = 50, VOICE_MED = 160; // пороги голосовой пригодности (☎)

// v1.9.7: ПРЕДЕЛ РАЗУМНОГО для метрик задержки. Значение выше — это не «узел
// хуже», а сбой замера: проба попала в таймаут или в паузу планировщика iOS.
// Такие значения приходят как null (компонент нейтрален), иначе один
// испорченный замер отбрасывал быстрый узел на десятки позиций вниз —
// см. ЗАМЕРЫ_И_ВЕСА.md, разбор среза от 2026-08-16 (видели jit 23726, bl 8039).
// Реальный плохой джиттер (сотни миллисекунд) порог не превышает и наказывает
// узел как раньше.
const JIT_BAD = 1000, BL_BAD = 2000;

const VOICE = '☎'; // ☎ маркер пригодности для звонков

const CORS = { 'Access-Control-Allow-Origin': '*' };

const RH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#05352C"/><stop offset="1" stop-color="#04221C"/></linearGradient><radialGradient id="hub" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#9FE1CB"/><stop offset="0.55" stop-color="#5DCAA5"/><stop offset="1" stop-color="#3FB389"/></radialGradient></defs><rect width="1024" height="1024" rx="228" fill="url(#bg)"/><g fill="none" stroke="#5DCAA5" stroke-width="34" stroke-linecap="round" opacity="0.9"><path d="M512 512 L246 246"/><path d="M512 512 L778 246"/><path d="M512 512 L214 540"/><path d="M512 512 L810 540"/><path d="M512 512 L330 802"/><path d="M512 512 L694 802"/></g><g fill="#7FE0C0"><circle cx="246" cy="246" r="46"/><circle cx="778" cy="246" r="46"/><circle cx="214" cy="540" r="46"/><circle cx="810" cy="540" r="46"/><circle cx="330" cy="802" r="46"/><circle cx="694" cy="802" r="46"/></g><circle cx="512" cy="512" r="118" fill="url(#hub)"/><circle cx="512" cy="512" r="118" fill="none" stroke="#04221C" stroke-width="10" opacity="0.35"/></svg>`;

const KV_UPSERT = 'INSERT INTO kv(key,value,updated_at) VALUES(?,?,?) ' +
  'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at';

const ADMIN_COOKIE = 'rh_adm';

const ADMIN_SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 суток

const ADMIN_SESSION_TAG = 'rh-admin-v1';

const CASCADE_TIERS = ['EU', 'AM', 'RU', 'REST', 'GAME', 'BYPASS'];

export { ADMIN_COOKIE, ADMIN_SESSION_MS, ADMIN_SESSION_TAG, BLK, BL_BAD, BY, CASCADE_TIERS, CELL_HINTS, CORS, DE, DEAD, DOMAIN_RE, FLAGS, FLAG_RE, FLAG_START_RE, FLOOR_BL, FLOOR_JIT, FLOOR_RTT, FRESH_MS, ICON_CELL, ICON_WIFI, JIT_BAD, KEY_RE, KV_UPSERT, META_HEADERS, METRIC_SEP, NODATA, NODE_PREFIXES, PATH_TOKEN_RE, PROX, REGION_AM, REGION_EU, REGION_RU, RH_ICON_SVG, RU, SCORE_WB, SCORE_WJ, SCORE_WR, SCORE_WS, SETTINGS_KEY, SUP_DIG, SUP_PLUS, TOKEN_ALPHABET, TOKEN_LEN, TOKEN_RE, TOKEN_REQUIRED_DEFAULT, VOICE, VOICE_BL, VOICE_JIT, VOICE_MED, WORKER_VER };
