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
#  ВАЖНО — что и как публикуем:
#   * SKIP_GRPC: Loon НЕ поддерживает VLESS поверх gRPC (док. Loon:
#     VLESS = ws/http/vision/reality, grpc нет). Такие узлы Loon молча
#     не импортирует -> они «фантомы» (в подписке есть, в Loon нет).
#     Поэтому grpc-узлы выкидываем, чтобы счётчик совпадал с Loon.
#     Если в новой сборке Loon появится поддержка grpc — поставить False.
#   * Сортировка по ИМЕНИ: имена начинаются с флага страны, поэтому
#     сортировка строкой группирует узлы по стране визуально (и игровые
#     узлы попадают в свою страну, а не валятся в самый низ списка).
#   * Имена/теги сохраняются — фильтры [VPN]/[Игры]/[Обход] работают.
#   * Формат — base64 списка vless-ссылок (стандартная подписка V2Ray,
#     Loon читает напрямую). UUID = ключи доступа -> Gist СЕКРЕТНЫЙ.
# =====================================================================

import os, sys, base64
from urllib.parse import urlparse, unquote

try:
    import requests
except ImportError:
    print("ОШИБКА: нужен requests"); sys.exit(1)

NODE_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://')
SKIP_GRPC = True   # Loon не поддерживает VLESS+gRPC -> не публикуем такие узлы


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


def node_name(uri):
    return unquote(uri.split('#', 1)[1]) if '#' in uri else ''


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
    all_lines = [l.strip() for l in text.splitlines()
                 if l.strip().startswith(NODE_PREFIXES)]
    if not all_lines:
        # защита: не затираем рабочий Gist пустотой при сбое выдачи
        print('Узлов в подписке не найдено — Gist НЕ перезаписываю.'); sys.exit(1)

    grpc_n = sum(1 for l in all_lines if 'type=grpc' in l)
    lines = [l for l in all_lines if not (SKIP_GRPC and 'type=grpc' in l)]
    # сортировка по имени -> группировка по флагу/стране, игровые не в самом низу
    lines.sort(key=node_name)

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
        print(f'OK: опубликовано узлов {len(lines)} '
              f'(всего в подписке {len(all_lines)}, пропущено grpc {grpc_n}), Gist {gist_id}.')
    else:
        print(f'ОШИБКА Gist: HTTP {r.status_code} {r.text[:200]}'); sys.exit(1)


if __name__ == '__main__':
    main()
