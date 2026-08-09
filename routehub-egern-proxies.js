// =============================================================
// routehub-egern-proxies.js — разбор vless:// в форму proxies профиля Egern.
// Зачем: узел, ОБЪЯВЛЕННЫЙ в proxies, адресуется из скрипта по имени —
//   подтверждено на k4-8 (шаги T2/T3, 2026-08-09): три явных узла дали три
//   разных выхода. От этого зависит поузловой спидтест при миграции.
//
// TRANSPORT — РАЗМЕЧЕННОЕ ОБЪЕДИНЕНИЕ, РОВНО ОДИН КЛЮЧ (грабли 2026-08-09).
//   Egern: "proxies[N].vless.transport: invalid value: map, expected map with
//   a single key". Допустимые ключи: http1 | http2 | tls | wss | ws | grpc.
//   • WebSocket ПОВЕРХ TLS — это wss, а НЕ ws + tls:
//       transport: wss: { path, headers: { Host }, sni, skip_tls_verify }
//   • голый ws — WebSocket БЕЗ TLS: transport: ws: { path, headers: { Host } }
//   • reality вкладывается ВНУТРЬ tls, а не рядом с ним:
//       transport: tls: { sni, reality: { public_key, short_id } }
//   • grpc: { service_name, sni } — TLS применяется всегда.
//   Прежний код клал tls и ws (и tls с reality) рядом — профиль отвергался
//   на ПЕРВОМ таком узле. Источник: /docs/configuration/proxies, раздел
//   "Vmess Transport".
//
// fingerprint (fp в ссылке) в документации ОПИСАН только как
//   fingerprint_sha256 — отпечаток сертификата, это НЕ маскировка uTLS из
//   ссылки. Не переносим.
// Имена объявленных узлов НЕ совпадают с именами из подписки (префикс
//   RH-Явный-N): узлы подписки дедуплицируются ПО ИМЕНИ, совпадение сделало
//   бы результат проверки неоднозначным.
// =============================================================

function qs(search) {
  const out = {};
  const s = String(search || '').replace(/^[?]/, '');
  if (!s) return out;
  s.split('&').forEach(function (pair) {
    if (!pair) return;
    const i = pair.indexOf('=');
    const k = i < 0 ? pair : pair.slice(0, i);
    let v = i < 0 ? '' : pair.slice(i + 1);
    try { v = decodeURIComponent(v); } catch (e) { }
    out[k.toLowerCase()] = v;
  });
  return out;
}

// Сборка transport по параметрам ссылки. ВСЕГДА возвращает объект с ОДНИМ
// ключом либо null (когда транспорт по умолчанию — голый TCP без TLS).
function buildTransport(params, server) {
  const type = (params.type || 'tcp').toLowerCase();
  const sec = (params.security || '').toLowerCase();
  const sni = params.sni || params.host || '';
  const hostHdr = params.host || sni || '';
  const tlsLike = (sec === 'tls' || sec === 'reality');

  if (type === 'ws') {
    const w = { path: params.path || '/' };
    if (hostHdr) w.headers = { Host: hostHdr };
    if (!tlsLike) return { ws: w };          // WebSocket без TLS
    if (sni) w.sni = sni;
    return { wss: w };                       // WebSocket поверх TLS
  }

  if (type === 'grpc') {
    const g = {};
    if (params.servicename) g.service_name = params.servicename;
    if (sni) g.sni = sni;
    return { grpc: g };                      // TLS внутри grpc всегда
  }

  if (sec === 'reality') {
    const tls = {};
    if (sni) tls.sni = sni;
    const reality = {};
    if (params.pbk) reality.public_key = params.pbk;
    if (params.sid) reality.short_id = params.sid;
    tls.reality = reality;                   // reality ВНУТРИ tls
    return { tls: tls };
  }

  if (sec === 'tls') return { tls: { sni: sni || server } };

  return null;
}

