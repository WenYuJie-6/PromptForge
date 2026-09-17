// ============================================================
// check-runtime-info.mjs —— 运行时信息（程序版本 / 前端资源版本 / 本次实际服务端口）
//
// 用户痛点（真实反馈）："我有点找不到软件版所在的端口了，甚至分不清现在桌面上安装迭代
// 的是哪个版本"。本轮修复把三样东西显式暴露给用户：
//   · 后端：新命令 get_runtime_info 返回 app_version / web_version / serve_port
//     （端口来自本次真实监听，14370..14390 首个空闲，全占用才退随机 —— 绝不写死）；
//   · 前端：侧栏底部一行概要"v<app> · 前端 <web> · :<port>"（网页端不带端口）；
//     设置页"本次服务地址 http://127.0.0.1:<port>/"一行（仅桌面端显示）。
//
// 校验目标：
//   A. index.html 真的存在 serve-port / serve-port-row / runtime-badge 三个元素；
//   B. app.js 确实读取并填充它们；非桌面环境隐藏端口行；概要行有回退（不产生 undefined）；
//      且展示值不来自硬编码端口；
//   C. Rust：get_runtime_info 命令存在、已注册、以托管状态读取真实端口；
//   D. 行为（沙盒真跑 makeEnv + loadAll）：
//        1) 桩定 servePort=14371 → 界面显示 14371（而不是默认的 14370）；
//        2) 桩定 servePort=14375 → 界面随之变化（证明非硬编码）；
//        3) 无 __TAURI__（网页端）→ 端口行隐藏、概要行不含 undefined、不抛异常；
//        4) invoke 抛错 → 不抛异常、端口行隐藏、概要行仍非空。
//
// 输入：index.html、js/app.js、src-tauri/src/lib.rs（只读）
// 输出：逐条 '✓' / 'FAIL'，末行 '>>> check-runtime-info: N PASS / M FAIL'
// 失败判定：任一断言失败 → 打印顶格 'FAIL' 行并以退出码 1 结束
// ============================================================
import { read, reporter, stripComments, makeEnv, loadAll } from './_check-lib.mjs';

const r = reporter('check-runtime-info');
const html = read('index.html');
const sw = (() => { try { return read('sw.js'); } catch { return ''; } })();
const appRaw = read('js/app.js');
const app = stripComments(appRaw);
const rs = read('src-tauri/src/lib.rs');

// 从 JS 源码中按花括号配平切出某个函数的函数体（与 check-a11y-static 同款手法）。
// 不用固定字符数截取：函数一旦变长，断言会静默失配。
function extractFunctionBody(src, name) {
  const start = src.indexOf('function ' + name);
  if (start < 0) return '';
  const open = src.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

// Rust 版函数体切片：找 `fn <name>` 后按花括号配平（Rust 不写 function 关键字）。
function extractRustFnBody(src, name) {
  const m = new RegExp(`\\bfn\\s+${name}\\b`).exec(src);
  if (!m) return '';
  const open = src.indexOf('{', m.index);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
  }
  return src.slice(m.index);
}

// ---- A. index.html 元素存在 ----
r.section('A. index.html 元素');
r.check(/\bid="serve-port"/.test(html), 'index.html 存在 id="serve-port"（设置页服务地址）');
r.check(/\bid="serve-port-row"/.test(html), 'index.html 存在 id="serve-port-row"（可整体隐藏的行容器）');
r.check(/\bid="runtime-badge"/.test(html), 'index.html 存在 id="runtime-badge"（侧栏底部版本概要）');
{
  // 概要行的初始文本必须非空 —— 即便 JS 完全没跑，也不能出现空白/undefined。
  const badgeTag = (html.match(/<div\b[^>]*id="runtime-badge"[^>]*>([\s\S]*?)<\/div>/) || [])[1] ?? '';
  r.check(badgeTag.trim().length > 0, 'runtime-badge 初始文本非空（JS 未执行也不空白）');
  r.check(!/undefined/i.test(badgeTag), 'runtime-badge 初始文本不含 undefined');
}

// ---- B. app.js 读取 / 填充 / 隐藏 / 回退 ----
r.section('B. app.js 接线与回退');
r.check(/function\s+initRuntimeInfo\b/.test(app), 'app.js 定义了 initRuntimeInfo（function 声明）');
r.check(/document\.getElementById\(\s*'serve-port'\s*\)/.test(app),
  'initRuntimeInfo 读取 serve-port');
r.check(/document\.getElementById\(\s*'runtime-badge'\s*\)/.test(app),
  'initRuntimeInfo 读取 runtime-badge');
