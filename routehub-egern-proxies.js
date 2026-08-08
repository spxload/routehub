// =============================================================
// routehub-egern-proxies.js — разбор vless:// в форму proxies профиля Egern.
// Зачем: проверка k4-2 показала, что ctx.http принимает в policy только
//   имена ГРУПП и DIRECT; имя узла из подписки даёт 404 от самого Egern.
//   Гипотеза: узел, ОБЪЯВЛЕННЫЙ в proxies, имеет глобально уникальное имя
//   и становится адресуемой политикой. От этого зависит весь спидтест.
// Форма полей — по официальной документации /docs/configuration/proxies:
//   vless: name, server, port, user_id, flow, tfo, udp_relay, transport,
//          block_quic, prev_hop, ip_version.
//   transport: { tls: { sni }, reality: { public_key, short_id },
//                ws: { path, headers: { Host } } }.
//   fingerprint (fp в ссылке) в документации НЕ описан — не переносим.
// Имена объявленных узлов НЕ совпадают с именами из подписки (префикс
//   RH-Явный-N): документация говорит, что узлы подписки дедуплицируются
//   ПО ИМЕНИ — совпадение сделало бы результат проверки неоднозначным.
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

  const transport = {};
  const sec = (params.security || '').toLowerCase();
  const sni = params.sni || params.host || '';
  if (sec === 'reality') {
    if (sni) transport.tls = { sni: sni };
    const reality = {};
    if (params.pbk) reality.public_key = params.pbk;
    if (params.sid) reality.short_id = params.sid;
    transport.reality = reality;
  } else if (sec === 'tls') {
    transport.tls = { sni: sni || server };
  }
  const type = (params.type || 'tcp').toLowerCase();
  if (type === 'ws') {
    const ws = { path: params.path || '/' };
    const h = params.host || sni;
    if (h) ws.headers = { Host: h };
    transport.ws = ws;
  }
  if (Object.keys(transport).length) node.transport = transport;
  // Служебные поля для отчётности; в YAML не попадают.
  return { node: node, meta: { label: label, type: type, security: sec || 'none' } };
}

// Первые N ОБЫЧНЫХ узлов, разобранных в форму proxies. По возможности
// берётся хотя бы один ws-узел: в подписке 52 tcp и 17 ws, и транспорты
// надо проверить оба. Обходные исключены — трафик платный.
export function explicitNodes(text, limit) {
  const max = limit || 3;
  const lines = String(text || '').split('\n');
  const tcp = [], ws = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.indexOf('vless://') !== 0) continue;
    const p = parseVless(l);
    if (!p) continue;
    if (/Обход/.test(p.meta.label)) continue;
    (p.meta.type === 'ws' ? ws : tcp).push(p);
  }
  const picked = [];
  if (ws.length) picked.push(ws[0]);
  for (let i = 0; i < tcp.length && picked.length < max; i++) picked.push(tcp[i]);
  const out = [];
  for (let i = 0; i < picked.length && i < max; i++) {
    const name = 'RH-Явный-' + (i + 1);
    const n = Object.assign({}, picked[i].node, { name: name });
    out.push({ node: n, meta: Object.assign({ name: name }, picked[i].meta) });
  }
  return out;
}
