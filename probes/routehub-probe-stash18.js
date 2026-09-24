/*
 * RouteHub — ПРОБА STASH ST18. Один вопрос.
 * ===========================================================================
 * ВОПРОС: может ли скрипт на стенде Stash НА САМОМ ДЕЛЕ переключить узел в
 * группе через контроллер (`PUT /proxies/{группа}`), и что при этом видно
 * скрипту — чтобы на этом строить управление узлами из скрипта и панели.
 *
 * ПОЧЕМУ ЭТО НЕ ПОВТОР ST5. ST3–ST5 получили на PUT ответ 204, но в группе
 * `RH-Проба` был ОДИН член (DIRECT), то есть выбор был холостым: 204 не
 * доказывает, что `now` меняется. Не проверялось и то, что нужно панели:
 *   1. меняется ли `now` при выборе ДРУГОГО члена;
 *   2. проходит ли имя члена кириллицей в теле запроса;
 *   3. что отвечает контроллер на несуществующее имя и не сбивает ли выбор;
 *   4. возвращается ли исходный выбор (панель обязана уметь откатить);
 *   5. можно ли закрепить член группы типа `fallback`. Узлы стенда живут
 *      ИМЕННО в fallback-группах RH-X-W / RH-X-C (ADR-02, вариант В). Если
 *      Stash ответит «только Selector», управление узлами потребует другой
 *      схемы групп, и знать это надо до техзадания панели. Цель закрепления
 *      — заведомо здоровый член (`RH-Тест-Прямо`, select из одного DIRECT):
 *      с REJECT отказ «закрепить нельзя» был бы неотличим от «нездоровый
 *      член пропущен» (замечание ревью);
 *   5а. как снять закрепление: `DELETE /proxies/{группа}` (так у mihomo; у
 *      Stash не проверено) и что показывает поле `fixed`. Возврат через PUT
 *      может оставить группу закреплённой на исходном члене, а не вернуть
 *      автоматический выбор — для панели это разные вещи;
 *   6. каким типом контроллер показывает группу RH-AI (select + ssid-policy)
 *      — только чтение.
 *
 * РЕШЕНИЕ ДИАНЫ 24.09: управление узлами на стенде Stash разрешено (скрипт и
 * панель могут менять выбор через контроллер, обход — только последним
 * резервом). Начать — с тестовой группы.
 *
 * ПРАВИЛО 2 НЕ ЗАДЕТО. Писать можно ТОЛЬКО в две тестовые группы, которые
 * добавляет override `RouteHub-Stash-ST18.stoverride`: `RH-Тест-Выбор`
 * (select) и `RH-Тест-Резерв` (fallback), плюс служебная `RH-Тест-Прямо`
 * (select из одного DIRECT, в неё проба не пишет). Ни одно правило на них не
 * ведёт, члены — только DIRECT, REJECT и они сами, то есть трафик через них не идёт
 * вовсе и боевую маршрутизацию стенда выбор в них не меняет. Запрет записи
 * в любую другую группу стоит в самом коде (`write`), а не только в описании.
 * Исходный выбор проба возвращает сама, даже если время на исходе.
 *
 * ПРАВИЛО 1 НЕ ЗАДЕТО: узлов в тестовых группах нет, ни одного запроса
 * через узлы проба не делает — только к локальному контроллеру телефона.
 *
 * СЕКРЕТ контроллера (`controller-authorization`) уходит только в заголовок
 * запроса к 127.0.0.1 и в выгрузку не кладётся.
 *
 * ВРЕМЯ. У Stash `$httpClient` timeout — в СЕКУНДАХ. Шаг начинается, только
 * если до конца бюджета хватит на ВСЮ его цепочку вместе с откатом, по 6 с на
 * запрос (`room(n)`, n — число запросов цепочки); откат, раз начатый шаг его
 * включает, до конца бюджета укладывается. Три начальных чтения — до 15 с,
 * меньше бюджета. Значит худший честный путь не длиннее бюджета 45 с. Сторож
 * — 75 с, а в фоне `setTimeout` растягивается только в большую сторону;
 * `timeout` cron в override — 300 с, чтобы растянутый сторож успел.
 */

