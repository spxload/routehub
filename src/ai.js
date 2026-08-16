// routehub — модуль ai.js
// AI-тиеры: страновые каскады и региональные остатки.
// Разделён из routehub-worker.js 2026-08-15 (v1.9.5). Логика не менялась.
// История версий — CHANGELOG.md в корне репозитория.

import { DE, ICON_CELL, ICON_WIFI, REGION_AM, REGION_EU, REGION_RU } from './const.js';
import { decodeName, flagOf, fragOf, matchKey, proxOf, regionOf, tagOf } from './util.js';

function buildAiTiers(masterLines, state) {
  const cnt = {}, spd = {};
  for (const line of masterLines) {
    const name = decodeName(fragOf(line));
    if (tagOf(name) !== 'vpn') continue;
    const fl = flagOf(name);
    if (!fl) continue;
    cnt[fl] = (cnt[fl] || 0) + 1;
    let s = 0;
    const st = state[matchKey(name)];
    if (st) {
      if (st.w && !st.w.dead) s = Math.max(s, +st.w.down || 0);
      if (st.c && !st.c.dead) s = Math.max(s, +st.c.down || 0);
    }
    if (!(fl in spd) || s > spd[fl]) spd[fl] = s;
  }
  const others = Object.keys(cnt).filter(function (f) { return f !== DE && regionOf(f) !== 2; });
  // v1.8.1: сначала РЕГИОН (Европа -> Америка -> СНГ -> прочие), потом число узлов.
  const multi = others.filter(function (f) { return cnt[f] >= 2; }).sort(function (a, b) {
    return (regionOf(a) - regionOf(b)) || (cnt[b] - cnt[a]) ||
      ((spd[b] || 0) - (spd[a] || 0)) || (proxOf(a) - proxOf(b));
  });
  const tiers = [];
  if (cnt[DE]) tiers.push(DE);
  for (const f of multi) tiers.push(f);
  return tiers;
}
// v1.9.4: РЕГИОНАЛЬНЫЕ ЗАПАСНЫЕ ФИЛЬТРЫ AIeu / AIam.
// ПРИЧИНА: в тиеры попадают только страны с cnt >= 2. Одноузловые европейские
// страны (на 2026-08-15 это AT, BE, CH, CZ, DK, ES, FR, GB, IE, NO — десять
// штук) оказывались в общем AIrest, то есть НИЖЕ тира 🇹🇷 Турции, у которой
// узлов два. Наблюдение 15.08: RH-AI-C выбрала Турцию, тогда как RH-АВТО-C с
// её региональным каскадом взяла Великобританию. Для ИИ гео важнее числа узлов
// (часть сервисов блокирует турецкий выход), поэтому европейские и
// американские остатки поднимаются ВЫШЕ тиров «прочих» регионов.
// Порядок каскада: DE -> тиры Европы -> AIeu -> тиры Америки -> AIam ->
// тиры прочих -> AIrest -> Обход. СНГ исключён везде.

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

export { aiBlocks, buildAiTiers };
