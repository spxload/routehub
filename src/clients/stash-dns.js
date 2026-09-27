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

export { DNS_BOOT, DNS_FAKE_IP_FILTER, DNS_MAIN, DNS_NS_POLICY };
