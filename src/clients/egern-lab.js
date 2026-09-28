// routehub — модуль clients/egern-lab.js
// КЛИЕНТСКИЙ СЛОЙ EGERN НА СТЕНДЕ STASH: СВОДНАЯ ПРОБА EGS (решения Дианы
// 27.09 «Оба», 28.09 «Да»). История — CHANGELOG.md (Пробы «EGS»).
//
// ЗАЧЕМ. Профиль пробы Egern (plugins/RouteHub-Egern-EGS.yaml), его
// подписка-образец в формате Egern (plugins/RouteHub-Egern-EGS-nodes.yaml) и
// скрипт (probes/routehub-probe-egern-egs.js) раздаются стендом как файлы
// репозитория — /t/<токен>/repo/<путь> (src/repo.js), как override Lab.
// Раздача строки журнала не пишет, а вопросы EGS «качает ли Egern профиль по
// таймеру (`auto_update`), подписку и скрипт в фоне и откуда» видны только с
// нашей стороны. Поэтому на удачную раздачу ЭТИХ ТРЁХ файлов — одна строка
// журнала Worker'а. Меньшее вмешательство, чем новый маршрут: адреса файлов
// прежние, токен и проверка пути остаются в repo.js, ядро про Egern не знает
// (repo.js зовёт переданную функцию, не этот модуль).
//
// ЖУРНАЛ. {lab:"egs-file", f, m, ts, asn, org}: f — profile | nodes | script,
// m — GET | HEAD, asn / org — сеть источника (как у /lab/t23-nodes:
// cfAsn / cfOrg из stash-lab.js — номер AS и санированное название владельца).
// Ни токена, ни пути с токеном, ни IP, ни заголовков, ни User-Agent.
// Пишется только на стенде Stash (CLIENT=stash): боевой Loon не пишет ничего.

import { clientId } from './registry.js';
import { cfAsn, cfOrg } from './stash-lab.js';

const EGS_FILES = Object.freeze({
  'plugins/RouteHub-Egern-EGS.yaml': 'profile',
  'plugins/RouteHub-Egern-EGS-nodes.yaml': 'nodes',
  'probes/routehub-probe-egern-egs.js': 'script',
});

function labLog(log, rec) { try { (log || console.log)(JSON.stringify(rec)); } catch (e) { /* журнал не роняет ответ */ } }

// p — путь из манифеста (уже проверен repo.js), method — метод запроса.
function noteRepoServe(p, env, cf, method, ms, log) {
  if (clientId(env) !== 'stash') return;
  if (!Object.prototype.hasOwnProperty.call(EGS_FILES, p)) return;
  const now = ms === undefined ? Date.now() : ms;
  labLog(log, { lab: 'egs-file', f: EGS_FILES[p], m: method === 'HEAD' ? 'HEAD' : 'GET',
    ts: new Date(now).toISOString(), asn: cfAsn(cf), org: cfOrg(cf) });
}

export { EGS_FILES, noteRepoServe };
