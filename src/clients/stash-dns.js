// routehub — модуль clients/stash-dns.js
// КЛИЕНТСКИЙ СЛОЙ STASH: секция `dns:` профиля — резолверы, fake-ip-filter и
// nameserver-policy. Выделен из clients/stash-profile.js по правилу проекта
// «модуль < 15 КБ»; логика не менялась, профиль собирает clients/stash-profile.js.
// История версий — CHANGELOG.md в корне репозитория.

// DNS. Перенос [General]: dns-server = system,1.1.1.1,77.88.8.8 и
// doh-server = cloudflare,google. Раскладка по секциям Stash: DoH — рабочие
// резолверы (nameserver), plain — начальная загрузка (default-nameserver).
// Яндекс (77.88.8.8) остаётся ТОЛЬКО plain-резервом: в DoH его не добавлять
// (отравление РКН — пометка в routehub.conf).
const DNS_BOOT = ['system', '1.1.1.1', '77.88.8.8'];
const DNS_MAIN = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query'];

// ── S-draft-7: FAKE-IP-FILTER ─────────────────────────────────────────
// Stash по своей документации отвечает поддельным адресом на всё, что идёт
// через прокси («Stash uses Fake IP to avoid local DNS queries for requests
// that need to go through a proxy» — stash.wiki/en/faq/effective-stash).
// В Loon этому противостоит `real-ip` в [General]; у нас в профиле Stash
// соответствия не было ВООБЩЕ, и это самое крупное расхождение контуров.
// Ключ `dns.fake-ip-filter` документирован (stash.wiki, Configuration
// Example), синтаксис оттуда же: `+.` — домен и все поддомены, `*` — одна
// метка. Ключи списка сериализатор кавычит, поэтому `*` YAML не ломает.
//
// ЧЕГО ЗДЕСЬ СОЗНАТЕЛЬНО НЕТ: `+.apple.com` и `+.icloud.com`. В Loon они
// в `real-ip` стоят, и прежняя запись проекта (СВЕРКА, Н3) советовала их
// добавить. ГИПОТЕЗА S-draft-7, ранее нигде не зафиксированная: `real-ip`
// отдаёт настоящий адрес, соединение уходит ПО АДРЕСУ, и доменное правило
// не матчится — тогда `*.apple.com` в `real-ip` подрывает ровно те четыре
// доменных правила C-draft-42, ради которых они и вносились. Гипотеза НЕ
// проверена ни на Loon, ни на Stash. Копировать в Stash настройку, чей вред
// заподозрен, но не измерен, значит размножать сомнительное — переносим
// бесспорную часть, Apple ждёт опыта на устройстве.
const DNS_FAKE_IP_FILTER = [
  // Перенос бесспорной части `real-ip` из routehub.conf.
  'wpad',
  'wpad.*',
  '+.local',
  '*.lan',
  '*.localdomain',
  'time.*.com',
  'ntp.*.com',
  // STUN — звонки. Поддельный адрес ломает пробивку NAT, а звонки у проекта
  // уже страдали от глушения UDP (см. disable-udp-ports в routehub.conf).
  '+.stun.*.*',
  '+.stun.*.*.*',
  '+.stun.*.*.*.*',
  '+.stun.*.*.*.*.*',
  '+.stun.playstation.net',
  // Проверка связности: адрес должен быть настоящим, иначе система считает
  // сеть неисправной. msftconnecttest — тот же хост, что в internet-test-url.
  '*.msftncsi.com',
  '*.msftconnecttest.com',
];

// ── S-draft-7: NAMESERVER-POLICY ──────────────────────────────────────
// Возможность, которой у Loon нет вовсе: свой резолвер на заданные домены.
// ЗАЧЕМ. Сверка со списками РКН 08.09: под whitelist из четырёх наших
// резолверов доступны ровно два — `system` и 77.88.8.8. `1.1.1.1` в
// whitelist-ips.list отсутствует, доменов cloudflare-dns.com и dns.google
// в whitelist-domains.list (465 доменов) нет, подсетей Cloudflare 104.16.x
// и 162.159.x тоже. То есть DoH под whitelist мёртв.
// ЧТО ДЕЛАЕМ. РФ-зоны уводим на системный резолвер: он и под whitelist жив,
// и локальность CDN у него лучше, чем у чужого DoH. Остальное остаётся на
// DoH, то есть защита от подмены РКН для иностранных доменов не трогается.
// ЧЕГО НЕ ДЕЛАЕМ. Не выключаем DoH целиком: вне whitelist plain-резолвер в
// РФ отравлен — это записано в routehub.conf у строки doh-server. Сколько
// Stash ждёт мёртвый DoH, прежде чем уйти на plain, НЕ ИЗМЕРЕНО; до замера
// состав резолверов не трогаем.
// ПОЧЕМУ БЕЗ `geosite:` — ADR-04 §5: база GEOSITE тянется с github при первом
// обращении, значит под whitelist откажет ровно тогда, когда нужна.
// Ключи не кавычатся сериализатором, поэтому все начинаются с `+` — YAML это
// принимает; ключ с `*` в начале сломал бы разбор (алиас) и здесь запрещён.
const DNS_NS_POLICY = {
  '+.ru': 'system',
  '+.su': 'system',
  '+.xn--p1ai': 'system',      // .рф в punycode
  '+.yandex.net': 'system',
  '+.vk.com': 'system',
  '+.vkuser.net': 'system',
};

