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
// ЧТО В ЗАПИСИ. config — модуль, умеющий отдать /config для этого клиента
// (у Stash его ещё нет: каркас профиля и правила делаются отдельно, см.
// ADR-02); groups — модуль, собирающий группы политик. Поля, которых у
// клиента нет, стоят null, и вызывающий обязан это проверить.
// История версий — CHANGELOG.md в корне репозитория.

import * as LOON from './loon.js';
import * as STASH from './stash.js';

const DEFAULT_CLIENT = 'loon';

const CLIENTS = {
  loon: { id: 'loon', config: LOON, groups: null },
  stash: { id: 'stash', config: null, groups: STASH },
};

// Имя активного клиента. Регистр и пробелы вокруг значения не важны:
// переменную заводят руками в wrangler.toml или в панели Cloudflare.
function clientId(env) {
  const raw = String((env && env.CLIENT) || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CLIENTS, raw) ? raw : DEFAULT_CLIENT;
}

function pickClient(env) { return CLIENTS[clientId(env)]; }

export { CLIENTS, DEFAULT_CLIENT, clientId, pickClient };