r.check(/document\.getElementById\(\s*'serve-port-row'\s*\)/.test(app),
  'initRuntimeInfo 读取 serve-port-row');
r.check(/initRuntimeInfo\s*\(\s*\)/.test(app) && /DOMContentLoaded/.test(app),
  'initRuntimeInfo 在 DOMContentLoaded 初始化链里被调用');
r.check(/tauriInvoke\(\s*'get_runtime_info'\s*\)/.test(app),
  '通过既有 tauriInvoke 调用后端 get_runtime_info');
r.check(/serve_port/.test(app), '读取后端返回的 serve_port（端口来自后端，非硬编码）');
r.check(/classList\.add\(\s*'hidden'\s*\)/.test(app),
  '非桌面 / 读取失败时把端口行隐藏（classList.add("hidden")）');

{
  const body = extractFunctionBody(app, 'initRuntimeInfo');
  r.check(body.length > 0, '能按函数边界定位 initRuntimeInfo 函数体');
  // 端口展示值必须来自后端字段，绝不能写死端口号（如 14370）。
  r.check(!/\b14(3[7-9]\d|4\d\d)\b/.test(body),
    'initRuntimeInfo 函数体内不含硬编码端口号（14370..14499）');
  // 概要行：必须经统一 setter 写入回退值，读不到时回退占位，绝不为空。
  r.check(/setBadge\s*=/.test(body) && /textContent\s*=\s*text\s*\|\|/.test(body),
    '概要行经 setBadge 写入并带 "|| 占位" 回退（读不到不为空）');
  // 优雅降级：invoke 失败走 catch，而不是让异常冒泡到全局错误兜底。
  r.check(/catch\s*\{/.test(body), 'initRuntimeInfo 带 catch 优雅降级（invoke 失败不抛给用户）');
}

// ---- C. Rust 后端 ----
r.section('C. Rust 后端（src-tauri/src/lib.rs）');
r.check(/fn\s+get_runtime_info\b/.test(rs), '存在命令 get_runtime_info');
r.check(/generate_handler!\[[\s\S]*?\bget_runtime_info\b/.test(rs),
  'get_runtime_info 已注册进 invoke_handler（否则前端调用报 unknown command）');
r.check(/struct\s+AppState\b[\s\S]{0,400}?serve_port\s*:\s*u16/.test(rs),
  'AppState 托管了本次实际端口 serve_port: u16');
{
  const gi = extractRustFnBody(rs, 'get_runtime_info');
  r.check(gi.length > 0, '能定位 get_runtime_info 函数体');
  r.check(/serve_port/.test(gi), 'get_runtime_info 返回 serve_port');
  r.check(/app_version/.test(gi), 'get_runtime_info 返回 app_version');
  r.check(/current_web_version\(/.test(gi), 'get_runtime_info 返回当前生效的前端版本（前端轴）');
  r.check(/try_state::<AppState>|state::<AppState>/.test(gi),
    'get_runtime_info 从托管状态读取端口（而非重新 bind / 写死）');
}
// 端口分配策略不得被本次改动改变：仍是 14370..14390 首个空闲，再退随机。
r.check(/for\s+port\s+in\s+14370\.\.14390/.test(rs), '端口分配策略未变（14370..14390 首个空闲）');

// ---- D. 行为：沙盒真跑 ----
r.section('D. 行为验证（沙盒真跑）');

// 造一个运行环境：按 index.html 顺序加载全部前端脚本。
// desktop=true 时注入 __TAURI_INTERNALS__（模拟桌面端），invoke 由 opt.invoke 桩定。
function setup(opt = {}) {
  const calls = [];
  const env = makeEnv({
    url: 'http://127.0.0.1:14371/',
    protocol: 'http:',
    globals: {
      // 只在桌面端注入；网页端保持 undefined（typeof 判定为 'undefined'）
      __TAURI_INTERNALS__: opt.desktop
        ? {
            invoke: async (cmd, args) => {
              calls.push({ cmd, args });
              if (opt.invokeError) throw (opt.invokeError === true ? new Error('boom') : opt.invokeError);
              if (cmd === 'get_runtime_info') return opt.runtimeInfo || { app_version: '0.2.1', web_version: '0.2.2', serve_port: 14371, is_desktop: true };
              return null;
            },
          }
        : undefined,
      // version.json 兜底：网页端据它显示前端版本
      fetch: async (u) => {
        if (String(u).includes('version.json')) {
          return { ok: true, status: 200, json: async () => (opt.manifest || { version: '0.2.1', webVersion: '0.2.2' }) };
        }
        return { ok: false, status: 404, json: async () => null };
      },
    },
  });
  loadAll(env);
  // 预置三个真实存在的元素（与 index.html 一一对应）
  env.el('serve-port', { tag: 'a' });
  env.el('serve-port-row');
  env.el('runtime-badge');
  return { env, calls };
}

// D1. 桌面端：桩定 servePort=14371 → 界面显示 14371
{
  const t = setup({ desktop: true, runtimeInfo: { app_version: '0.2.1', web_version: '0.2.2', serve_port: 14371, is_desktop: true } });
  let err = null;
  try { await t.env.eval('initRuntimeInfo()'); } catch (e) { err = e; }
  r.check(!err, '桌面端调用 initRuntimeInfo 不抛异常');
  const portEl = t.env.document.getElementById('serve-port');
  const row = t.env.document.getElementById('serve-port-row');
  const badge = t.env.document.getElementById('runtime-badge');
  r.eq(portEl.textContent, 'http://127.0.0.1:14371/', '端口行显示本次实际端口 14371');
  r.check(!row.classList.contains('hidden'), '桌面端端口行可见（未加 hidden）');
  r.check(badge.textContent.includes(':14371'), '概要行含 :14371');
  r.check(badge.textContent.includes('v0.2.1') && badge.textContent.includes('0.2.2'),
    '概要行同时含程序版本 v0.2.1 与前端版本 0.2.2');
}

// D2. 桌面端：换一个端口（14375）→ 随之变化（证明不是硬编码）
{
  const t = setup({ desktop: true, runtimeInfo: { app_version: '0.2.1', web_version: '0.2.2', serve_port: 14375, is_desktop: true } });
  await t.env.eval('initRuntimeInfo()');
  const portEl = t.env.document.getElementById('serve-port');
  const badge = t.env.document.getElementById('runtime-badge');
  r.eq(portEl.textContent, 'http://127.0.0.1:14375/', '换端口后端口行随之变为 14375');
  r.check(!portEl.textContent.includes('14371'), '端口行不再残留 14371（非硬编码）');
  r.check(badge.textContent.includes(':14375'), '概要行随之变为 :14375');
}

// D3. 网页端（无 __TAURI__）→ 端口行隐藏、概要行无 undefined、不抛异常
{
  const t = setup({ desktop: false });
  let err = null;
  try { await t.env.eval('initRuntimeInfo()'); } catch (e) { err = e; }
  r.check(!err, '网页端调用 initRuntimeInfo 不抛异常（__TAURI__ 缺失被优雅跳过）');
  const row = t.env.document.getElementById('serve-port-row');
  const badge = t.env.document.getElementById('runtime-badge');
  r.check(row.classList.contains('hidden'), '网页端端口行被隐藏');
  r.check(!/undefined/.test(badge.textContent), '网页端概要行不含 undefined');
  r.check(badge.textContent.trim().length > 0, '网页端概要行仍非空（回退到已知版本）');
  r.check(!t.calls.some((c) => c.cmd === 'get_runtime_info'), '网页端未调用桌面端命令');
}

// D4. 桌面端但 invoke 抛错 → 不抛异常、端口行隐藏、概要行仍非空
{
  const t = setup({ desktop: true, invokeError: true });
  let err = null;
  try { await t.env.eval('initRuntimeInfo()'); } catch (e) { err = e; }
  r.check(!err, 'invoke 抛错时不向外抛（走 catch 优雅降级）');
  const row = t.env.document.getElementById('serve-port-row');
  const badge = t.env.document.getElementById('runtime-badge');
  r.check(row.classList.contains('hidden'), 'invoke 失败时端口行隐藏');
  r.check(!/undefined/.test(badge.textContent), 'invoke 失败时概要行不含 undefined');
  r.check(badge.textContent.trim().length > 0, 'invoke 失败时概要行仍非空');
}

// ---- E. 一致性护栏：新增 id 必须在 sw.js 缓存范围之外也无需改动，但脚本数不变 ----
r.section('E. 脚本与缓存一致性');
{
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  r.eq(srcs.length, 17, '未新增前端脚本（仍为 17 个 <script src>）');
  if (sw) {
    const cachedJs = [...sw.matchAll(/'(\.\/js\/[^']*)'/g)].map((m) => m[1].slice(2));
    r.check(srcs.every((s) => cachedJs.includes(s)), 'index.html 的脚本仍全部在 sw.js 缓存清单中');
  }
}

r.done();
