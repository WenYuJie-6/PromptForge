// ============================================================
// check-ui-wiring.mjs —— index.html 控件 id 与 JS 引用对应
//
// 校验目标（全部为静态交叉比对，不执行代码）
//   1. <script> 列表：数量、顺序、文件真实存在、app.js 最后加载；
//   2. sw.js 的 STATIC_CACHE_URLS 与 index.html 的脚本集合完全一致，
//      且每条都能对应到真实文件（漏一条 = 离线时 404，SW 安装失败）；
//   3. index.html 的内联事件处理函数（onclick/onchange/oninput/onkeydown）
//      都能在 js/ 里找到定义（漏定义 = 点了没反应）；
//   4. js/ 里 getElementById 引用的字面量 id 都存在于 index.html
//      （遗留控件单独白名单，且必须带空值保护）。
//
// 输入：index.html、js/*.js、sw.js、manifest.json（只读）
// 输出：逐条 '✓' / 'FAIL'，末行 '>>> check-ui-wiring: N PASS / M FAIL'
// 失败判定：任一断言失败 → 打印 FAIL 行并以退出码 1 结束
//
// 为什么值得单列：本项目没有打包器，HTML↔JS 全靠字符串约定耦合。
// 改个 id、删个函数、漏同步 sw.js 都不会报错，只会「点了没反应」或「离线白屏」。
// ============================================================
import { read, readJSON, exists, reporter, jsFiles, stripComments } from './_check-lib.mjs';

const r = reporter('check-ui-wiring');
const html = read('index.html');
const sw = read('sw.js');

// ---- A. script 标签 ----
r.section('A. 脚本加载');
const srcs = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map((m) => m[1]);
r.eq(srcs.length, 17, '<script src> 数量为 17');
r.check(srcs.every((s) => exists(s)), '每个 <script src> 都指向真实存在的文件');
r.eq(srcs[srcs.length - 1], 'js/app.js', 'app.js 最后加载（依赖前面所有文件）');
r.eq(srcs[0], 'js/frameworks.js', 'frameworks.js 最先加载（纯数据，无依赖）');

// 关键顺序约束（依赖靠隐式全局变量传递）
const idx = (f) => srcs.indexOf(f);
r.check(idx('js/offline-llm.js') >= 0 && idx('js/offline-llm.js') < idx('js/local-model.js'),
  'offline-llm.js 在 local-model.js 之前（后者读前者 MODEL_OPTIONS）');
r.check(idx('js/storage.js') < idx('js/app.js'), 'storage.js 在 app.js 之前（loadSettings 依赖）');
r.check(idx('js/style-variants.js') < idx('js/optimizer.js'), 'style-variants.js 在 optimizer.js 之前');
r.check(idx('js/optimizer.js') < idx('js/optimize-ui.js'), 'optimizer.js 在 optimize-ui.js 之前');
r.check(idx('js/device-detection.js') < idx('js/offline-ui.js'), 'device-detection.js 在 offline-ui.js 之前');

// ---- B. sw.js 缓存清单 ----
r.section('B. Service Worker 缓存清单');
const urls = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter((x) => x !== '' || true);
const cacheList = [...sw.matchAll(/'(\.\/[^']*)'/g)].map((m) => m[1]);
const cachedJs = cacheList.filter((u) => u.startsWith('./js/')).map((u) => u.slice(2));
r.check(srcs.every((s) => cachedJs.includes(s)),
  `index.html 的每个脚本都在 sw.js 缓存清单中（缺 ${srcs.filter((s) => !cachedJs.includes(s)).join(',') || '无'}）`);
r.check(cachedJs.every((s) => srcs.includes(s)),
  `sw.js 缓存清单没有多余脚本（多 ${cachedJs.filter((s) => !srcs.includes(s)).join(',') || '无'}）`);
