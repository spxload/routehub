// Сквозная проверка GET /config — от точки входа до готового текста конфига.
//
// Юниты клиентского слоя (`clients-loon.test.js`) проверяют renderConfig
// на синтетическом шаблоне. Здесь проверяется вся дорога: маршрутизация,
// ключ и токен, шаблон, подстановка тиеров AI, запись conf_ver в реестр.
// Техдолг 6.
//
// С v1.12.0 (T-private-repo) шаблон — НАСТОЯЩИЙ routehub.conf, встроенный в
// сборку (src/files.js; в тестах его подставляет tests/text-loader.mjs).
// Сеть не нужна вовсе: fetch подменяется сторожем, который записывает каждый
// вызов и падает на хостах GitHub/jsDelivr; подписка — из свежего sub_cache.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv, nodeLine } from './mock-d1.js';
import { worker, req, ROOT, T, DE, NL } from './harness.js';

const TOKEN = 'a'.repeat(32);
const CONF_DISK = fs.readFileSync(path.join(ROOT, 'routehub.conf'), 'utf8');

const SUB = {
  ts: Date.now(),
  n: 2,
  text: [
    nodeLine('[VPN] ' + DE + ' Германия #1'),
    nodeLine('[VPN] ' + NL + ' Нидерланды #1'),
  ].join('\n'),
  meta: {},
};

function envWithKey(extra) {
  return makeEnv(Object.assign({
    sub_cache: SUB,
    devices: { k1: { status: 'bound', token: TOKEN, cell_unlim: true, ewma: false } },
  }, extra || {}));
}

const GH_HOST_RE = /^https?:\/\/([^/]*\.)?(githubusercontent\.com|github\.com|jsdelivr\.net)(\/|$)/i;

// Сторож сети: каждый вызов fetch записывается; запрос к GitHub/jsDelivr —
// исключение (ответ /config тогда 500, тест падает и по коду, и по журналу).
async function withStubbedFetch(fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (u) => {
    const s = String(u && u.url ? u.url : u);
    seen.push(s);
    if (GH_HOST_RE.test(s)) throw new Error('запрос к GitHub из /config: ' + s);
    return new Response('', { status: 599 });
  };
  try { return await fn(seen); } finally { globalThis.fetch = real; }
}

function get(key, token) {
  const url = 'https://w.invalid' + (token ? '/t/' + token : '') + '/config?key=' + key;
  return req(url);
}

test('/config без ключа отбивается кодом 400', async () => {
  const env = envWithKey();
  await withStubbedFetch(async () => {
    const r = await worker.fetch(req('https://w.invalid/config'), env);
    assert.equal(r.status, 400);
  });
});

test('/config с неизвестным ключом отбивается кодом 403', async () => {
  const env = envWithKey();
  await withStubbedFetch(async () => {
    const r = await worker.fetch(get('k9', TOKEN), env);
    assert.equal(r.status, 403);
  });
});

// Требование токена — настройка Worker'а, поэтому в тесте она задаётся явно,
// а не берётся из значения по умолчанию.
test('/config без токена не отдаёт конфиг, когда токен обязателен', async () => {
  const env = envWithKey({ settings: { token_required: true } });
  await withStubbedFetch(async () => {
    const r = await worker.fetch(get('k1'), env);
    assert.equal(r.status, 403);
    assert.match(await r.text(), /ссылка устарела/);
  });
});

test('/config с чужим токеном не отдаёт конфиг', async () => {
  const env = envWithKey({ settings: { token_required: true } });
  await withStubbedFetch(async () => {
    const r = await worker.fetch(get('k1', 'b'.repeat(32)), env);
    assert.equal(r.status, 403);
  });
});

test('/config отдаёт текст конфига, а не JSON с ошибкой', async () => {
  const env = envWithKey();
  await withStubbedFetch(async () => {
    const r = await worker.fetch(get('k1', TOKEN), env);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('Content-Type') || '', /text\/plain/);
    // В ссылках токен устройства — промежуточным кэшам ответ хранить нельзя.
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
    const text = await r.text();
    assert.match(text, /\[General\]/);
    assert.match(text, /C-draft-\d+/);
  });
});

