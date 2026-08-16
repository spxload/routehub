// routehub — модуль clients/loon.js
// КЛИЕНТСКИЙ СЛОЙ LOON: всё, что знает про синтаксис Loon-конфига.
// Выделен 2026-08-16 по ADR-01: ядро (src/*.js) считает и хранит, клиентский
// слой рендерит под конкретный клиент. Логика не менялась — код перенесён
// как есть из ai.js (aiBlocks), util.js (subParamsFromConf) и api.js
// (подстановки плейсхолдеров, теперь renderConfig).
// Рядом со временем появится clients/stash.js, собирающий YAML.
// История версий — CHANGELOG.md в корне репозитория.

import { ICON_CELL, ICON_WIFI, REGION_AM, REGION_EU, REGION_RU } from '../const.js';
import { regionOf } from '../util.js';

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

function aiBlocks(tiers) {
  const fW = [], fC = [], gW = [], gC = [];
  let n = 0;
  function pushTier(fl) {
    n++;
    const id = (n < 10 ? '0' : '') + n;
    fW.push('RH-Filter-W-AI' + id + ' = NameRegex, Lastdep, FilterKey = ^(?!.*Обход).*' + fl + '.*VPN].*' + ICON_WIFI);
    fC.push('RH-Filter-C-AI' + id + ' = NameRegex, Lastdep, FilterKey = ^(?!.*Обход).*' + fl + '.*VPN].*' + ICON_CELL);
    gW.push('RH-Filter-W-AI' + id);
    gC.push('RH-Filter-C-AI' + id);
  }
  // Региональный остаток: страны региона, НЕ занятые тиерами. Список позитивный —
  // надёжнее отрицательного lookahead и короче. Пустой остаток фильтра не создаёт.
  function pushRegionRest(suffix, flags) {
    const inc = flags.filter(function (f) { return tiers.indexOf(f) < 0; });
    if (!inc.length) return;
    const re = '^(?!.*Обход).*(' + inc.join('|') + ').*VPN].*';
    fW.push('RH-Filter-W-AI' + suffix + ' = NameRegex, Lastdep, FilterKey = ' + re + ICON_WIFI);
    fC.push('RH-Filter-C-AI' + suffix + ' = NameRegex, Lastdep, FilterKey = ' + re + ICON_CELL);
    gW.push('RH-Filter-W-AI' + suffix);
    gC.push('RH-Filter-C-AI' + suffix);
  }
  const byRegion = function (r) {
    return tiers.filter(function (f) { return regionOf(f) === r; });
  };
  byRegion(0).forEach(pushTier);          // Европа (DE идёт первой — так собран tiers)
  pushRegionRest('eu', REGION_EU);        // европейские одноузловые
  byRegion(1).forEach(pushTier);          // Америка
  pushRegionRest('am', REGION_AM);        // американские одноузловые
  byRegion(3).forEach(pushTier);          // прочие регионы
  // Общий запасной AIrest: исключаем обходные, ВЕСЬ СНГ, занятые тиеры и то,
  // что уже покрыто региональными остатками. Ловит незнакомые новые страны.
  const exclAlt = ['Обход'].concat(REGION_RU, REGION_EU, REGION_AM, tiers).join('|');
  fW.push('RH-Filter-W-AIrest = NameRegex, Lastdep, FilterKey = ^(?!.*(' + exclAlt + ')).*VPN].*' + ICON_WIFI);
  fC.push('RH-Filter-C-AIrest = NameRegex, Lastdep, FilterKey = ^(?!.*(' + exclAlt + ')).*VPN].*' + ICON_CELL);
  gW.push('RH-Filter-W-AIrest');
  gC.push('RH-Filter-C-AIrest');
  const filters = fW.join('\n') + '\n' + fC.join('\n');
  const u = 'url=http://connectivitycheck.gstatic.com/generate_204, interval=120, max-timeout=2000';  const groups =
    'RH-AI = select, RH-AI-W, RH-AI-C, img-url=https://cdn.jsdelivr.net/gh/Orz-3/mini@master/Color/AI.png\n' +
    'RH-AI-W = fallback, ' + gW.join(', ') + ', RH-Filter-Обход, ' + u + '\n' +
    'RH-AI-C = fallback, ' + gC.join(', ') + ', RH-Filter-Обход, ' + u;
  return { filters: filters, groups: groups };
}

// Подстановка в текст конфига Loon. Всё, что здесь происходит, — про формат
// Loon: плейсхолдеры AI-блоков, строка [Remote Proxy], пути скриптов и их
// аргументы. Ядро сюда передаёт уже посчитанное.
//   conf     — исходный текст конфига из репозитория
//   ctx.key  — ключ устройства (kN)
//   ctx.base — база с встроенным токеном (origin + '/t/' + token)
//   ctx.dev  — запись устройства из реестра (флаги cell_unlim, ewma, auto_refresh)
//   ctx.blocks — { filters, groups } из aiBlocks
//   ctx.subParams — хвост параметров подписки из subParamsFromConf
//   ctx.scriptBase — база, откуда устройство тянет скрипты

function renderConfig(conf, ctx) {
  const key = ctx.key, base = ctx.base, dev = ctx.dev || {};
  let out = String(conf);
  out = out.replace('# __RH_AI_FILTERS__', ctx.blocks.filters);
  out = out.replace('# __RH_AI_GROUPS__', ctx.blocks.groups);

  const subUrl = base + '/nodes?key=' + key + ctx.subParams;
  out = out.replace(/^Lastdep = .*$/m, 'Lastdep = ' + subUrl);
  const mylistUrl = base + '/mylist?key=' + key;
  out = out.replace('# __RH_MYLIST_URL__', mylistUrl);
  // v1.9.9: путь скрипта может содержать папку (scripts/, probes/) — regex
  // ловит и «routehub-x.js», и «scripts/routehub-x.js». Сделано ДО переезда
  // файлов, чтобы Worker работал с обеими раскладками и окна поломки не было.
  out = out.replace(/script-path=((?:[\w.-]+\/)*routehub-[^,\s]+)/g, 'script-path=' + ctx.scriptBase + '$1');

  const sFlags = [];
  if (dev.cell_unlim) sFlags.push('cellall');
  if (dev.ewma) sFlags.push('ewma');
  out = out.replace('tag=RH-Speed', 'tag=RH-Speed, argument=' + key + '|' + base + '|' + sFlags.join(','));
  const nOpts = dev.auto_refresh ? 'autorefresh' : '';
  out = out.replace('tag=RH-Net', 'tag=RH-Net, argument=' + key + '|' + base + '|' + nOpts);
  out = out.replace('tag=RH-DashCache,', 'tag=RH-DashCache, argument=' + key + '|' + base + ',');
  out = out.replace('tag=RH-Dash,', 'tag=RH-Dash, argument=' + key + '|' + base + ',');
  // RH-RKN снят из конфига в C-draft-41; подстановка оставлена, чтобы старый
  // конфиг на не обновившемся устройстве продолжал получать аргументы.
  out = out.replace('tag=RH-RKN,', 'tag=RH-RKN, argument=' + key + '|' + base + ',');
  return out;
}

export { aiBlocks, renderConfig, subParamsFromConf };
