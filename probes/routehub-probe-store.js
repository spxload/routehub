/*
 * routehub-probe-store.js — проба L11 «хранилище устройства»
 * ------------------------------------------------------------------
 * ЗАЧЕМ. Срез D1 от 2026-08-16 показал, что у ключей k1 и k2 совпадает
 * `nonce` (`mso43tccji0ey07v`), а сотовый блок метрик совпадает у всех
 * 50 узлов при полностью различающемся блоке Wi-Fi. Единственное
 * непротиворечивое объяснение: на второй телефон перенесена копия
 * хранилища Loon вместе с нонсом и кэшем сотовых замеров. Гипотеза
 * проверяется одним способом — посмотреть `rh_nonce` на каждом телефоне.
 * Из облака этого не видно, из интерфейса Loon тоже: проба закрывает
 * пробел, не требуя ни ноутбука, ни доступа к файловой системе.
 *
 * ЧТО ДЕЛАЕТ (по умолчанию ТОЛЬКО ЧТЕНИЕ):
 *   1. Читает ключи спидтеста в $persistentStore: nonce, кэши замеров
 *      Wi-Fi и сотовой, журнал запусков, замок, счётчик свипа.
 *   2. По кэшам считает: сколько узлов, когда последний раз обновлялись,
 *      сколько записей с меткой времени и какая самая свежая.
 *   3. По журналу запусков (`rh_runlog`) — когда был последний свип,
 *      в какой сети, сколько узлов ушло на сервер.
 *   4. Складывает сводку в уведомление, полный JSON — в буфер обмена.
 *
 * СЕТЬ НЕ ТРОГАЕТ ВООБЩЕ: ни одного запроса, ни одного узла, ни байта
 * платного трафика. Боевую маршрутизацию не меняет — ни setSelectPolicy,
 * ни setRunningModel, ни правок конфига.
 *
 * РЕЖИМ ОЧИСТКИ — только по явному аргументу, отдельной кнопкой:
 *   argument=clear-nonce   стереть rh_nonce (устройство зарегистрируется
 *                          заново на следующем свипе)
 *   argument=clear-cell    стереть кэш сотовых замеров rh_speed_cell
 *   argument=clear-both    и то, и другое
 * Аргумент читается строго; любое другое значение = режим чтения.
 * Очистка касается ТОЛЬКО ключей нашего же спидтеста и не затрагивает
 * ни конфиг, ни политики, ни данные других скриптов.
 *
 * ПОДКЛЮЧЕНИЕ (раздел [Script] локального конфига):
 * generic script-path=probes/routehub-probe-store.js, tag=RH-L11, timeout=20, enable=true
 * generic script-path=probes/routehub-probe-store.js, tag=RH-L11-CLEAR, argument=clear-both, timeout=20, enable=true
 *
 * ЗАЧЕМ ДВЕ КНОПКИ: чтение должно быть безопасным по построению.
 * Кнопка очистки заведомо отдельная, чтобы её нельзя было нажать
 * случайно вместо диагностики.
 */

const REV = 'L11';

// Ключи, которые ведёт routehub-speedtest.js (см. его шапку, строки 64–68).
const K_NONCE = 'rh_nonce';
const K_WIFI = 'rh_speed_wifi';
const K_CELL = 'rh_speed_cell';
const K_RUNLOG = 'rh_runlog';
const K_LOCK = 'rh_speed_lock';
const K_CATCHUP = 'rh_catchup';
const K_SWEEP_IDX = 'rh_sweep_idx';

function readRaw(key) {
  try { return $persistentStore.read(key); } catch (e) { return null; }
}
function readJSON(key) {
  const s = readRaw(key);
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return { __битый: true, __длина: s.length }; }
}
function ago(ms) {
  if (!ms) return null;
  const d = Date.now() - ms;
  if (d < 0) return 'в будущем';
  const m = Math.round(d / 60000);
  if (m < 60) return m + ' мин назад';
  const h = Math.floor(m / 60);
  if (h < 48) return h + ' ч ' + (m % 60) + ' мин назад';
  return Math.floor(h / 24) + ' сут назад';
}

// Кэш замеров: объект «имя узла -> запись». Формат записи задаёт спидтест,
// поэтому отметку времени ищем по нескольким возможным полям и честно
// сообщаем, если её нет вовсе.
function digest(obj) {
  if (!obj) return { есть: false };
  if (obj.__битый) return { есть: true, битый: true, длина: obj.__длина };
  const names = Object.keys(obj);
  let withTs = 0, newest = 0, oldest = 0;
  for (const n of names) {
    const v = obj[n];
    if (!v || typeof v !== 'object') continue;
    const t = v.ts || v.t || v.time || 0;
    if (t) {
      withTs++;
      if (t > newest) newest = t;
      if (!oldest || t < oldest) oldest = t;
    }
  }
  return {
    есть: true,
    узлов: names.length,
    'с отметкой времени': withTs,
    'самая свежая': newest ? ago(newest) : 'отметок времени нет',
    'самая старая': oldest ? ago(oldest) : null,
    'первые имена': names.slice(0, 3),
  };
}

