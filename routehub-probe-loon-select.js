// RouteHub — ПРОБА LOON. Ревизия L9: только текущий выбор политик.
// ЗАЧЕМ: сверить, ушли ли сотовые группы (RH-*-C) с платного обхода
// после правки тест-адреса (routehub.conf C-draft-40, worker v1.9.3).
//
// ТОЛЬКО ЧТЕНИЕ. Ни одного вызова setSelectPolicy / setPluginEnable /
// setScriptEnable / setRunningModel. Боевая маршрутизация не трогается.
//
// ТИП: generic — запуск вручную.
// ОТЧЁТ: короткая сводка по трём сотовым группам — прямо в уведомлении;
//        полная выдача — в буфер обмена и в консоль.

var REV = 'L9';
var G = (typeof globalThis !== 'undefined') ? globalThis : this;
var rep = { rev: REV, ts: new Date().toISOString(), errors: [] };

try {
  var raw = G.$config.getConfig();
  var cfg = (typeof raw === 'string') ? JSON.parse(raw) : raw;

  rep.policy_select = cfg.policy_select;
  rep.final = cfg.final;
  rep.running_model = cfg.running_model;
  rep.global_proxy = cfg.global_proxy;
  rep.ssid = cfg.ssid;

  // Имена групп — без их состава, чтобы отчёт остался коротким.
  try {
    var g = cfg.all_policy_groups;
    rep.group_names = (Object.prototype.toString.call(g) === '[object Array]')
      ? g.map(function (x) { return (typeof x === 'string') ? x : (x && (x.name || x.title)) || '?'; })
      : Object.keys(g || {});
  } catch (e) { rep.errors.push('group_names: ' + String(e)); }
} catch (e) {
  rep.errors.push('getConfig: ' + String((e && e.message) || e));
}

// Сводка: три сотовые группы. Имена не выдумываем — берём те,
// что записаны в СТАРТ.md, и помечаем отсутствующие.
var WATCH = ['RH-AI-C', 'RH-АВТО-C', 'RH-Звонки-C'];
var ps = rep.policy_select || {};
var lines = WATCH.map(function (n) {
  var v = ps[n];
  return n + ' = ' + (v === undefined ? 'НЕТ ГРУППЫ' : String(v));
});
var summary = lines.join('\n');

var body = JSON.stringify(rep);
try { console.log('[RH-' + REV + '] ' + body); } catch (e) {}
try {
  G.$notification.post('RouteHub ' + REV, summary,
    'полный отчёт в буфере обмена', { 'clipboard': body });
} catch (e) {
  try { G.$notification.post('RouteHub ' + REV, summary, 'см. консоль'); } catch (e2) {}
}
try { G.$done({}); } catch (e) {}
// конец файла
