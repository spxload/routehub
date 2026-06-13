// =============================================================
// routehub-test-T6.js v0.1.0 — РАЗОВЫЙ тест T6 (узел в $httpClient).
// Тип: generic (ручной запуск из UI Loon). После теста — удалить из Loon.
//
// ВОПРОС: маршрутизирует ли $httpClient по node, если node = ИМЯ
//   КОНКРЕТНОГО УЗЛА из подписки (не группы)? T1 пробовал ИМЕНА ГРУПП и
//   получил один IP. T6 проверяет имена УЗЛОВ + замеряет реальную скорость:
//   если node работает, разные узлы дадут РАЗНЫЕ IP и РАЗНУЮ скорость.
//
// МЕТОД:
//   1. Берём список узлов группы RH-АВТО-W ($config.getSubPolicies).
//   2. Выбираем до 4 узлов: первый, второй, предпоследний, последний
//      (порядок = балл; первый ~ быстрый, последний ~ медленный/мёртвый).
//   3. Для каждого: эхо IP (api.ipify.org) + скорость (1 МБ с Cloudflare).
//   4. Сравниваем. Плюс контроль: node=DIRECT и node без указания.
//
// ИНТЕРПРЕТАЦИЯ:
//   IP/скорость РАЗЛИЧАЮТСЯ между узлами -> node РАБОТАЕТ для имён узлов.
//     Значит спидтест ДОСТОВЕРЕН, rkn-детект валиден. T1 ловил то, что
//     имена ГРУПП не маршрутизируются (а узлов — да), либо обход был общим.
//   IP/скорость ОДИНАКОВЫ у всех -> node ИГНОРИРУЕТСЯ и для узлов.
//     Тогда спидтест меряет ОДИН канал под всеми именами -> метрики
//     узлов недостоверны, нужна переработка (т.е. узлы неразличимы с
//     устройства, балльность узлов теряет смысл).
//
// Запусти на Wi-Fi. Результат — в пуше и в логе Loon (метка [T6]).
// =============================================================

var POOL = 'RH-\u0410\u0412\u0422\u041E-W';   // RH-АВТО-W
var IP_URL = 'https://api.ipify.org';
var DOWN_URL = 'https://speed.cloudflare.com/__down?bytes=1000000'; // 1 МБ
var METRIC_SEP = ' \u00B7 ';
var out = [];

function log(s) { out.push(s); console.log('[T6] ' + s); }
function baseName(n) { var i = n.indexOf(METRIC_SEP); return (i >= 0 ? n.slice(0, i) : n).trim(); }
function nameOf(el) {
  if (typeof el === 'string') return el;
  if (el && typeof el === 'object') return el.name || el.policy || el.policyName || el.title || el.tag || '';
  return '';
}
function looksLikeNode(n) { return typeof n === 'string' && n.length >= 5 && n.indexOf('[') >= 0; }

// один замер: IP + скорость через указанный node
function probe(label, node, cb) {
  var ipSeen = '';
  $httpClient.get({ url: IP_URL, node: node || undefined, timeout: 8000 }, function (e1, r1, d1) {
    if (!e1 && d1) ipSeen = String(d1).trim();
    var t0 = Date.now();
    $httpClient.get({ url: DOWN_URL + '&t=' + Date.now(), node: node || undefined, timeout: 20000 }, function (e2, r2) {
      var line;
      if (e2 || !r2 || r2.status !== 200) {
        line = label + ': ip=' + (ipSeen || '?') + ' скорость=FAIL';
      } else {
        var sec = (Date.now() - t0) / 1000;
        var mbps = sec > 0 ? Math.round((1000000 * 8 / 1e6) / sec) : 0;
        line = label + ': ip=' + (ipSeen || '?') + ' скорость=' + mbps + ' Мбит (' + sec.toFixed(1) + ' с)';
      }
      log(line);
      cb();
    });
  });
}

function runAll(targets) {
  var i = 0;
  function next() {
    if (i >= targets.length) {
      $notification.post('RouteHub T6', 'node = имя узла?', out.join('\n'));
      console.log('[T6] ГОТОВО:\n' + out.join('\n'));
      $done();
      return;
    }
    var t = targets[i]; i++;
    probe(t.label, t.node, next);
  }
  next();
}

$config.getSubPolicies(POOL, function (subs) {
  var arr = subs;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { arr = []; } }
  var nodes = [];
  if (Array.isArray(arr)) {
    for (var k = 0; k < arr.length; k++) {
      var nm = nameOf(arr[k]);
      if (looksLikeNode(nm) && nm.indexOf('[\u041E\u0431\u0445\u043E\u0434') < 0) nodes.push(nm);
    }
  }
  log('узлов в пуле ' + POOL + ': ' + nodes.length);

  var targets = [];
  if (nodes.length >= 1) targets.push({ label: 'U1 первый [' + baseName(nodes[0]) + ']', node: nodes[0] });
  if (nodes.length >= 2) targets.push({ label: 'U2 второй [' + baseName(nodes[1]) + ']', node: nodes[1] });
  if (nodes.length >= 4) targets.push({ label: 'U3 предпосл. [' + baseName(nodes[nodes.length - 2]) + ']', node: nodes[nodes.length - 2] });
  if (nodes.length >= 3) targets.push({ label: 'U4 последний [' + baseName(nodes[nodes.length - 1]) + ']', node: nodes[nodes.length - 1] });
  targets.push({ label: 'C1 DIRECT', node: 'DIRECT' });
  targets.push({ label: 'C2 без node', node: null });

  if (!nodes.length) {
    log('ПУЛ ПУСТ — getSubPolicies не вернул узлы. Проверь имя группы/доступность подписки.');
    $notification.post('RouteHub T6', 'пул пуст', out.join('\n'));
    console.log('[T6] ГОТОВО:\n' + out.join('\n'));
    $done();
    return;
  }
  runAll(targets);
});
