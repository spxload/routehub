// routehub — модуль clients/stash-yaml.js
// СЕРИАЛИЗАЦИЯ В YAML для клиентского слоя Stash. Выделена из stash-nodes.js
// по правилу проекта «модуль до 10 КБ»: разбор ссылки и сериализация — две
// независимые задачи, и правятся они по отдельности.
// Своя реализация, без js-yaml: в рантайме Cloudflare зависимостей нет.
// Умеет ровно то, что нужно описанию узла: строки, числа, логические,
// вложенные объекты и списки строк. Якорей, многострочных блоков и
// пользовательских тегов здесь нет и не должно быть.
// История версий — CHANGELOG.md в корне репозитория.

// Порядок ключей в YAML фиксирован — иначе файл поставщика будет выглядеть
// изменившимся при каждой перевыдаче одного и того же состава.
const KEY_ORDER = ['name', 'type', 'server', 'port', 'uuid', 'tls', 'sni', 'flow',
  'client-fingerprint', 'alpn', 'network', 'ws-opts', 'reality-opts'];

// Скаляр. Числа и логические — как есть, строки — в одинарных кавычках с
// удвоением кавычки внутри (единственное экранирование, которое YAML требует
// для одинарных строк). Кавычим ВСЕ строки: так адрес, похожий на число, и
// путь, начинающийся с «*» или «&», не сменят тип при чтении.
function yScalar(v) {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// Объект в блочный YAML с отступом indent (двухпробельная лесенка).
// Ключи вне KEY_ORDER выводятся после известных, в порядке объявления.
function yBlock(obj, indent) {
  const pad = ' '.repeat(indent), out = [];
  const extra = Object.keys(obj).filter(function (k) { return KEY_ORDER.indexOf(k) < 0; });
  KEY_ORDER.concat(extra).forEach(function (k) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return;
    const v = obj[k];
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      if (!v.length) return;
      out.push(pad + k + ':');
      v.forEach(function (it) { out.push(pad + '  - ' + yScalar(it)); });
    } else if (typeof v === 'object') {
      const inner = yBlock(v, indent + 2);
      if (!inner) return;
      out.push(pad + k + ':');
      out.push(inner);
    } else {
      out.push(pad + k + ': ' + yScalar(v));
    }
  });
  return out.join('\n');
}

// Один узел как элемент списка: «- » встаёт на место отступа первой строки.
function nodeToYaml(node, indent) {
  const ind = indent === undefined ? 2 : indent;
  const body = yBlock(node, ind + 2);
  return ' '.repeat(ind) + '- ' + body.slice(ind + 2);
}

// Готовый блок `proxies:` — то, что вставляется в профиль или в файл
// поставщика прокси. Пустой список даёт `proxies: []`: ключ без значения
// Stash прочитает как null и откажет в разборе.
function nodesToYaml(nodes) {
  const list = nodes || [];
  if (!list.length) return 'proxies: []\n';
  return 'proxies:\n' + list.map(function (n) { return nodeToYaml(n, 2); }).join('\n') + '\n';
}

export { KEY_ORDER, yScalar, yBlock, nodeToYaml, nodesToYaml };
