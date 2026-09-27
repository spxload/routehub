// routehub — модуль clients/stash-watch.js
// КЛИЕНТСКИЙ СЛОЙ STASH: НАБЛЮДАТЕЛЬНЫЕ ГРУППЫ профиля (S-draft-9) —
// «часы» RH-Часы и пара RH-Прямо-RU / RH-Тест-RU. Ни одно правило на них не
// ссылается, в рабочие группы они не входят; профиль добавляет их в конец
// `proxy-groups` (clients/stash-profile.js), узел — в конец `proxies`.
// Читает их проба ST21 (probes/routehub-probe-stash21.js), только чтением.
// История версий — CHANGELOG.md в корне репозитория.

import { BENCH_TIMEOUT } from './stash-nodeset.js';

const G_CLOCK = 'RH-Часы', G_TEST_RU = 'RH-Тест-RU', N_DIRECT_RU = 'RH-Прямо-RU';

// Интервал наблюдательных групп. Обходных узлов в них нет и быть не может
// (сторож в tests/clients-stash-watch.test.js), поэтому правило 1 здесь не
// ограничивает: замер идёт напрямую, в обход не ходит. Интервалы рабочих
// групп (GROUP_INTERVAL, 600 с) этим модулем не трогаются.
const WATCH_INTERVAL = 60;

// Российский адрес замера для RH-Прямо-RU.
// ПОЧЕМУ ya.ru. Замер под whitelist (docs/СРАВНЕНИЕ_КЛИЕНТОВ_И_WHITELIST.md,
// раздел 4): напрямую живы только ya.ru (200 за 565–801 мс) и gosuslugi.ru;
// yandex.ru, vk.com, dzen.ru, банки и прочие госадреса — таймаут. Госуслуги
// не берём: автоматические запросы раз в минуту к госдомену — не то, чем
// проба должна нагружать (дух правила 4), и отвечает он через DDoS-страницу.
// ya.ru уже служит проекту маяком (scripts/routehub-netwatch.js).
// ПОЧЕМУ http. Вики рекомендует для benchmark-url протокол HTTP, и так же
// устроен BENCH_URL. ya.ru по http отвечает на HEAD перенаправлением (3xx):
// для замера задержки это ответ. ОГОВОРКА: whitelist 08.09 мерился по https;
// пропускает ли он ya.ru на 80-м порту — не измерено, это и покажет узел.
const WATCH_URL = 'http://ya.ru/';

// Наблюдательный узел: тот же прямой путь, что DIRECT, но со своим адресом
// замера. `type: direct` документирован (stash.wiki/en/proxy-protocols/
// proxy-types), а ключи benchmark-* у него — НЕТ: документированы на узле
// вообще, без оговорки про direct. Принимает ли их Stash у direct — ровно
// вопрос опыта (идея Дианы «проверять прямой путь российским адресом»).
// Поэтому узел ни в одну рабочую группу не входит: RH-RU и RH-Главный
// остаются на DIRECT, пока опыт не ответит.
function watchNode() {
  return { name: N_DIRECT_RU, type: 'direct', 'benchmark-url': WATCH_URL, 'benchmark-timeout': BENCH_TIMEOUT };
}

// Группы. `lazy: false` — чтобы Stash проверял группу, на которую не идёт
// трафик (так же в override ST20, принято Stash 3.4.1 на устройстве 26.09).
// RH-Часы — гипотеза ideator 27.09 (НЕ подтверждена, Stash — закрытый код):
// в ядре Clash неудачный dial ставит узлу alive=false до следующего замера,
// а DIRECT — один объект на все группы. Плановый замер «часов» раз в 60 с
// возвращает alive общему DIRECT, и RH-RU (fallback [DIRECT, RH-Обход])
// возвращается с обхода за ≤ 60 с вместо ≤ 600 с.
// ЦЕНА, КОТОРУЮ НАДО ВИДЕТЬ. Результат замера общий для всех групп узла
// (stash.wiki/en/proxy-protocols/proxy-benchmark). Значит «часы» ускоряют и
// обратное: если под whitelist замер DIRECT не проходит, RH-RU и RH-Главный
// уйдут с DIRECT за ≤ 60 с, а не за ≤ 600 с. Сам замер бесплатный, но окно
// до перехода на обход короче. Проверяет это проба ST21.
function watchGroups() {
  return [
    { name: G_CLOCK, type: 'url-test', proxies: ['DIRECT'], interval: WATCH_INTERVAL, lazy: false },
    { name: G_TEST_RU, type: 'url-test', proxies: [N_DIRECT_RU], interval: WATCH_INTERVAL, lazy: false },
  ];
}

export { G_CLOCK, G_TEST_RU, N_DIRECT_RU, WATCH_INTERVAL, WATCH_URL, watchGroups, watchNode };
