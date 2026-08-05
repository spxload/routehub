// Мок Cloudflare D1 для тестов Worker'а. Понимает ровно те три запроса,
// которые встречаются в routehub-worker.js:
//   SELECT value FROM kv WHERE key = ?
//   INSERT INTO kv(...) ... ON CONFLICT(key) DO UPDATE ...   (UPSERT)
//   SELECT key, LENGTH(value) AS len, updated_at FROM kv ORDER BY key
// Хранилище — обычный Map: ключ -> { value, updated_at }.

export function makeDB(initial) {
  const rows = new Map();
  for (const k in (initial || {})) {
    const v = initial[k];
    rows.set(k, { value: typeof v === 'string' ? v : JSON.stringify(v), updated_at: Date.now() });
  }
  const stats = { reads: 0, writes: 0, batches: 0 };

  function exec(sql, args) {
    if (/^SELECT value FROM kv WHERE key/.test(sql)) {
      stats.reads++;
      const r = rows.get(args[0]);
      return { kind: 'first', value: r ? { value: r.value } : null };
    }
    if (/^INSERT INTO kv/.test(sql)) {
      stats.writes++;
      rows.set(args[0], { value: args[1], updated_at: args[2] });
      return { kind: 'run', value: { success: true } };
    }
    if (/^SELECT key, LENGTH\(value\)/.test(sql)) {
      stats.reads++;
      const out = [];
      for (const k of Array.from(rows.keys()).sort()) {
        out.push({ key: k, len: rows.get(k).value.length, updated_at: rows.get(k).updated_at });
      }
      return { kind: 'all', value: { results: out } };
    }
    throw new Error('мок D1: неизвестный запрос: ' + sql);
  }

  function statement(sql, args) {
    return {
      bind: function () { return statement(sql, Array.prototype.slice.call(arguments)); },
      first: async function () { return exec(sql, args).value; },
      run: async function () { return exec(sql, args).value; },
      all: async function () { return exec(sql, args).value; },
      __sql: sql, __args: args,
    };
  }

  return {
    prepare: function (sql) { return statement(sql, []); },
    batch: async function (stmts) {
      stats.batches++;
      return stmts.map(function (s) { return exec(s.__sql, s.__args).value; });
    },
    __rows: rows,
    __stats: stats,
    get: function (k) { const r = rows.get(k); return r ? JSON.parse(r.value) : null; },
    set: function (k, v) { rows.set(k, { value: JSON.stringify(v), updated_at: Date.now() }); },
  };
}

export function makeEnv(initial, extra) {
  const env = {
    RH_DB: makeDB(initial),
    ADMIN_KEY: 'ADMIN-TEST-KEY',
    SUBSCRIPTION_URL: 'https://example.invalid/sub',
    SUB_HWID: 'hwid',
    CONFIG_URL: 'https://raw.example.invalid/spxload/routehub/main/routehub.conf',
  };
  for (const k in (extra || {})) env[k] = extra[k];
  return env;
}

// Узел подписки в том же виде, в каком его отдаёт Lastdep: vless://...#имя
export function nodeLine(name) {
  return 'vless://uuid@host:443?type=tcp#' + encodeURIComponent(name);
}