var REV = 'ST18';
var T0 = Date.now();

var BUDGET_MS = 45000;
var GUARD_MS = 75000;
var CTRL_SEC = 5;                   // Stash: секунды, не миллисекунды
var STEP_MS = (CTRL_SEC + 1) * 1000; // сколько закладываем на один запрос

var SEL = 'RH-Тест-Выбор';           // select: DIRECT, REJECT, RH-Тест-Резерв
var FB = 'RH-Тест-Резерв';           // fallback: DIRECT, RH-Тест-Прямо
var PIN = 'RH-Тест-Прямо';           // select: DIRECT — здоровый член, не пишем
var REAL = 'RH-AI';                  // боевая группа стенда — ТОЛЬКО чтение
var GHOST = 'нет такого узла 🇩🇪 · ST18';

// Единственные группы, куда разрешена запись. Проверяется в write().
var WRITABLE = {};
WRITABLE[SEL] = 1;
WRITABLE[FB] = 1;

var rep = { rev: REV, ts: new Date().toISOString(), ans: {}, шаги: [], err: [] };
var G = (typeof globalThis !== 'undefined') ? globalThis : this;

var CTRL = 'http://127.0.0.1:9090', AUTH = '';
try {
  CTRL = ($environment && $environment['controller-url']) || CTRL;
  AUTH = ($environment && $environment['controller-authorization']) || '';
  rep.ans.stash = ($environment && $environment['stash-version']) || '?';
} catch (e) { rep.err.push('нет $environment'); }
CTRL = String(CTRL).replace(/\/+$/, '');

var FINISHED = false, GUARD = null;
function left() { return BUDGET_MS - (Date.now() - T0); }
// Хватит ли времени на цепочку шага из n запросов, включая откат.
function room(n) { return left() > STEP_MS * n; }

function req(method, path, body, cb) {
  var o = { url: CTRL + path, timeout: CTRL_SEC, headers: {} };
  if (AUTH) o.headers.Authorization = AUTH;
  if (body !== null && body !== undefined) {
    o.headers['Content-Type'] = 'application/json';
    o.body = JSON.stringify(body);
  }
  var t = Date.now(), done = false;
  function once(r) { if (done) return; done = true; r.ms = Date.now() - t; cb(r); }
  try {
    G.$httpClient[method](o, function (e, r, data) {
      var st = r ? (r.status || r.statusCode || null) : null;
      once({ status: st, error: e ? String(e) : null, body: data ? String(data).slice(0, 300) : '' });
    });
  } catch (e2) { once({ status: null, error: 'throw: ' + String(e2), body: '' }); }
}

function path(group) { return '/proxies/' + encodeURIComponent(group); }

// Чтение группы: { now, type, all, fixed, keys } или null с причиной.
// `fixed` — закреплённый член у fallback в mihomo; нет поля — undefined.
function look(group, label, cb) {
  req('get', path(group), null, function (r) {
    var g = null;
    if (r.status === 200) {
      try {
        var j = JSON.parse(r.body || '{}');
        if (j && typeof j.now === 'string' && Object.prototype.toString.call(j.all) === '[object Array]') {
          g = { now: j.now, type: j.type || '?', all: j.all, fixed: j.fixed, keys: Object.keys(j).sort() };
        }
      } catch (e) {}
    }
    rep.шаги.push({ шаг: label, метод: 'GET', группа: group, код: r.status, мс: r.ms,
      now: g ? g.now : null, ошибка: r.error || (g ? null : ('не группа: ' + r.body.slice(0, 80))) });
    cb(g, r);
  });
}

