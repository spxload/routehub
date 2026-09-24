// routehub — модуль files.js
// МАНИФЕСТ ВСТРОЕННЫХ ФАЙЛОВ (T-private-repo; в main — v1.12.0, в ветке
// stash-client — перенос, Worker v1.11.0). Репозиторий spxload/routehub
// становится приватным, и raw.githubusercontent.com / jsDelivr отдают его
// файлы только с авторизацией (jsDelivr — не отдаёт вовсе). Поэтому всё, что
// тянет устройство, — конфиг, скрипты, пробы, плагины и override Stash —
// вбирается в сборку Worker'а модулями Text (правила [[rules]] в
// wrangler.toml), как web/*.html. Запросов к GitHub за файлами нет, токен
// GitHub не нужен вовсе.
//
// Список ЯВНЫЙ: Wrangler вбирает только статически импортированные файлы,
// шаблоны путей в импорте не поддерживаются. Новый файл в scripts/, probes/
// или plugins/ добавляется сюда строкой импорта и строкой в FILES — иначе
// падает сторож tests/files-manifest.test.js.
//
// Набор — файлы ЭТОЙ ветки (stash-client): стенд отдаёт свою копию. Файлы
// только из main (probes/routehub-probe-dnstime.js, RouteHub-DNS-L12.plugin)
// здесь не встроены — в ветке их нет, и ни один файл ветки на них не ссылается.
//
// Не встроены: probes/*.yaml, *.sgmodule, *.conf (стенды Stash ST5 и Surge
// SG-draft-1). Ни routehub.conf, ни plugins/* на них не ссылаются, это разовые
// профили других клиентов; прокси их не отдаёт.
//
// Ключ FILES — путь от корня репозитория; он же путь в /t/<токен>/repo/<путь>.
// Импортов из src/ нет — модуль только данные.