// Разбор одной строки vless://uuid@host:port?params#name.
// URL() не используется: схема нестандартная, а имя после '#' бывает
// percent-encoded НЕПОСЛЕДОВАТЕЛЬНО (вывод 25 в СТАРТ.md).
export function parseVless(line, forcedName) {
  const s = String(line || '').trim();
  if (s.indexOf('vless://') !== 0) return null;
  const rest = s.slice(8);
  const hash = rest.indexOf('#');
  const body = hash < 0 ? rest : rest.slice(0, hash);
  let label = hash < 0 ? '' : rest.slice(hash + 1);
  try { label = decodeURIComponent(label); } catch (e) { }

  const at = body.lastIndexOf('@');
  if (at < 0) return null;
  const uuid = body.slice(0, at);
  let hostPart = body.slice(at + 1);
  let params = {};
  const q = hostPart.indexOf('?');
  if (q >= 0) { params = qs(hostPart.slice(q)); hostPart = hostPart.slice(0, q); }
  const colon = hostPart.lastIndexOf(':');
  if (colon < 0) return null;
  const server = hostPart.slice(0, colon).replace(/^[[]|[\]]$/g, '');
  const port = parseInt(hostPart.slice(colon + 1), 10);
  if (!uuid || !server || !port) return null;

  const node = { name: forcedName || label || (server + ':' + port), server: server, port: port, user_id: uuid };
  if (params.flow === 'xtls-rprx-vision') node.flow = 'xtls-rprx-vision';

  const transport = buildTransport(params, server);
  if (transport) node.transport = transport;

  const type = (params.type || 'tcp').toLowerCase();
  const sec = (params.security || '').toLowerCase();
  // Служебные поля для отчётности; в YAML не попадают.
  return {
    node: node,
    meta: {
      label: label, type: type, security: sec || 'none',
      transport: transport ? Object.keys(transport)[0] : 'raw'
    }
  };
}

// Первые N ОБЫЧНЫХ узлов, разобранных в форму proxies.
// ФАКТ (2026-08-09, сверено с sub_cache): ОБЫЧНЫХ ws-узлов в подписке НЕТ —
//   все 17 ws являются обходными. Поэтому отбор всегда даёт tcp-узлы, и
//   разбор ws-транспорта этой функцией НЕ проверяется. Проверка ws вынесена
//   в bypassWsNode() — см. ниже.
export function explicitNodes(text, limit) {
  const max = limit || 3;
  const lines = String(text || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const l = lines[i].trim();
    if (l.indexOf('vless://') !== 0) continue;
    const p = parseVless(l);
    if (!p) continue;
    if (/Обход/.test(p.meta.label)) continue;
    const name = 'RH-Явный-' + (out.length + 1);
    out.push({
      node: Object.assign({}, p.node, { name: name }),
      meta: Object.assign({ name: name }, p.meta)
    });
  }
  return out;
}

// ОДИН обходной ws-узел — единственный способ проверить разбор ws-транспорта,
// поскольку обычных ws-узлов в подписке нет. Трафик обходных узлов ПЛАТНЫЙ,
// поэтому через него допускается РОВНО ОДИН запрос generate_204 (шаг W4
// ревизии k4-9), и узел кладётся в select-группу: у select нет interval,
// то есть фонового теста задержки по расписанию не будет.
export function bypassWsNode(text, forcedName) {
  const name = forcedName || 'RH-Явный-WS';
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.indexOf('vless://') !== 0) continue;
    const p = parseVless(l);
    if (!p) continue;
    if (!/Обход/.test(p.meta.label)) continue;
    if (p.meta.type !== 'ws') continue;
    return {
      node: Object.assign({}, p.node, { name: name }),
      meta: Object.assign({ name: name }, p.meta)
    };
  }
  return null;
}

// ХВОСТОВОЙ СТРАЖ — строка без перевода в конце файла; мусор после неё —