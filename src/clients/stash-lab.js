// routehub — модуль clients/stash-lab.js
// КЛИЕНТСКИЙ СЛОЙ STASH: МУЛЯЖИ ДЛЯ ОПЫТОВ ЛАБОРАТОРИИ (сейчас ST22).
// Маршрут GET /lab/t22-nodes (routehub-worker.js) — файл поставщика прокси
// для тестовых групп override RouteHub-Stash-Lab. История — CHANGELOG.md.
//
// ЗАЧЕМ. Экран Stash «Ресурсы» (27.09): профиль обновляется только на
// переднем плане, в фоне при включённом VPN — только наборы правил и
// поставщики прокси. Проба ST22 проверяет на муляжах, (1) чей порядок
// держит группа `use:` + `filter` — поставщика или фильтра, (2) разбирается
// ли группа-слот (select с одним членом через filter), (3) обновляется ли
// поставщик в фоне и (4) сбрасывает ли его обновление выбор в группах.
//
// ЧТО ОТДАЁТ. Clash-YAML `proxies:` — три узла-слота RH-Т22-1..3 и узел-метку
// RH-Т22-Метка-<номер 10-минутного окна>: имя метки меняется само, и проба
// видит, перечитал ли Stash поставщика, не трогая профиль и override.
// Порядок в выдаче ОБРАТНЫЙ порядку в фильтре override (метка, 3, 2, 1) —
// иначе по `.all` не отличить порядок поставщика от порядка фильтра.
//
// ПОЧЕМУ БЕЗ ТОКЕНА И КЛЮЧА (как /version). Выдача — только муляжи: адреса
// TEST-NET 192.0.2.0/24 (RFC 5737, никуда не ведут), порт 1, без паролей.
// Ни данных D1, ни подписки, ни секретов: функция чистая от времени. Токен
// в адресе поставщика лёг бы в публичный override — как раз этого и не надо.
// Обходных узлов здесь нет и быть не может (правило 1): имена фиксированы.
// Отвечает только стенд Stash (CLIENT=stash): боевой Loon, собранный из этой
// ветки, маршрута не знает — 404, как на любой неизвестный путь.

import { clientId } from './registry.js';
import { nodesToYaml } from './stash-yaml.js';

const T22_PATH = '/lab/t22-nodes';
const T22_PREFIX = 'RH-Т22-';
const T22_WINDOW_MS = 10 * 60000;
// Слоты в порядке override (фильтр группы RH-Т22-Фильтр и fallback RH-Т22-F).
const T22_SLOTS = ['RH-Т22-1', 'RH-Т22-2', 'RH-Т22-3'];
const T22_MARK = 'RH-Т22-Метка-';
const T22_HOST = '192.0.2.';           // TEST-NET-1: трафика нет

function t22Window(ms) { return Math.floor(Number(ms) / T22_WINDOW_MS); }

// Узлы выдачи на момент ms: метка, затем слоты в обратном порядке.
function t22Nodes(ms) {
  const mark = { name: T22_MARK + t22Window(ms), type: 'socks5', server: T22_HOST + '14', port: 1 };
  const slots = T22_SLOTS.map(function (n, i) {
    return { name: n, type: 'socks5', server: T22_HOST + String(11 + i), port: 1 };
  });
  return [mark].concat(slots.reverse());
}

function renderT22(ms) {
  return '# RouteHub — муляжи ST22 (TEST-NET, порт 1: трафика нет), окно ' + t22Window(ms) + '\n' +
    nodesToYaml(t22Nodes(ms));
}

// env нужен только для развилки клиента; в базу и в сеть обработчик не ходит.
function handleT22Nodes(env, ms) {
  if (clientId(env) !== 'stash') return new Response('routehub-worker: not found', { status: 404 });
  const now = ms === undefined ? Date.now() : ms;
  return new Response(renderT22(now), { headers: {
    'Content-Type': 'text/yaml; charset=utf-8',
    // Метка меняется раз в 10 мин; кэш (Cloudflare, Stash) спрятал бы смену.
    'Cache-Control': 'no-store',
  } });
}

export { T22_MARK, T22_PATH, T22_PREFIX, T22_SLOTS, T22_WINDOW_MS, handleT22Nodes, renderT22, t22Nodes, t22Window };