import F_ROUTEHUB_CONF from '../routehub.conf';
import F_SCRIPTS_ROUTEHUB_DASH_JS from '../scripts/routehub-dash.js';
import F_SCRIPTS_ROUTEHUB_DASHCACHE_JS from '../scripts/routehub-dashcache.js';
import F_SCRIPTS_ROUTEHUB_FAILLOG_JS from '../scripts/routehub-faillog.js';
import F_SCRIPTS_ROUTEHUB_NETWATCH_JS from '../scripts/routehub-netwatch.js';
import F_SCRIPTS_ROUTEHUB_RKN_JS from '../scripts/routehub-rkn.js';
import F_SCRIPTS_ROUTEHUB_SPEEDTEST_JS from '../scripts/routehub-speedtest.js';
import F_SCRIPTS_ROUTEHUB_STASH_COLLECT_JS from '../scripts/routehub-stash-collect.js';
import F_SCRIPTS_ROUTEHUB_VIEWER_JS from '../scripts/routehub-viewer.js';
import F_PROBES_ROUTEHUB_PROBE_CONTEXT_JS from '../probes/routehub-probe-context.js';
import F_PROBES_ROUTEHUB_PROBE_STASH_JS from '../probes/routehub-probe-stash.js';
import F_PROBES_ROUTEHUB_PROBE_STASH10_JS from '../probes/routehub-probe-stash10.js';
import F_PROBES_ROUTEHUB_PROBE_STASH11_JS from '../probes/routehub-probe-stash11.js';
import F_PROBES_ROUTEHUB_PROBE_STASH12_JS from '../probes/routehub-probe-stash12.js';
import F_PROBES_ROUTEHUB_PROBE_STASH13_JS from '../probes/routehub-probe-stash13.js';
import F_PROBES_ROUTEHUB_PROBE_STASH14_JS from '../probes/routehub-probe-stash14.js';
import F_PROBES_ROUTEHUB_PROBE_STASH15_JS from '../probes/routehub-probe-stash15.js';
import F_PROBES_ROUTEHUB_PROBE_STASH16_JS from '../probes/routehub-probe-stash16.js';
import F_PROBES_ROUTEHUB_PROBE_STASH17_JS from '../probes/routehub-probe-stash17.js';
import F_PROBES_ROUTEHUB_PROBE_STASH18_JS from '../probes/routehub-probe-stash18.js';
import F_PROBES_ROUTEHUB_PROBE_STASH19_JS from '../probes/routehub-probe-stash19.js';
import F_PROBES_ROUTEHUB_PROBE_STASH19_CMD_JS from '../probes/routehub-probe-stash19-cmd.js';
import F_PROBES_ROUTEHUB_PROBE_STASH6_JS from '../probes/routehub-probe-stash6.js';
import F_PROBES_ROUTEHUB_PROBE_STASH7_JS from '../probes/routehub-probe-stash7.js';
import F_PROBES_ROUTEHUB_PROBE_STASH8_JS from '../probes/routehub-probe-stash8.js';
import F_PROBES_ROUTEHUB_PROBE_STASH9_JS from '../probes/routehub-probe-stash9.js';
import F_PROBES_ROUTEHUB_PROBE_STORE_JS from '../probes/routehub-probe-store.js';
import F_PROBES_ROUTEHUB_PROBE_SURGE_JS from '../probes/routehub-probe-surge.js';
import F_PROBES_ROUTEHUB_PROBE_SURGE2_JS from '../probes/routehub-probe-surge2.js';
import F_PROBES_ROUTEHUB_PROBE_SURGE3_JS from '../probes/routehub-probe-surge3.js';
import F_PLUGINS_ROUTEHUB_DASH_PLUGIN from '../plugins/RouteHub-Dash.plugin';
import F_PLUGINS_ROUTEHUB_FAILLOG_PLUGIN from '../plugins/RouteHub-FailLog.plugin';
import F_PLUGINS_ROUTEHUB_PROBE_STOVERRIDE from '../plugins/RouteHub-Probe.stoverride';
import F_PLUGINS_ROUTEHUB_STASH_COLLECT_STOVERRIDE from '../plugins/RouteHub-Stash-Collect.stoverride';
import F_PLUGINS_ROUTEHUB_STASH_PROBES_STOVERRIDE from '../plugins/RouteHub-Stash-Probes.stoverride';
import F_PLUGINS_ROUTEHUB_STASH_ST13_STOVERRIDE from '../plugins/RouteHub-Stash-ST13.stoverride';
import F_PLUGINS_ROUTEHUB_STASH_ST14_STOVERRIDE from '../plugins/RouteHub-Stash-ST14.stoverride';
import F_PLUGINS_ROUTEHUB_STASH_ST15_STOVERRIDE from '../plugins/RouteHub-Stash-ST15.stoverride';
import F_PLUGINS_ROUTEHUB_STASH_ST16_STOVERRIDE from '../plugins/RouteHub-Stash-ST16.stoverride';
import F_PLUGINS_ROUTEHUB_STASH_ST17_STOVERRIDE from '../plugins/RouteHub-Stash-ST17.stoverride';
import F_PLUGINS_ROUTEHUB_STASH_ST18_STOVERRIDE from '../plugins/RouteHub-Stash-ST18.stoverride';
import F_PLUGINS_ROUTEHUB_STASH_ST19_STOVERRIDE from '../plugins/RouteHub-Stash-ST19.stoverride';
import F_PLUGINS_ROUTEHUB_STASH_ST6_CDN_STOVERRIDE from '../plugins/RouteHub-Stash-ST6-cdn.stoverride';
import F_PLUGINS_ROUTEHUB_STASH_ST6_STOVERRIDE from '../plugins/RouteHub-Stash-ST6.stoverride';
import F_PLUGINS_ROUTEHUB_STASH_STOVERRIDE from '../plugins/RouteHub-Stash.stoverride';