for (const need of ['./index.html', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png', './css/style.css']) {
  r.check(cacheList.includes(need), `sw.js 缓存清单包含 ${need}`);
}
const missingFiles = cacheList.filter((u) => u !== './' && !exists(u.slice(2)));
r.check(missingFiles.length === 0, `sw.js 缓存的每条都对应真实文件（缺失：${missingFiles.join(',') || '无'}）`);
r.check(/promptforge-v\d+\.\d+\.\d+/.test(sw), 'sw.js 的 CACHE_NAME 带版本号（改缓存清单须同步升版本）');

// ---- C. 内联事件处理函数 ----
r.section('C. 内联事件处理函数');
const handlerRe = /on(?:click|change|input|keydown)="([^"]*)"/g;
const handlers = new Set();
for (const m of html.matchAll(handlerRe)) {
  const mm = m[1].match(/^\s*([A-Za-z_$][\w$]*)\s*\(/);
  if (mm) handlers.add(mm[1]);
}
// 汇总 js/ 中定义的所有全局名（classic script 里顶层 function/const 即全局）
const defined = new Set();
for (const f of jsFiles()) {
  const src = stripComments(read(f));
  for (const m of src.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  for (const m of src.matchAll(/(?:^|[\s;{])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
  for (const m of src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
}
r.check(handlers.size >= 55, `index.html 解析出 ${handlers.size} 个内联处理函数（>=55）`);
const undef = [...handlers].filter((h) => !defined.has(h)).sort();
r.check(undef.length === 0, `每个内联处理函数都有定义（未定义：${undef.join(',') || '无'}）`);

// 绑定方式区分（C6 变异护栏）：内联 onclick 通过 window 查找函数，
//   fnBound      = `function NAME(` 或 `window.NAME =` —— 会成为 window 属性，能命中；
//   lexicalBound = 仅 `const|let|var NAME =` —— 顶层 const/let 只是「全局词法绑定」，
//                  **不是** window 属性，内联 handler 找不到 ⇒ 真机上点了没反应。
// 历史教训：clearHistory 若被写成 `const clearHistory = async function()`，
// 上面的 `defined`（含 const）与 check-a11y-static 都会保持全绿，但按钮静默失效。
const fnBound = new Set();
const lexicalBound = new Set();
for (const f of jsFiles()) {
  const src = stripComments(read(f));
  for (const m of src.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) fnBound.add(m[1]);
  for (const m of src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) fnBound.add(m[1]);
  for (const m of src.matchAll(/(?:^|[\s;{])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) lexicalBound.add(m[1]);
}
const fragile = [...handlers].filter((h) => !fnBound.has(h)).sort();
r.check(fragile.length === 0,
  `每个内联处理函数都能被 window 访问（function 声明或 window.X=；脆弱 handler：${fragile.join(',') || '无'}）`);
// 只由 const/let/var 绑定、却出现在内联 handler 里的名字，就是上面那类脆弱项，单独标注便于排查
r.check(fragile.every((h) => lexicalBound.has(h)),
  `脆弱 handler 均确认为「仅词法绑定」（${fragile.join(',') || '无'}）`);

// ---- D. id 交叉比对 ----
r.section('D. 控件 id 交叉比对');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
// 遗留控件：旧版离线模型设置控件已被新界面取代，代码里保留了读取但都有空值保护。
// 出现在这里属于「已知且安全」，不是缺陷；若未来新增，请先确认有空值保护再加进来。
const LEGACY_IDS = new Set(['set-local-mode', 'set-local-model', 'local-model-config']);

const refIds = new Set();
for (const f of jsFiles()) {
  for (const m of read(f).matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) refIds.add(m[1]);
}
r.check(refIds.size >= 60, `js/ 中字面量 id 引用 ${refIds.size} 个（>=60）`);
const ghosts = [...refIds].filter((id) => !htmlIds.has(id) && !LEGACY_IDS.has(id)).sort();
r.check(ghosts.length === 0, `每个被引用的 id 都存在于 index.html（幽灵引用：${ghosts.join(',') || '无'}）`);
// 遗留 id 的引用处必须带空值保护，否则运行时会 TypeError
for (const id of LEGACY_IDS) {
  const guard = jsFiles().some((f) => {
    const s = read(f);
    return new RegExp(`if\\s*\\(\\s*!?${id}\\b[^)]*\\)`).test(s) || new RegExp(`getElementById\\(['"]${id}['"]\\)\\s*;?\\s*\\n?\\s*if\\s*\\(`).test(s);
  });
  r.check(guard, `遗留控件 ${id} 的读取处带空值保护`);
}

// ---- E. 关键入口与回归护栏 ----
r.section('E. 关键入口');
r.check(htmlIds.has('download-desktop-btn'), '侧边栏存在「下载桌面版」按钮');
r.check(html.includes('onclick="downloadDesktopInstaller()"'), '「下载桌面版」绑定到 downloadDesktopInstaller()');
r.check(!htmlIds.has('pwa-menu-btn'), '侧边栏已无「安装应用」按钮（pwa-menu-btn）');
r.check(!html.includes('showPWAInstallMenu'), 'index.html 不再引用已删除的 showPWAInstallMenu');
// 回归护栏：浮动「安装到桌面」按钮已随产品决策移除。
// 注意 pwa.js 里有一段注释会提到这些名字（说明为什么删），所以必须**剥掉注释**再扫，
// 否则这条断言会永远为真、失去意义。
{
  const pwaCode = stripComments(read('js/pwa.js'));
  const leftovers = ['showInstallButton', 'hideInstallButton', 'checkInstallAvailability', 'pwa-install-btn']
    .filter((n) => pwaCode.includes(n));
  r.check(leftovers.length === 0,
    `pwa.js 中不再有浮动安装按钮的代码（残留：${leftovers.join(',') || '无'}）`);
}
r.check(htmlIds.has('nav-check-update'), '侧边栏存在「检查更新」入口');
r.check(htmlIds.has('update-dot'), '「检查更新」带红点元素 update-dot');
r.check(html.includes('PF_DEPLOY_BASE'), 'index.html 注入 PF_DEPLOY_BASE（自描述部署根地址）');
// 注意：不能拿 'js/app.js' 的字符串位置比较 —— 注释里也提到过它。
// 应比较「内联注入脚本」与「第一个外部 <script src>」的先后。
r.check(html.indexOf('PF_DEPLOY_BASE') < html.indexOf('<script src='),
  'PF_DEPLOY_BASE 注入脚本位于第一个外部业务脚本之前');

// ---- F. manifest ----
r.section('F. manifest.json');
const mf = readJSON('manifest.json');
r.check(!!mf, 'manifest.json 可解析');
r.check(mf.icons && mf.icons.length > 0, 'manifest 声明了 icons');
r.check(!!mf.start_url, 'manifest 有 start_url');
r.check((mf.icons || []).every((i) => exists(i.src)), 'manifest 里每个 icon 文件都存在');

r.done();