// ── S-draft-9: РЕЗОЛВ ИМЁН ОБХОДНЫХ СЕРВЕРОВ ─────────────────────────
// Полевой факт 27.09: под whitelist в Stash все обходные узлы «тайм-аут», в
// Loon те же узлы живы. Серверы узлов заданы ДОМЕННЫМИ именами, а профиль
// резолвит их DoH, который под whitelist мёртв (сверка 08.09, см. выше).
// Loon живёт потому, что у него «резервный запрос»: DoH первым, plain —
// ТОЛЬКО при отказе DoH. У Stash резерва нет: «Stash will send concurrent
// requests to all servers and use the fastest response»
// (stash.wiki/en/features/dns-server).
// ПОЧЕМУ НЕ `proxy-server-nameserver: [system, 77.88.8.8]`. Он глобален:
// вне whitelist гонка отдала бы plain-ответ (отравленный, см. DNS_BOOT)
// для серверов ВСЕХ узлов, включая обычные иностранные, — риск сломать
// RH-АВТО в обычном режиме ради обхода.
// ЧТО ДЕЛАЕМ. В nameserver-policy — ТОЛЬКО точные имена серверов обходных
// узлов (tag bypass, как у RH-Обход), значение — список: вики разрешает
// «a single DNS server or an array of DNS servers». Обычные узлы остаются
// на DoH. `system` и 77.88.8.8 — ровно то, что живо под whitelist (08.09).
// Точное имя старше шаблона («exact domain > wildcard»), поэтому `+.ru`
// выше его не перебивает.
// ⚠ НЕПРОВЕРЕННОЕ ДОПУЩЕНИЕ: что резолв адреса сервера прокси вообще
// учитывает nameserver-policy. Вики этого не говорит. Довод за выбор: без
// `proxy-server-nameserver` у ядер семейства Clash имя сервера резолвит
// основной резолвер — тот, для которого policy и документирована; с этим
// ключом включается «independent DNS query path», и учёт policy там описан
// ещё меньше. Поэтому ключ не задаём. Попутный довод против допущения:
// обходной домен в зоне .ru уже попадал бы в `+.ru: system`, а узлы всё
// равно мертвы — значит либо домены вне .ru, либо policy к серверам прокси
// не применяется. Проверка — на устройстве под whitelist (проба ST21 читает
// alive обходных узлов без замера).
// ЦЕНА (ревью 27.09): имена обходных серверов резолвятся ТОЛЬКО plain
// (system, 77.88.8.8) — и вне whitelist тоже. Если провайдер отравит такое
// имя, обход сломается и в обычном режиме. Риск низкий: обходные узлы
// рассчитаны на работу под whitelist, их имена не из реестра блокировок.
// Проверка — ST21 (alive обходных узлов вне whitelist, поле «обход»).
// ИМЯ — только строго доменное: ключи сериализатор не кавычит, а приходят
// они из подписки. IP (v4 и v6) пропускаются — резолвить нечего.
const DNS_BYPASS_NS = ['system', '77.88.8.8'];
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

// set — результат nodeSet: items[i] и nodes[i] описывают один узел.
function bypassNsPolicy(set) {
  const out = {};
  const items = (set && set.items) || [], nodes = (set && set.nodes) || [];
  items.forEach(function (it, i) {
    if (!it || it.tag !== 'bypass' || !nodes[i]) return;
    const host = String(nodes[i].server || '').toLowerCase();
    if (HOST_RE.test(host)) out[host] = DNS_BYPASS_NS.slice();
  });
  return out;
}

export { DNS_BOOT, DNS_BYPASS_NS, DNS_FAKE_IP_FILTER, DNS_MAIN, DNS_NS_POLICY, bypassNsPolicy };