// Запись. ЕДИНСТВЕННОЕ место, где проба пишет в контроллер: PUT — выбор
// члена, DELETE — снятие закрепления.
function write(method, group, name, label, cb) {
  if (!WRITABLE.hasOwnProperty(group)) {
    rep.err.push('запись вне тестовой группы запрещена: ' + group);
    cb({ status: null, error: 'отказ пробы', body: '', ms: 0 });
    return;
  }
  req(method, path(group), method === 'put' ? { name: name } : null, function (r) {
    rep.шаги.push({ шаг: label, метод: method.toUpperCase(), группа: group, выбор: name, код: r.status,
      мс: r.ms, ответ: r.body || null, ошибка: r.error });
    cb(r);
  });
}
function put(group, name, label, cb) { write('put', group, name, label, cb); }

function has(g, name) {
  for (var i = 0; i < g.all.length; i++) if (g.all[i] === name) return true;
  return false;
}

var A = rep.ans;
var selBefore = null, fbBefore = null;
var selMoved = false, fbMoved = false; // выбор могли сдвинуть — нужен откат

// ── ШАГИ ────────────────────────────────────────────────────────────────
// ПОСЛЕ СТОРОЖА новых записей нет: запоздалый ответ контроллера не должен
// продолжать пробу, отчёт по которой уже отдан. Разрешён только откат —
// выбор, возможно, уже сдвинут, и вернуть его лучше молча, чем не вернуть.
function s1() {
  look(SEL, 'исходно', function (g, r) {
    selBefore = g;
    if (!g) {
      // 404 — группы нет; любой другой исход — контроллер, а не override.
      A.ВЕРДИКТ = r.status === 404
        ? 'ТЕСТОВОЙ ГРУППЫ ' + SEL + ' НЕТ (404) — override ST18 не применился ' +
          '(или Stash не принимает proxy-groups в override). Ничего не записано'
        : 'КОНТРОЛЛЕР НЕ ОТДАЛ ГРУППУ ' + SEL + ': ' + (r.status || r.error || 'нет ответа') +
          (r.body ? ' ' + r.body.slice(0, 80) : '') + '. Ничего не записано';
      return finish();
    }
    A.тестовая_группа = { тип: g.type, члены: g.all, выбор: g.now };
    look(FB, 'исходно', function (f) {
      fbBefore = f;
      if (f) A.резервная_группа = { тип: f.type, члены: f.all, выбор: f.now };
      look(REAL, 'чтение', function (b) {
        A.боевая_RH_AI = b ? { тип: b.type, выбор: b.now } : 'не прочитана';
        s2();
      });
    });
  });
}

// 1. Другой член группы: меняется ли `now`.
function s2() {
  if (FINISHED) return restoreSel();
  // put, get + откат put, get
  if (!room(4)) { rep.err.push('бюджет: шаг «другой член» пропущен'); return restoreSel(); }
  var target = selBefore.now === 'REJECT' ? 'DIRECT' : 'REJECT';
  selMoved = true;
  put(SEL, target, 'другой член', function (p) {
    look(SEL, 'после выбора', function (g) {
      A.выбор = { код: p.status, мс: p.ms, ждали: target, стало: g ? g.now : null,
        сработал: !!(g && g.now === target) };
      s3();
    });
  });
}

// 2. Имя кириллицей в теле: член — сама резервная группа.
function s3() {
  if (FINISHED) return restoreSel();
  // put, get + откат put, get
  if (!room(4) || !has(selBefore, FB)) {
    if (!has(selBefore, FB)) A.кириллица = 'в группе нет члена ' + FB;
    return s4();
  }
  put(SEL, FB, 'имя кириллицей', function (p) {
    look(SEL, 'после кириллицы', function (g) {
      A.кириллица = { код: p.status, стало: g ? g.now : null, сработал: !!(g && g.now === FB) };
      s4();
    });
  });
}

// 3. Несуществующее имя: код ответа и не сбит ли выбор.
function s4() {
  if (FINISHED) return restoreSel();
  // get, put, get + откат put, get
  if (!room(5)) { rep.err.push('бюджет: шаг «чужое имя» пропущен'); return restoreSel(); }
  look(SEL, 'перед чужим именем', function (g0) {
    if (FINISHED) return restoreSel();
    var was = g0 ? g0.now : null;
    put(SEL, GHOST, 'чужое имя', function (p) {
      look(SEL, 'после чужого имени', function (g) {
        A.чужое_имя = { код: p.status, ответ: p.body || null, было: was, стало: g ? g.now : null,
          выбор_не_сбит: !!(g && g.now === was) };
        restoreSel();
      });
    });
  });
}

