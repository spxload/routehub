// routehub — модуль clients/stash-watch.js
// КЛИЕНТСКИЙ СЛОЙ STASH: ПРЯМЫЕ УЗЛЫ RH-RU и их НАБЛЮДАТЕЛЬНАЯ ГРУППА
// (S-draft-12). Узлы `type: direct` RH-Прямо-RU-1/-2 — члены RH-RU
// (clients/stash-service.js) и секции `proxies:` профиля
// (clients/stash-profile.js). «Часы» RH-Прямо-RU-Часы — в конце
// `proxy-groups`; ни одно правило на них не ссылается.
// История версий — CHANGELOG.md в корне репозитория.

import { BENCH_TIMEOUT } from './stash-nodeset.js';

// ЗАЧЕМ (опыт ST21, 27.09). RH-RU = fallback [DIRECT, RH-Обход]: у DIRECT
// своего адреса проверки нет, Stash мерит его по умолчанию
// `http://www.apple.com/`, 5 с (stash.wiki/en/proxy-protocols/proxy-types).
// 06:46 UTC DIRECT 33 мин проваливал эту проверку, и RH-RU с RH-Главный
// ушли одновременно — объект DIRECT общий. Иностранный адрес для РФ-трафика —
// не та семантика: RH-RU должна уходить на обход, когда НЕДОСТУПНА РОССИЯ
// напрямую (whitelist), а не когда недоступен apple.com. Прежние «часы»
// RH-Часы (url-test [DIRECT], 60 с) не помогли — они мерили тот же apple.com.
//
// ВЫБОР АДРЕСОВ. Российский адрес ВНЕ whitelist: под whitelist он умирает,
// и RH-RU уходит на обход — ради мелких банков (набор rh-ru-banks =
// forg-lib category-ru.list ведёт на RH-RU). `ya.ru` (узел RH-Прямо-RU в Lab,
// ST21) не годится: он в whitelist-domains.list и hxehex-whitelist.list,
// под whitelist жив (docs/СРАВНЕНИЕ_КЛИЕНТОВ_И_WHITELIST.md, разд. 4), и RH-RU
// осталась бы на нём. Адреса взяты из самого category-ru.list — это ровно
// тот трафик, что обслуживает RH-RU; оба отсутствуют в whitelist-domains.list
// и hxehex-whitelist.list, а их IP (186.2.163.8, 194.48.203.4) НЕ входят ни в
// одну подсеть whitelist-ips.list (сверка 27.09, ревью и тестировщик); оба
// отвечают на HEAD по http (301).
// Банки и платёжные домены списка отброшены (дух правила 4: автоматом их не
// дёргаем); `2ip.ru` — в whitelist. Взяты:
//   * avtoto.ru — магазин автозапчастей, сеть DDoS-Guard;
//   * tilda.cc  — конструктор сайтов Tilda, своя сеть AS205282.
// Разные владельцы и сети: сбой одного сайта не уводит RH-RU на обход, пока
// жив второй (fallback берёт первый живой). Уход — только когда мертвы оба.
// Сменить адрес — здесь; сторож «не из whitelist» — tests/clients-stash-watch.
// Ключи benchmark-* у `type: direct` приняты Stash 3.4.1 (узел RH-Прямо-RU
// override Lab, ST21: alive всё время, ошибок разбора нет).
const N_DIRECT_RU_1 = 'RH-Прямо-RU-1', N_DIRECT_RU_2 = 'RH-Прямо-RU-2';
const DIRECT_RU_URLS = ['http://avtoto.ru/', 'http://tilda.cc/'];
const G_DIRECT_RU_CLOCK = 'RH-Прямо-RU-Часы';

// Тайм-аут — BENCH_TIMEOUT профиля (5 с): урок ST14 — короткий порог
// выдаёт живой узел за мёртвый, а здесь ложный «мёртв» = платный обход.
const DIRECT_RU_TIMEOUT = BENCH_TIMEOUT;

// Интервал «часов». Обходных узлов в группе нет и быть не может (сторож в
// tests/clients-stash-watch.test.js), поэтому правило 1 здесь не ограничивает.
// Интервал RH-RU НЕ сокращается (GROUP_INTERVAL, 600 с): группа проверяется
// рекурсивно, и обходные узлы RH-Обход мерились бы чаще.
// ДОПУЩЕНИЕ. Результат проверки узла общий для всех групп
// (stash.wiki/en/proxy-protocols/proxy-benchmark), значит RH-RU видит свежую
// проверку прямых узлов без своей. Переключает ли fallback СРАЗУ по чужой
// проверке или ждёт своего интервала — документация молчит, НЕ ПОДТВЕРЖДЕНО.
// `lazy: false` — чтобы Stash проверял группу, на которую не идёт трафик
// (опыт ST20/ST21: фоновые проверки идут, медиана 1,9 мин).
const WATCH_INTERVAL = 60;

function directRuNodes() {
  return [N_DIRECT_RU_1, N_DIRECT_RU_2].map(function (name, i) {
    return { name: name, type: 'direct', 'benchmark-url': DIRECT_RU_URLS[i], 'benchmark-timeout': DIRECT_RU_TIMEOUT };
  });
}

function watchGroups() {
  return [
    { name: G_DIRECT_RU_CLOCK, type: 'url-test', proxies: [N_DIRECT_RU_1, N_DIRECT_RU_2], interval: WATCH_INTERVAL, lazy: false },
  ];
}

export {
  DIRECT_RU_TIMEOUT, DIRECT_RU_URLS, G_DIRECT_RU_CLOCK, N_DIRECT_RU_1, N_DIRECT_RU_2, WATCH_INTERVAL,
  directRuNodes, watchGroups,
};
