// Создаём новый объект только с нужными заголовками
let headers = {
    "Host": "sub.lastdep.net",
    "X-HWID": "64B812C0-9768-4F2B-9789-981D2468CD18",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Accept": "*/*",
    "X-VER-OS": "26.3.1",
    "X-DEVICE-MODEL": "iPhone",
    "User-Agent": "Shadowrocket/3237 CFNetwork/3860.400.51 Darwin/25.3.0 iPhone14,7",
    "X-DEVICE-OS": "iOS",
    "Accept-Language": "ru",
    "Accept-Encoding": "gzip, deflate, br"
};

$notification.post("LastDep Скрипт", "Успешно сработало! 🎉", "Заголовки и HWID подменены.");
$done({ headers: headers });