// 4. Откат тестовой группы. Начинается ВСЕГДА, если выбор могли сдвинуть.
function restoreSel() {
  if (!selMoved) return s5();
  put(SEL, selBefore.now, 'откат', function (p) {
    look(SEL, 'после отката', function (g) {
      A.откат = { код: p.status, вернули: selBefore.now, стало: g ? g.now : null,
        сработал: !!(g && g.now === selBefore.now) };
      if (A.откат.сработал) selMoved = false;
      s5();
    });
  });
}

// 5. Fallback: можно ли закрепить член. Узлы стенда живут в fallback-группах.
function s5() {
  if (FINISHED) return;
  if (!fbBefore) { A.fallback = 'группы ' + FB + ' нет'; return finish(); }
  // put, get + снятие delete, get + возврат put, get
  if (!room(6)) { rep.err.push('бюджет: шаг «fallback» пропущен'); return finish(); }
  if (!has(fbBefore, PIN)) { A.fallback = 'в группе нет члена ' + PIN; return finish(); }
  var target = fbBefore.now === PIN ? 'DIRECT' : PIN;
  fbMoved = true;
  put(FB, target, 'закрепить fallback', function (p) {
    look(FB, 'после закрепления', function (g) {
      A.fallback = { код: p.status, ответ: p.body || null, ждали: target, стало: g ? g.now : null,
        закрепился: !!(g && g.now === target), fixed: g ? g.fixed : null, поля: g ? g.keys : null };
      // Выбор точно не сдвинут и не закреплён — откатывать нечего. Если
      // группу после записи прочитать не удалось, сдвиг возможен: откат.
      if (g && g.now === fbBefore.now && !g.fixed) { fbMoved = false; return finish(); }
      restoreFb();
    });
  });
}

// Откат fallback: сначала снять закрепление (вернуть автоматический выбор),
// не вышло — вернуть исходный член через PUT.
function restoreFb() {
  write('delete', FB, null, 'снять закрепление', function (d) {
    look(FB, 'после снятия', function (g) {
      A.снятие = { код: d.status, ответ: d.body || d.error || null, стало: g ? g.now : null,
        fixed: g ? g.fixed : null, сработало: !!(g && g.now === fbBefore.now && !g.fixed) };
      if (A.снятие.сработало) { fbMoved = false; return finish(); }
      put(FB, fbBefore.now, 'откат fallback', function (p) {
        look(FB, 'после отката fallback', function (g2) {
          A.откат_fallback = { код: p.status, вернули: fbBefore.now, стало: g2 ? g2.now : null,
            fixed: g2 ? g2.fixed : null, сработал: !!(g2 && g2.now === fbBefore.now) };
          if (A.откат_fallback.сработал) fbMoved = false;
          finish();
        });
      });
    });
  });
}

// ── ВЫВОД ───────────────────────────────────────────────────────────────
function ok2xx(c) { return typeof c === 'number' && c >= 200 && c < 300; }

