// Сквозная проверка GET /config — от точки входа до готового текста конфига.
//
// Юниты клиентского слоя (`clients-loon.test.js`) проверяют renderConfig
// на синтетическом шаблоне. Здесь проверяется вся дорога: маршрутизация,
// ключ и токен, загрузка шаблона, подстановка тиеров AI, запись conf_ver
// в реестр. Техдолг 6.
//
// Сеть не трогается: fetch подменяется на время теста, подписка берётся
// из свежего sub_cache.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, nodeLine } from './mock-d1.js';
import { worker, req, DE, NL } from './harness.js';

const TOKEN = 'a'.repeat(32);

// Шаблон конфига в том виде, в каком он лежит в репозитории: с плейсхолдерами
// Worker'а, строкой подписки, скриптами в корне И в папках (обе раскладки
// должны обрабатываться — v1.9.9).
const CONF = [
  '# RouteHub C-draft-41',
  '[General]',
  'ip-mode = dual',
  '',
  '[Proxy]',
  '',
  '[Remote Proxy]',
  'Lastdep = https://example.invalid/старая-ссылка, udp=true',
  '',
  '[Remote Filter]',
  '# __RH_AI_FILTERS__',
  'MYLIST = NameKeyword, # __RH_MYLIST_URL__',
  '',
  '[Proxy Group]',
  '# __RH_AI_GROUPS__',
  '',
  '[Script]',
  'cron "*/20 * * * *" script-path=routehub-speedtest.js, tag=RH-Speed',
  'network-changed script-path=scripts/routehub-netwatch.js, tag=RH-Net',
  'generic script-path=probes/routehub-probe-context.js, tag=RH-L10',
  'http-request ^https?://rh\\.box/dash script-path=scripts/routehub-dash.js, tag=RH-Dash, enable=true',
  'cron "0 * * * *" script-path=scripts/routehub-dashcache.js, tag=RH-DashCache, enable=true',
  '',
  '[MITM]',
  'hostname = rh.box',
  '',
].join('\n');

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

// Подменяем сеть: /config тянет шаблон по CONFIG_URL. Возвращаем свой текст,
// заодно запоминаем, по какому адресу ходили.
async function withStubbedFetch(fn, body) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (u) => {
    seen.push(String(u));
    return new Response(body === undefined ? CONF : body, { status: 200 });
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
    const text = await r.text();
    assert.match(text, /\[General\]/);
    assert.match(text, /C-draft-41/);
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

test('/config: script-path получает базу и для файла в корне, и для файла в папке', async () => {
  const env = envWithKey();
  await withStubbedFetch(async () => {
    const text = await (await worker.fetch(get('k1', TOKEN), env)).text();
    const base = 'https://raw.example.invalid/spxload/routehub/main/';
    assert.match(text, new RegExp('script-path=' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 'routehub-speedtest\\.js'));
    assert.match(text, new RegExp('script-path=' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 'scripts/routehub-netwatch\\.js'));
    assert.match(text, new RegExp('script-path=' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 'probes/routehub-probe-context\\.js'));
    // Ни одна ссылка не осталась относительной.
    const rel = text.match(/script-path=(?!https?:)[^\s,]+/g);
    assert.equal(rel, null, 'остались относительные пути: ' + rel);
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
    assert.equal(reg.k1.conf_ver, 'C-draft-41');
    assert.ok(reg.k1.last_config_ts, 'не проставлена отметка последней выдачи конфига');
  });
});

test('/config: шаблон запрашивается с обходом кэша', async () => {
  const env = envWithKey();
  await withStubbedFetch(async (seen) => {
    await worker.fetch(get('k1', TOKEN), env);
    assert.equal(seen.length, 1, 'ожидался ровно один поход за шаблоном');
    assert.match(seen[0], /^https:\/\/raw\.example\.invalid\//);
    assert.match(seen[0], /[?&]t=\d+/, 'нет параметра обхода кэша');
  });
});