test('/config: ни один плейсхолдер Worker\'а не остался в выдаче', async () => {
  const env = envWithKey();
  await withStubbedFetch(async () => {
    const text = await (await worker.fetch(get('k1', TOKEN), env)).text();
    const left = text.match(/# __RH_[A-Z_]+__/g);
    assert.equal(left, null, 'остались неподставленные метки: ' + left);
  });
});

test('/config: script-path указывает на прокси /t/<токен устройства>/repo/', async () => {
  const env = envWithKey();
  await withStubbedFetch(async () => {
    const text = await (await worker.fetch(get('k1', TOKEN), env)).text();
    const base = 'https://w.invalid/t/' + TOKEN + '/repo/';
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(text, new RegExp('script-path=' + esc(base) + 'scripts/routehub-netwatch\\.js'));
    assert.match(text, new RegExp('script-path=' + esc(base) + 'scripts/routehub-speedtest\\.js'));
    assert.match(text, new RegExp('script-path=' + esc(base) + 'probes/routehub-probe-context\\.js'));
    // Ни одна ссылка не осталась относительной.
    const rel = text.match(/script-path=(?!https?:)[^\s,]+/g);
    assert.equal(rel, null, 'остались относительные пути: ' + rel);
  });
});

// Токен в ссылках — токен устройства из реестра, даже когда /config
// запрошен без токена (фаза token_required=false).
test('/config без токена в пути: ссылки на файлы всё равно с токеном устройства', async () => {
  const env = envWithKey();
  await withStubbedFetch(async () => {
    const r = await worker.fetch(get('k1'), env);
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.ok(text.indexOf('script-path=https://w.invalid/t/' + TOKEN + '/repo/scripts/') >= 0);
  });
});

test('/config: строка подписки переписана на наш /nodes с ключом', async () => {
  const env = envWithKey();
  await withStubbedFetch(async () => {
    const text = await (await worker.fetch(get('k1', TOKEN), env)).text();
    const m = text.match(/^Lastdep = (.+)$/m);
    assert.ok(m, 'строка Lastdep не найдена');
    assert.match(m[1], /\/t\/a{32}\/nodes\?key=k1/);
    assert.doesNotMatch(m[1], /старая-ссылка/);
  });
});

test('/config: скриптам подставлен argument с ключом и базой', async () => {
  const env = envWithKey();
  await withStubbedFetch(async () => {
    const text = await (await worker.fetch(get('k1', TOKEN), env)).text();
    assert.match(text, /tag=RH-Speed, argument=k1\|https:\/\/w\.invalid\/t\/a{32}\|cellall/);
    assert.match(text, /tag=RH-Net, argument=k1\|https:\/\/w\.invalid\/t\/a{32}\|/);
    assert.match(text, /tag=RH-Dash, argument=k1\|/);
    assert.match(text, /tag=RH-DashCache, argument=k1\|/);
  });
});

test('/config: блоки AI-каскада подставлены и содержат группы', async () => {
  const env = envWithKey();
  await withStubbedFetch(async () => {
    const text = await (await worker.fetch(get('k1', TOKEN), env)).text();
    const iF = text.indexOf('[Remote Filter]');
    const iG = text.indexOf('[Proxy Group]');
    assert.ok(iF >= 0 && iG > iF);
    // Фильтры и группы встали каждый в свой раздел, а не перепутались местами.
    const filters = text.slice(iF, iG);
    const groups = text.slice(iG);
    assert.ok(filters.trim().length > '[Remote Filter]'.length, 'блок фильтров пуст');
    assert.match(groups, /Германия|AI/, 'в блоке групп нет ни одной страны и ни одной группы AI');
  });
});

test('/config: conf_ver из шаблона записывается в реестр устройств', async () => {
  const env = envWithKey();
  await withStubbedFetch(async () => {
    await worker.fetch(get('k1', TOKEN), env);
    const reg = env.RH_DB.get('devices');
    const want = T.confVersion(CONF_DISK);
    assert.ok(want, 'в routehub.conf не найдена версия C-draft');
    assert.equal(reg.k1.conf_ver, want);
    assert.ok(reg.k1.last_config_ts, 'не проставлена отметка последней выдачи конфига');
  });
});

// T-private-repo: репозиторий приватный, Worker не ходит за шаблоном на GitHub.
test('/config: ни одного запроса к сети, шаблон из сборки', async () => {
  const env = envWithKey();
  await withStubbedFetch(async (seen) => {
    const r = await worker.fetch(get('k1', TOKEN), env);
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(seen, [], 'fetch из /config: ' + seen.join(', '));
  });
});

test('/config: в ответе нет прямых ссылок на файлы spxload/routehub', async () => {
  const env = envWithKey();
  await withStubbedFetch(async () => {
    const text = await (await worker.fetch(get('k1', TOKEN), env)).text();
    assert.ok(CONF_DISK.indexOf('raw.githubusercontent.com/spxload') >= 0, 'предпосылка: в шаблоне есть raw-ссылки');
    assert.equal(text.indexOf('raw.githubusercontent.com/spxload'), -1);
    assert.equal(text.indexOf('jsdelivr.net/gh/spxload'), -1);
  });
});

test('/config: [Plugin] ведёт на прокси с токеном устройства', async () => {
  const env = envWithKey();
  await withStubbedFetch(async () => {
    const text = await (await worker.fetch(get('k1', TOKEN), env)).text();
    const i = text.search(/^\[Plugin\]$/m), j = text.search(/^\[MITM\]$/m);
    assert.ok(i >= 0 && j > i, 'не найдены секции [Plugin]/[MITM]');
    const sec = text.slice(i, j);
    const links = sec.split('\n').filter((l) => /^https?:/.test(l));
    assert.ok(links.length >= 2, 'в [Plugin] нет ссылок');
    for (const l of links) {
      if (l.indexOf('spxload') < 0 && l.indexOf('/repo/') < 0) continue;
      assert.ok(l.startsWith('https://w.invalid/t/' + TOKEN + '/repo/plugins/'), l);
    }
    assert.match(sec, /\/repo\/plugins\/RouteHub-Dash\.plugin, enabled=true/);
  });
});