function finish() {
  if (FINISHED) return;
  FINISHED = true;
  try { clearTimeout(GUARD); } catch (e) {}
  var lines, color = '#FF9F0A';
  try {
    var v = A.выбор, fb = A.fallback;
    if (!A.ВЕРДИКТ) {
      if (v && v.сработал) {
        A.ВЕРДИКТ = 'ВЫБОР ИЗ СКРИПТА РАБОТАЕТ: PUT ' + v.код + ', выбор сменился на ' + v.ждали +
          ' за ' + v.мс + ' мс';
        color = '#34C759';
      } else if (v) {
        A.ВЕРДИКТ = 'НЕ ПЕРЕКЛЮЧАЕТ: PUT ' + (v.код || v.ошибка || '—') + ', выбор ' + (v.стало || '?') +
          ' вместо ' + v.ждали;
        color = '#FF3B30';
      } else {
        A.ВЕРДИКТ = 'ПЕРЕКЛЮЧЕНИЕ НЕ ПРОВЕРЕНО: ' + (rep.err.join('; ') || 'цепочка не дошла');
      }
    }
    if (selMoved || fbMoved) {
      A.ВНИМАНИЕ = 'откат не подтверждён: ' + (selMoved ? SEL + ' ' : '') + (fbMoved ? FB : '') +
        ' — трафика там нет, но выбор стоит проверить на экране Stash';
      color = '#FF3B30';
    }
    var fbLine = 'fallback: ';
    if (typeof fb === 'string') fbLine += fb;
    else if (fb && fb.закрепился) {
      var sn = A.снятие, fo = A.откат_fallback;
      fbLine += 'ЗАКРЕПЛЯЕТСЯ (PUT ' + fb.код + (fb.fixed ? ', fixed=' + fb.fixed : '') + ')';
      if (sn && sn.сработало) fbLine += '; DELETE ' + sn.код + ' снимает закрепление';
      else if (sn) fbLine += '; DELETE ' + (sn.код || sn.ответ || '—') + ' не снял';
      if (fo) fbLine += '; возврат PUT: ' + (fo.сработал ? fo.вернули : 'НЕТ') +
        (fo.fixed ? ' (осталась закреплённой: ' + fo.fixed + ')' : '');
    }
    else if (fb && ok2xx(fb.код)) fbLine += 'PUT ' + fb.код + ', но выбор не сменился — ведёт сама группа';
    else if (fb) fbLine += 'НЕ ЗАКРЕПЛЯЕТСЯ: PUT ' + (fb.код || '—') + (fb.ответ ? ' ' + fb.ответ : '');
    else fbLine += 'не проверен';
    var k = A.кириллица, gh = A.чужое_имя, ro = A.откат;
    rep.ms = Date.now() - T0;
    lines = [
      A.ВЕРДИКТ,
      A.ВНИМАНИЕ || '',
      fbLine,
      'кириллица в имени: ' + (typeof k === 'string' ? k : (k ? (k.сработал ? 'да' : 'нет') + ' (PUT ' + k.код + ')' : '—')),
      'чужое имя: ' + (gh ? 'PUT ' + gh.код + (gh.ответ ? ' ' + gh.ответ : '') +
        (gh.выбор_не_сбит ? ', выбор не сбит' : ', ВЫБОР СБИТ: ' + gh.стало) : '—'),
      'откат: ' + (ro ? (ro.сработал ? 'да' : 'НЕТ') + ' (' + ro.вернули + ')' : '—'),
      'RH-AI (чтение): ' + JSON.stringify(A.боевая_RH_AI || '—'),
      'Stash ' + (A.stash || '?') + ', ' + rep.ms + ' мс' + (rep.err.length ? ' · ' + rep.err.join('; ') : '')
    ];
    var clean = [];
    for (var i = 0; i < lines.length; i++) if (lines[i]) clean.push(lines[i]);
    lines = clean;
  } catch (e0) {
    rep.err.push('сборка вывода упала: ' + String(e0));
    lines = ['СБОЙ ПРОБЫ: ' + String(e0)];
    color = '#FF3B30';
  }
  try { console.log('[' + REV + '] ' + JSON.stringify(rep)); } catch (e2) {}
  try {
    $notification.post('RouteHub ' + REV, lines[0], lines.slice(1).join('\n'),
      { clipboard: JSON.stringify(rep) });
  } catch (e3) {}
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'),
            icon: 'switch.2', backgroundColor: color });
  } catch (e4) { try { $done(); } catch (e5) {} }
}

GUARD = setTimeout(function () {
  if (!FINISHED) { rep.err.push('сторож: цепочка не завершилась'); finish(); }
}, GUARD_MS);

if (typeof G.$httpClient === 'undefined') {
  rep.err.push('нет $httpClient');
  finish();
} else {
  s1();
}
// конец файла — хвостовой страж (вывод 49)
