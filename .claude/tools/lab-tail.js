#!/usr/bin/env node
// Живой журнал опыта Lab для сессии Claude Code: хвост Worker'а стенда →
// короткие строки только о переменах.
//
// ЗАЧЕМ. Диана сидит в чате во время опыта; Claude должен видеть, что
// делает Stash, почти без задержки и спрашивать о причинах («сняли с
// зарядки?», «открыли Stash?»). Сырой хвост — ~15 событий в минуту: каждое
// будило бы сессию и ело контекст. Здесь наружу выходят только перемены.
//
// ЗАПУСК. Хвост заводится через Cloudflare MCP (сессия, не телефон):
//   POST /accounts/{id}/workers/scripts/routehub-stash/tails → result.url
//   (wss://tail.developers.workers.dev/<id>, живёт ~6 ч), затем
//   node .claude/tools/lab-tail.js <url>  — под инструментом Monitor.
// Из событий берутся только строки журнала с полем `lab` (JSON); адреса
// запросов, заголовки и прочее НЕ печатаются — в них бывают токены /t/….
//
// ЧТО ПЕЧАТАЕТ (время — МСК):
//   «ожила» — метка молчала ≥ WAKE_MIN мин (скачивание — ≥ WAKE_DL_MIN),
//             пока другие метки шли, и снова в журнале (или первая за
//             сеанс); повод спросить, не открыт ли Stash. После общей
//             паузы — только «пауза кончилась»;
//   «тишина» — нет ни одного события ≥ QUIET_MIN мин; «пауза кончилась» —
//             первое событие после тишины, с длительностью;
//   «окно»  — итог закрытого 10-минутного окна стенда: жизнь/смерть,
//             проверки по меткам, скачивания поставщиков;
//   «отчёт» — строка пробы `{"lab":"report",…}` как есть (сжатая);
//   «хвост закрыт» — сокет закрыт (истёк или сбой), код выхода 0.
'use strict';

const WAKE_MIN = Number(process.env.LAB_WAKE_MIN) || 5;
const QUIET_MIN = Number(process.env.LAB_QUIET_MIN) || 4;
// Поставщики качаются раз в ~5 мин (interval 300) и после паузы — всегда;
// «ожило» скачивание — только после долгого молчания.
const WAKE_DL_MIN = Number(process.env.LAB_WAKE_DL_MIN) || 15;
const WIN_MS = 600000;

const msk = (ms) => new Date(ms + 3 * 3600e3).toISOString().slice(11, 16);

function createState() {
  return { last: {}, lastAny: 0, quiet: false, pause: null, win: null, counts: {}, dl: {} };
}

// Разбор одного события хвоста: массив записей {ms, lab}. Всё, что не JSON
// с полем lab, отбрасывается.
function labEntries(ev) {
  const out = [];
  for (const l of (ev && ev.logs) || []) {
    for (const m of [].concat(l.message)) {
      if (typeof m !== 'string' || m[0] !== '{') continue;
      let j;
      try { j = JSON.parse(m); } catch (_) { continue; }
      if (!j || typeof j.lab !== 'string') continue;
      const ms = Date.parse(j.ts) || l.timestamp || ev.eventTimestamp || Date.now();
      out.push({ ms, j });
    }
  }
  return out;
}

function key(j) {
  if (j.lab.endsWith('-nodes')) return 'скач:' + (j.g || j.lab);
  if (j.t) return String(j.t).replace(/^t\d+/, '') + (j['мёртв'] ? '†' : '');
  return j.lab;
}

function winSummary(st) {
  const k = st.win;
  const kind = k % 2 ? 'смерть' : 'жизнь';
  const checks = Object.entries(st.counts).sort().map(([t, n]) => t + '×' + n).join(' ') || 'нет';
  const dl = Object.keys(st.dl).sort().join(',') || 'нет';
  return `${msk(k * WIN_MS)} окно (${kind}) · проверки: ${checks} · скачано: ${dl}`;
}

// Шаг автомата: запись → строки на печать.
function feed(st, { ms, j }) {
  const out = [];
  const k = Math.floor(ms / WIN_MS);
  if (st.win !== null && k > st.win) {
    out.push(winSummary(st));
    st.counts = {}; st.dl = {};
  }
  if (st.win === null || k > st.win) st.win = k;

  const before = st.lastAny; // последнее событие любой метки до этого
  if (st.quiet) {
    out.push(`${msk(ms)} пауза кончилась: тишина ${Math.round((ms - st.lastAny) / 60000)} мин`);
    st.quiet = false;
    st.pause = { from: st.lastAny, to: ms };
  }
  st.lastAny = Math.max(st.lastAny, ms);

  if (j.lab === 'report') {
    const { lab, ...rest } = j;
    out.push(`${msk(ms)} отчёт ${JSON.stringify(rest).slice(0, 400)}`);
    return out;
  }
  const kk = key(j);
  const base = kk.replace('†', '');
  if (kk.startsWith('скач:')) st.dl[kk.slice(5)] = true;
  else st.counts[kk] = (st.counts[kk] || 0) + 1;
  const prev = st.last[base];
  const wake = (kk.startsWith('скач:') ? WAKE_DL_MIN : WAKE_MIN) * 60000;
  // Метка молчала, пока другие работали; общая пауза — это «тишина», не «ожила».
  let busy = before - prev; // сколько шли другие метки, пока эта молчала
  if (st.pause && prev < st.pause.from) busy = (st.pause.from - prev) + Math.max(0, before - st.pause.to);
  if (prev === undefined || (ms - prev >= wake && busy >= wake)) {
    const gap = prev === undefined ? 'впервые за сеанс' : `молчала ${Math.round((ms - prev) / 60000)} мин`;
    out.push(`${msk(ms)} ожила ${base} (${gap})`);
  }
  st.last[base] = Math.max(prev || 0, ms);
  return out;
}

// Раз в 30 с: итог окна, если оно закрылось без новых событий, и тишина.
function tick(st, now) {
  const out = [];
  const k = Math.floor(now / WIN_MS);
  if (st.win !== null && k > st.win) {
    out.push(winSummary(st));
    st.counts = {}; st.dl = {}; st.win = k;
  }
  if (!st.quiet && st.lastAny && now - st.lastAny >= QUIET_MIN * 60000) {
    st.quiet = true;
    out.push(`${msk(now)} тишина: событий нет ${Math.round((now - st.lastAny) / 60000)} мин`);
  }
  return out;
}

module.exports = { createState, labEntries, feed, tick, winSummary };

if (require.main === module) {
  const url = process.argv[2];
  if (!/^wss:\/\/tail\.developers\.workers\.dev\/[0-9a-f]+$/.test(url || '')) {
    console.log('нужен адрес хвоста wss://tail.developers.workers.dev/<id>');
    process.exit(2);
  }
  const st = createState();
  const say = (lines) => { for (const s of lines) console.log(s); };
  const ws = new WebSocket(url, ['trace-v1']);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    ws.send(JSON.stringify({ debug: false, filters: [] }));
    console.log(`${msk(Date.now())} хвост открыт`);
  };
  ws.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString()); } catch (_) { return; }
    for (const e of labEntries(ev).sort((a, b) => a.ms - b.ms)) say(feed(st, e));
  };
  ws.onerror = () => {};
  ws.onclose = (e) => { console.log(`${msk(Date.now())} хвост закрыт (код ${e.code})`); process.exit(0); };
  setInterval(() => say(tick(st, Date.now())), 30000);
}
