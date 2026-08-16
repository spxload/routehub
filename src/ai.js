// routehub — модуль ai.js
// AI-тиеры: страновые каскады и региональные остатки — РАСЧЁТ.
// Рендер под конкретный клиент живёт в clients/*.js (ADR-01, 16.08).
// Разделён из routehub-worker.js 2026-08-15 (v1.9.5). Логика не менялась.
// История версий — CHANGELOG.md в корне репозитория.

import { DE, REGION_AM, REGION_EU, REGION_RU } from './const.js';
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
// Сами фильтры строит aiBlocks в clients/loon.js: список стран — расчёт,
// строки NameRegex — синтаксис Loon.

export { buildAiTiers };
