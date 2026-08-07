// =============================================================
// routehub-egern-worker.js — Worker стенда Egern (ветка `egern`)
// VERSION: e0.1.0 (2026-08-07) — ЗАГЛУШКА ШАГА 4.1.
//   Логики маршрутизации здесь пока нет. Файл нужен, чтобы сборка ветки
//   проходила, а привязка к ОТДЕЛЬНОЙ базе проверялась сразу после деплоя,
//   до того как появится генератор профиля (шаг 4.2).
//   Единственный эндпоинт — GET /health: отвечает версией, состоянием базы
//   и числом ключей в ней. Секретов не читает, наружу ничего не отдаёт.
// ВАЖНО: боевой контур (Worker `routehub`, база `routehub-db`) этим файлом
//   не затрагивается. Ветка `egern` в `main` не сливается.
// ИСТОРИЯ СБОРОК:
//   2026-08-07 — первая сборка проекта routehub-egern прошла до переключения
//   production-ветки и задеплоила код из `main` (боевой v1.9.2, биндинг на
//   боевую базу). Признак: /status?key=k1 отвечал «ссылка устарела», то есть
//   читал token_required из routehub-db. Лечение — production branch = egern
//   и повторная сборка; этот коммит её и запускает.
// =============================================================

const WORKER_VER = 'e0.1.0';

function json(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      const out = { worker: WORKER_VER, stand: 'egern', now: new Date().toISOString() };
      try {
        const row = await env.RH_DB.prepare(
          "SELECT count(*) AS n FROM kv"
        ).first();
        out.db = 'ok';
        out.kv_keys = row ? row.n : null;
      } catch (e) {
        out.db = 'error';
        out.db_error = String(e && e.message || e);
      }
      return json(out);
    }

    return json({ error: 'not found', worker: WORKER_VER }, 404);
  }
};
