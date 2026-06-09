#!/usr/bin/env python3
# =====================================================================
#  publish_nodes.py — публикует декодированный список узлов подписки
#  Lastdep в СЕКРЕТНЫЙ Gist, чтобы Loon брал узлы по ссылке БЕЗ MitM
#  и без скрипта заголовков. Заголовки запроса — как у
#  routehub-server.py (UA Shadowrocket/3274, X-HWID), иначе провайдер
#  отдаёт формат, который не парсится.
#
#  Запускается в GitHub Actions отдельным шагом. Секреты — через env:
#    SUBSCRIPTION_URL, SUB_HWID, GIST_TOKEN (scope gist), GIST_ID.
#
#  ВАЖНО:
#   * SKIP_GRPC=False: grpc-узлы ОСТАВЛЯЕМ (решение Дианы — вдруг Loon
#     добавит поддержку gRPC). Сейчас Loon их молча не импортирует, т.е.
#     в гисте их видно, а в Loon нет (это ожидаемо, не баг).
#   * Умная сортировка (только ВИДИМЫЙ порядок в Loon):
#       - Германия первой (на ней приоритет AI);
#       - остальные страны — по числу [VPN]-узлов (больше -> выше);
#       - внутри страны — по имени.
#     Группировка идёт по ФЛАГУ в имени (что видно глазами). Реальную
#     страну для выбора AI-узла знает скрипт-селектор (серверный GeoIP),
#     имя может не совпадать с реальным выходом — это норма.
#   * ИТОГОВЫЙ выбор AI-узла внутри страны (по отклику И скорости
#     закачки) делает скрипт на телефоне (Этап D + спидтест H); здесь —
#     только порядок отображения.
#   * Имена/теги сохраняются — фильтры [VPN]/[Игры]/[Обход] работают.
#   * Формат — base64 списка vless-ссылок. UUID = ключи -> Gist СЕКРЕТНЫЙ.
#   * ПРОФИЛЬНЫЕ ЗАГОЛОВКИ подписки (остаток трафика, имя, кнопки
#     веб-страницы/поддержки, анонс) снимаются с ответа провайдера и
#     пишутся в гист файлом subinfo.json — Worker /nodes их пересылает
#     в Loon. content-disposition НЕ берём (служебное имя файла);
#     транспорт/cookie/security-заголовки не трогаем.
# =====================================================================

import os, sys, base64, json
from collections import Counter
from urllib.parse import urlparse, unquote

try:
    import requests
except ImportError:
    print("ОШИБКА: нужен requests"); sys.exit(1)

NODE_PREFIXES = ('vless://', 'vmess://', 'trojan://', 'ss://')
SKIP_GRPC = False            # grpc оставляем (вдруг Loon добавит поддержку)
DE_FLAG = '\U0001F1E9\U0001F1EA'   # 🇩🇪

# Профильные заголовки подписки, которые пересылаем в Loon. Все —
# метаданные подписки (не транспорт). content-disposition исключён
# намеренно: несёт служебное имя файла (tg_…), имя даёт profile-title.
META_HEADERS = (
    'subscription-userinfo', 'subscription-ping-onopen-enabled',
    'subscriptions-collapse', 'profile-title', 'profile-update-interval',
    'profile-web-page-url', 'announce', 'announce-url', 'support-url',
    'provider', 'ping-result',
)


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
    # снять профильные заголовки (CaseInsensitiveDict -> регистр неважен)
    meta = {}
    for k in META_HEADERS:
        v = r.headers.get(k)
        if v and v.strip():
            meta[k] = v.strip()
    body = ''.join(r.text.split())
    if not body:
        return '', meta
    try:
        norm = body.replace('-', '+').replace('_', '/')
        norm += '=' * (-len(norm) % 4)
        dec = base64.b64decode(norm).decode('utf-8', 'ignore')
        if any(p in dec for p in NODE_PREFIXES):
            return dec, meta
    except Exception:
        pass
    return r.text, meta


def node_name(uri):
    return unquote(uri.split('#', 1)[1]) if '#' in uri else ''


def flag_of(name):
    # Флаг = 2 символа Regional Indicator (U+1F1E6..U+1F1FF) в начале имени.
    s = name.lstrip()
    pair = s[:2]
    if len(pair) == 2 and all(0x1F1E6 <= ord(c) <= 0x1F1FF for c in pair):
        return pair
    return None


def main():
    url = os.environ.get('SUBSCRIPTION_URL', '').strip()
    hwid = os.environ.get('SUB_HWID', '').strip()
    token = os.environ.get('GIST_TOKEN', '').strip()
    gist_id = os.environ.get('GIST_ID', '').strip()

    if not url:
        print('SUBSCRIPTION_URL пуст — выход.'); sys.exit(1)
    if not (token and gist_id):
        print('GIST_TOKEN/GIST_ID не заданы — публикация пропущена.'); return

    text, meta = fetch_subscription(url, hwid)
    all_lines = [l.strip() for l in text.splitlines()
                 if l.strip().startswith(NODE_PREFIXES)]
    if not all_lines:
        print('Узлов в подписке не найдено — Gist НЕ перезаписываю.'); sys.exit(1)

    grpc_n = sum(1 for l in all_lines if 'type=grpc' in l)
    lines = [l for l in all_lines if not (SKIP_GRPC and 'type=grpc' in l)]

    # Число [VPN]-узлов по флагу — для порядка стран (больше узлов -> выше).
    vpn_by_flag = Counter(flag_of(node_name(l)) for l in lines
                          if '[VPN]' in node_name(l) and flag_of(node_name(l)))

    def sort_key(l):
        nm = node_name(l)
        fl = flag_of(nm)
        if fl is None:
            country = (2, 0, 'zzz')          # без флага -> в конец
        elif fl == DE_FLAG:
            country = (0, 0, '')             # Германия первой
        else:
            country = (1, -vpn_by_flag.get(fl, 0), fl)  # дальше по числу узлов
        return (country, nm)

    lines.sort(key=sort_key)

    sub = '\n'.join(lines)
    content_b64 = base64.b64encode(sub.encode('utf-8')).decode('ascii')
    payload = {'files': {'lastdep-nodes.txt': {'content': content_b64}}}
    # профильные заголовки -> гист (Worker /nodes их перешлёт). Пустое
    # meta не пишем, чтобы не затереть прежнее значение (challenge-страница).
    if meta:
        payload['files']['subinfo.json'] = {
            'content': json.dumps(meta, ensure_ascii=False)}

    r = requests.patch(
        f'https://api.github.com/gists/{gist_id}',
        headers={'Authorization': f'token {token}',
                 'Accept': 'application/vnd.github+json',
                 'User-Agent': 'routehub-publish'},
        json=payload, timeout=30)
    if r.status_code == 200:
        ui = meta.get('subscription-userinfo', '')
        tail = (f', userinfo: [{ui}]' if ui
                else ', userinfo НЕ отдан провайдером')
        print(f'OK: опубликовано узлов {len(lines)} '
              f'(grpc внутри: {grpc_n}, Loon их не покажет), '
              f'заголовков подписки: {len(meta)}{tail}, Gist {gist_id}.')
    else:
        print(f'ОШИБКА Gist: HTTP {r.status_code} {r.text[:200]}'); sys.exit(1)


if __name__ == '__main__':
    main()
