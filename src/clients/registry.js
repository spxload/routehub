// routehub — модуль clients/registry.js
// РЕЕСТР КЛИЕНТСКИХ СЛОЁВ и выбор активного (ADR-01).
// Один и тот же код разворачивается несколькими Worker-сервисами через
// [env.*] в wrangler.toml; какой клиент обслуживает контур — решает
// переменная окружения CLIENT, а не отдельная ветка кода.
//
// ПОЧЕМУ УМОЛЧАНИЕ, А НЕ ОТКАЗ. Боевой контур Loon переменной не задаёт и
// задавать не должен: любая опечатка в панели Cloudflare, стёртая при деплое
// plaintext-переменная или чужая правка wrangler.toml не имеют права оставить
// телефон Дианы без конфига. Поэтому и отсутствие переменной, и неизвестное
// значение дают 'loon' — известное рабочее поведение. Строгость здесь дешевле
// не будет: неизвестное имя клиента увидит тот, кто заводит стенд, по тому,
// что стенд отвечает как Loon.
//
// ЧТО В ЗАПИСИ. config — модуль, умеющий отдать /config для этого клиента;
// groups — модуль, собирающий группы политик; nodes — модуль, подменяющий
// формат выдачи /nodes. Поля, которых у клиента нет, стоят null, и вызывающий
// обязан это проверить.
// nodes = null у Loon читается как «боевое поведение /nodes» (base64 из
// src/sub.js) и трогать его нельзя; у Stash поставщик прокси принимает только
// Clash-YAML с ключом `proxies:`, поэтому слой есть.
// История версий — CHANGELOG.md в корне репозитория.

import * as LOON from './loon.js';
import * as STASH from './stash.js';
import * as STASH_PROFILE from './stash-profile.js';

const DEFAULT_CLIENT = 'loon';

const CLIENTS = {
  loon: { id: 'loon', config: LOON, groups: null, nodes: null },
  stash: { id: 'stash', config: STASH_PROFILE, groups: STASH, nodes: STASH },
};

// Имя активного клиента. Регистр и пробелы вокруг значения не важны:
// переменную заводят руками в wrangler.toml или в панели Cloudflare.
function clientId(env) {
  const raw = String((env && env.CLIENT) || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CLIENTS, raw) ? raw : DEFAULT_CLIENT;
}

function pickClient(env) { return CLIENTS[clientId(env)]; }

export { CLIENTS, DEFAULT_CLIENT, clientId, pickClient };