const FILES = Object.freeze({
  'routehub.conf': F_ROUTEHUB_CONF,
  'scripts/routehub-dash.js': F_SCRIPTS_ROUTEHUB_DASH_JS,
  'scripts/routehub-dashcache.js': F_SCRIPTS_ROUTEHUB_DASHCACHE_JS,
  'scripts/routehub-faillog.js': F_SCRIPTS_ROUTEHUB_FAILLOG_JS,
  'scripts/routehub-netwatch.js': F_SCRIPTS_ROUTEHUB_NETWATCH_JS,
  'scripts/routehub-rkn.js': F_SCRIPTS_ROUTEHUB_RKN_JS,
  'scripts/routehub-speedtest.js': F_SCRIPTS_ROUTEHUB_SPEEDTEST_JS,
  'scripts/routehub-stash-collect.js': F_SCRIPTS_ROUTEHUB_STASH_COLLECT_JS,
  'scripts/routehub-viewer.js': F_SCRIPTS_ROUTEHUB_VIEWER_JS,
  'probes/routehub-probe-context.js': F_PROBES_ROUTEHUB_PROBE_CONTEXT_JS,
  'probes/routehub-probe-stash.js': F_PROBES_ROUTEHUB_PROBE_STASH_JS,
  'probes/routehub-probe-stash10.js': F_PROBES_ROUTEHUB_PROBE_STASH10_JS,
  'probes/routehub-probe-stash11.js': F_PROBES_ROUTEHUB_PROBE_STASH11_JS,
  'probes/routehub-probe-stash12.js': F_PROBES_ROUTEHUB_PROBE_STASH12_JS,
  'probes/routehub-probe-stash13.js': F_PROBES_ROUTEHUB_PROBE_STASH13_JS,
  'probes/routehub-probe-stash14.js': F_PROBES_ROUTEHUB_PROBE_STASH14_JS,
  'probes/routehub-probe-stash15.js': F_PROBES_ROUTEHUB_PROBE_STASH15_JS,
  'probes/routehub-probe-stash16.js': F_PROBES_ROUTEHUB_PROBE_STASH16_JS,
  'probes/routehub-probe-stash17.js': F_PROBES_ROUTEHUB_PROBE_STASH17_JS,
  'probes/routehub-probe-stash18.js': F_PROBES_ROUTEHUB_PROBE_STASH18_JS,
  'probes/routehub-probe-stash19.js': F_PROBES_ROUTEHUB_PROBE_STASH19_JS,
  'probes/routehub-probe-stash19-cmd.js': F_PROBES_ROUTEHUB_PROBE_STASH19_CMD_JS,
  'probes/routehub-probe-stash6.js': F_PROBES_ROUTEHUB_PROBE_STASH6_JS,
  'probes/routehub-probe-stash7.js': F_PROBES_ROUTEHUB_PROBE_STASH7_JS,
  'probes/routehub-probe-stash8.js': F_PROBES_ROUTEHUB_PROBE_STASH8_JS,
  'probes/routehub-probe-stash9.js': F_PROBES_ROUTEHUB_PROBE_STASH9_JS,
  'probes/routehub-probe-store.js': F_PROBES_ROUTEHUB_PROBE_STORE_JS,
  'probes/routehub-probe-surge.js': F_PROBES_ROUTEHUB_PROBE_SURGE_JS,
  'probes/routehub-probe-surge2.js': F_PROBES_ROUTEHUB_PROBE_SURGE2_JS,
  'probes/routehub-probe-surge3.js': F_PROBES_ROUTEHUB_PROBE_SURGE3_JS,
  'plugins/RouteHub-Dash.plugin': F_PLUGINS_ROUTEHUB_DASH_PLUGIN,
  'plugins/RouteHub-FailLog.plugin': F_PLUGINS_ROUTEHUB_FAILLOG_PLUGIN,
  'plugins/RouteHub-Probe.stoverride': F_PLUGINS_ROUTEHUB_PROBE_STOVERRIDE,
  'plugins/RouteHub-Stash-Collect.stoverride': F_PLUGINS_ROUTEHUB_STASH_COLLECT_STOVERRIDE,
  'plugins/RouteHub-Stash-Probes.stoverride': F_PLUGINS_ROUTEHUB_STASH_PROBES_STOVERRIDE,
  'plugins/RouteHub-Stash-ST13.stoverride': F_PLUGINS_ROUTEHUB_STASH_ST13_STOVERRIDE,
  'plugins/RouteHub-Stash-ST14.stoverride': F_PLUGINS_ROUTEHUB_STASH_ST14_STOVERRIDE,
  'plugins/RouteHub-Stash-ST15.stoverride': F_PLUGINS_ROUTEHUB_STASH_ST15_STOVERRIDE,
  'plugins/RouteHub-Stash-ST16.stoverride': F_PLUGINS_ROUTEHUB_STASH_ST16_STOVERRIDE,
  'plugins/RouteHub-Stash-ST17.stoverride': F_PLUGINS_ROUTEHUB_STASH_ST17_STOVERRIDE,
  'plugins/RouteHub-Stash-ST18.stoverride': F_PLUGINS_ROUTEHUB_STASH_ST18_STOVERRIDE,
  'plugins/RouteHub-Stash-ST19.stoverride': F_PLUGINS_ROUTEHUB_STASH_ST19_STOVERRIDE,
  'plugins/RouteHub-Stash-ST6-cdn.stoverride': F_PLUGINS_ROUTEHUB_STASH_ST6_CDN_STOVERRIDE,
  'plugins/RouteHub-Stash-ST6.stoverride': F_PLUGINS_ROUTEHUB_STASH_ST6_STOVERRIDE,
  'plugins/RouteHub-Stash.stoverride': F_PLUGINS_ROUTEHUB_STASH_STOVERRIDE,
});

export { FILES };