(async function () {
  const arg = (typeof $argument === 'string') ? $argument.trim() : '';
  const doNonce = (arg === 'clear-nonce' || arg === 'clear-both');
  const doCell = (arg === 'clear-cell' || arg === 'clear-both');
  const clearing = doNonce || doCell;

  const nonce = readRaw(K_NONCE);
  const wifi = readJSON(K_WIFI);
  const cell = readJSON(K_CELL);
  const runlog = readJSON(K_RUNLOG);
  const lock = readRaw(K_LOCK);
  const catchup = readRaw(K_CATCHUP);
  const sweepIdx = readRaw(K_SWEEP_IDX);

  // Нонс генерируется как Date.now().toString(36) + 8 случайных символов
  // (routehub-speedtest.js, строка 158). Первые 8 символов раскручиваются
  // обратно во время создания — это и отвечает на вопрос «нонс родной или
  // приехал с копией хранилища другого телефона».
  let nonceBorn = null;
  if (nonce && nonce.length >= 8) {
    const t = parseInt(nonce.slice(0, 8), 36);
    if (isFinite(t) && t > 1500000000000 && t < Date.now() + 86400000) {
      nonceBorn = new Date(t).toISOString();
    }
  }

  const last = (Array.isArray(runlog) && runlog.length) ? runlog[runlog.length - 1] : null;

  const rep = {
    rev: REV,
    ts: new Date().toISOString(),
    режим: clearing ? 'ОЧИСТКА' : 'чтение',
    nonce: nonce || null,
    'nonce создан': nonceBorn,
    'nonce длина': nonce ? nonce.length : 0,
    'кэш Wi-Fi': digest(wifi),
    'кэш сотовой': digest(cell),
    'последний свип': last ? {
      сеть: last.n || null,
      пул: last.p != null ? last.p : null,
      'к отправке': last.d != null ? last.d : null,
      успешных: last.m != null ? last.m : null,
      неудачных: last.f != null ? last.f : null,
      когда: ago(last.t),
    } : null,
    'записей в журнале': Array.isArray(runlog) ? runlog.length : 0,
    'замок занят': !!(lock && lock.length),
    догон: catchup === '1',
    'индекс свипа': sweepIdx || null,
  };

  if (clearing) {
    rep.очищено = [];
    if (doNonce) {
      try { $persistentStore.write('', K_NONCE); rep.очищено.push(K_NONCE); }
      catch (e) { rep.очищено.push(K_NONCE + ' — ОШИБКА: ' + e); }
    }
    if (doCell) {
      try { $persistentStore.write('', K_CELL); rep.очищено.push(K_CELL); }
      catch (e) { rep.очищено.push(K_CELL + ' — ОШИБКА: ' + e); }
    }
    rep.дальше = 'На следующем свипе спидтест создаст новый nonce. ' +
      'Если ключ на сервере остался bound со старым нонсом, придёт 409 ' +
      'и ключ уйдёт в conflict — тогда его надо отвязать в /admin.';
  }

  const lines = [];
  lines.push('nonce: ' + (nonce ? nonce : '— нет —'));
  if (nonceBorn) lines.push('создан: ' + nonceBorn.slice(0, 16).replace('T', ' '));
  lines.push('Wi-Fi кэш: ' + (rep['кэш Wi-Fi'].узлов != null ? rep['кэш Wi-Fi'].узлов + ' узлов' : 'пуст'));
  lines.push('сотовый кэш: ' + (rep['кэш сотовой'].узлов != null ? rep['кэш сотовой'].узлов + ' узлов' : 'пуст'));
  if (rep['последний свип']) {
    lines.push('свип: ' + rep['последний свип'].сеть + ', ' + rep['последний свип'].когда +
      ', успешных ' + rep['последний свип'].успешных);
  }
  if (clearing) lines.push('ОЧИЩЕНО: ' + rep.очищено.join(', '));

  $notification.post(
    'RouteHub ' + REV + (clearing ? ' — ОЧИСТКА' : ' — хранилище'),
    lines[0],
    lines.slice(1).join('\n'),
    { clipboard: JSON.stringify(rep) }
  );
  console.log('[' + REV + '] ' + JSON.stringify(rep));
  $done();
})();
