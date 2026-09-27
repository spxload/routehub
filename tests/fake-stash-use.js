// Поставщики прокси и группы `use:` + `filter` для tests/fake-stash.js (ST22).
// Вынесено отдельным файлом, чтобы fake-stash.js остался меньше 15 КБ.
//
// ЧТО УСТАНОВЛЕНО НА УСТРОЙСТВЕ: к узлам поставщика группа ведёт только
// через `use:` + `filter` (имя узла поставщика в `proxies:` уронило профиль,
// 31.08); маршрут GET /providers/proxies/{имя} есть (ST19).
// ЧТО НЕ УСТАНОВЛЕНО (допущения модели, их и проверяет ST22):
//   * порядок членов — по умолчанию порядок ПОСТАВЩИКА (так в ядре Clash);
//     опция useOrder: 'filter' — порядок альтернатив фильтра `^(?:a|b)$`;
//   * выбор select сохраняется, пока выбранный член есть в составе, иначе —
//     первый член (сброс при обновлении поставщика тест моделирует сам);
//   * тело ответа поставщика — как в ядре Clash: name, type, vehicleType,
//     proxies[{name, type}], updatedAt — ТОЛЬКО если задан в записи
//     (есть ли поле у Stash — неизвестно, проба пишет «нет данных»);
//     alive узла — тоже только если задан в записи узла (ST23).
//
// Опции createStash: providers — { имя: { proxies: [{ name, type? }],
// vehicleType?, updatedAt? } } (w.providers, можно менять на ходу);
// useOrder — 'provider' (по умолчанию) | 'filter'. Группа: { type, use,
// filter?, all? } — all при use играет роль явных `proxies:` перед узлами.

function alts(filter) {
  const m = /^\^\(\?:(.*)\)\$$/.exec(String(filter || ''));
  return m ? m[1].split('|') : null;
}

export function installUse(w, o) {
  w.providers = o.providers || {};
  function fromUse(x) {
    const re = x.filter ? new RegExp(x.filter) : null;
    let out = [];
    for (const p of x.use) {
      const pv = w.providers[p];
      if (!pv) continue;
      out = out.concat(pv.proxies.map((q) => q.name).filter((n) => !re || re.test(n)));
    }
    const a = o.useOrder === 'filter' ? alts(x.filter) : null;
    if (a) {
      const rank = (n) => { const i = a.findIndex((s) => new RegExp('^(?:' + s + ')$').test(n)); return i < 0 ? a.length : i; };
      out = out.map((n, i) => [rank(n), i, n]).sort((u, v) => u[0] - v[0] || u[1] - v[1]).map((t) => t[2]);
    }
    return out;
  }
  w.useGroup = (x) => {
    const head = (x.all || []).slice();
    Object.defineProperty(x, 'all', { enumerable: true, configurable: true, get: () => head.concat(fromUse(x)) });
  };
  for (const n of Object.keys(w.g)) if (w.g[n] && w.g[n].use) w.useGroup(w.g[n]);
  // Выбор группы с use: выбранный член, если он ещё в составе, иначе первый.
  w.useNow = (x) => {
    const a = x.all;
    return x.now !== undefined && a.indexOf(x.now) >= 0 ? x.now : a[0];
  };
  function body(n) {
    const pv = w.providers[n];
    const e = { name: n, type: 'Proxy', vehicleType: pv.vehicleType || 'HTTP',
      proxies: pv.proxies.map((q) => ({ name: q.name, type: q.type || 'Socks5', ...('alive' in q ? { alive: q.alive } : {}) })) };
    if ('updatedAt' in pv) e.updatedAt = pv.updatedAt;
    return e;
  }
  // true — запрос обработан (путь /providers/proxies…).
  w.providerRoute = (method, p, reply, msg, dec) => {
    const m = p.match(/^\/providers\/proxies(?:\/([^/?]+))?(?:\?.*)?$/);
    if (!m) return false;
    if (method !== 'get') { reply(405, 'Method Not Allowed'); return true; }
    if (!m[1]) {
      const px = {};
      for (const n of Object.keys(w.providers)) px[n] = body(n);
      reply(200, JSON.stringify({ providers: px }));
      return true;
    }
    const n = dec(m[1]);
    if (!Object.prototype.hasOwnProperty.call(w.providers, n)) { reply(404, msg.noGroup); return true; }
    reply(200, JSON.stringify(body(n)));
    return true;
  };
}
