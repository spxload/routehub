#!/usr/bin/env python3
# =====================================================================
#  publish_nodes.py — публикует декодированный список узлов подписки
#  Lastdep в СЕКРЕТНЫЙ Gist, чтобы Loon брал узлы по ссылке БЕЗ MitM
#  и без скрипта заголовков (header-подмена на устройстве была
#  нестабильна). Заголовки запроса — как у routehub-server.py
#  (UA Shadowrocket/3274, X-HWID), иначе провайдер отдаёт формат,
#  который не парсится.
#
#  Запускается в GitHub Actions отдельным шагом. Секреты — через env:
#    SUBSCRIPTION_URL, SUB_HWID, GIST_TOKEN (scope gist), GIST_ID.
#
#  В Gist пишется ПОЛНЫЙ список узлов (имена/теги сохраняются, чтобы
#  фильтры [VPN]/[Игры]/[Обход] в Loon работали). Мёртвые узлы НЕ
#  убираются — их отсекает url-test в Loon (и это защита от whitelist
#  РКН: узел жив, просто маршрут whitelist). Формат — base64 списка
#  vless-ссылок (стандартная подписка V2Ray, Loon читает напрямую).
#  UUID узлов = ключи доступа: поэтому Gist СЕКРЕТНЫЙ, не публичный.
# =====================================================================

import os, sys, base64
from urllib.parse import urlparse

try:
    import requests
except ImportError:
    print("ОШИБКА: нужен requests"); sys.exit(1)

NODE_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://')


def fetch_subscription(url, hwid):
    headers = {
        'X-HWID': hwid,
        'User-Agent': 'Shadowrocket/3274 CFNetwork/3860.400.51 Darwin/25.3.0 iPhone14,7',
        'X-VER-OS': '26.3.1', 'X-DEVICE-MODEL': 'iPhone', 'X-DEVICE-OS': 'iOS',
        'Accept': '*/*', 'Accept-Language': 'ru', 'Connection': 'keep-alive',
        'Host': urlparse(url).netloc,
    }
    r = requests.get(url, headers=headers, timeout=30)
    r.raise_for_status()
    body = ''.join(r.text.split())
    if not body:
        return ''
    # подписка обычно base64 — декодируем, если внутри ссылки на узлы
    try:
        norm = body.replace('-', '+').replace('_', '/')
        norm += '=' * (-len(norm) % 4)
        dec = base64.b64decode(norm).decode('utf-8', 'ignore')
        if any(p in dec for p in NODE_PREFIXES):
            return dec
    except Exception:
        pass
    return r.text


def main():
    url = os.environ.get('SUBSCRIPTION_URL', '').strip()
    hwid = os.environ.get('SUB_HWID', '').strip()
    token = os.environ.get('GIST_TOKEN', '').strip()
    gist_id = os.environ.get('GIST_ID', '').strip()

    if not url:
        print('SUBSCRIPTION_URL пуст — выход.'); sys.exit(1)
    if not (token and gist_id):
        print('GIST_TOKEN/GIST_ID не заданы — публикация пропущена.'); return

    text = fetch_subscription(url, hwid)
    lines = [l.strip() for l in text.splitlines()
             if l.strip().startswith(NODE_PREFIXES)]
    if not lines:
        # защита: не затираем рабочий Gist пустотой при сбое выдачи
        print('Узлов в подписке не найдено — Gist НЕ перезаписываю.'); sys.exit(1)

    sub = '\n'.join(lines)
    content_b64 = base64.b64encode(sub.encode('utf-8')).decode('ascii')
    payload = {'files': {'lastdep-nodes.txt': {'content': content_b64}}}

    r = requests.patch(
        f'https://api.github.com/gists/{gist_id}',
        headers={'Authorization': f'token {token}',
                 'Accept': 'application/vnd.github+json',
                 'User-Agent': 'routehub-publish'},
        json=payload, timeout=30)
    if r.status_code == 200:
        print(f'OK: опубликовано узлов {len(lines)} в Gist {gist_id}.')
    else:
        print(f'ОШИБКА Gist: HTTP {r.status_code} {r.text[:200]}'); sys.exit(1)


if __name__ == '__main__':
    main()
