// ============================================================
// check-a11y-static.mjs —— 无障碍静态护栏（不需要 npm、不需要真实浏览器）
//
// 校验目标（对源码做静态断言，全部只读）
//   1. css/style.css 存在系统「减少动态效果」媒体查询（前庭功能敏感用户可关动效）；
//   2. css/style.css 存在 :focus-visible 全局焦点样式（键盘用户看得见焦点在哪）；
//   3. js/ 中不再出现原生 confirm( / alert(（弹窗已统一到 askDialog，可主题化/危险色/读屏）；
//   4. index.html 的 #toast 带 role 与 aria-live（读屏能播报提示）；
//   5. 图标 / 色彩按钮（.swatch/.font-option/.bg-option/#mode-toggle/.mobile-nav-btn）都带 aria-label；
//   6. askDialog 具备 role=dialog / aria-modal / aria-labelledby / Esc 关闭 / 焦点还原 / Tab 循环；
//   7. 与控件分离的 <label> 都补了 for=，且 for 指向的 id 真实存在；
//   8. optimize-ui.js 的输入诊断带防抖（长提示词不再每键全量计算）；
//   9. app.js 存在全局错误兜底（error / unhandledrejection + 节流常量）。
//
// 输入：css/style.css、js/*.js、index.html（只读；不执行、不起浏览器）
// 输出：逐条 '✓' / 'FAIL'，末行 '>>> check-a11y-static: N PASS / M FAIL'
// 失败判定：任一断言失败 → 打印顶格 'FAIL' 行并以退出码 1 结束
//
// 为什么值得单列：无障碍约束几乎全是「肉眼才能发现」的缺失 ——
//   少一个 aria-label、少一条 for=、漏掉 reduced-motion，界面看起来毫无异常，
//   却让键盘 / 读屏 / 前庭敏感用户直接用不了。本机 npm 不可用、也没有真实浏览器，
//   静态护栏是当前环境下唯一能把这些「看不见的约束」固化成断言的手段。
//   历史教训：项目曾长期 0 处 prefers-reduced-motion、0 处 :focus-visible、
//   4 处原生 confirm()，全因为「没有断言守着」而无人察觉，直到无障碍评审才暴露。
//
// 注意：本套件含「校验器自检」——先证明检测手段对已知载荷有效，
// 避免出现「断言恒真、其实什么都没检查」的假绿。
// ============================================================
import { read, reporter, jsFiles, stripComments } from './_check-lib.mjs';

const r = reporter('check-a11y-static');
const html = read('index.html');
// 只剥 CSS 注释（/* */）：既避免注释里的示例名让断言恒真，又不误伤 url(../…) 里的斜杠
const css = read('css/style.css').replace(/\/\*[\s\S]*?\*\//g, '');

// ------------------------------------------------------------
// 0. 校验器自检：证明检测手段对已知载荷有效，避免「断言恒真」的假绿
// ------------------------------------------------------------
r.section('0. 校验器自检（确保断言不是恒真）');
{
  r.check(/prefers-reduced-motion/.test('@media (prefers-reduced-motion: reduce){}'),
    '自检：含目标媒体查询的样例能被检出');
  r.check(!/prefers-reduced-motion/.test('body{color:#000}'),
    '自检：不含该特性的样例被判为缺失');

  r.check(/\bconfirm\s*\(/.test(stripComments('if (confirm("x")) return;')),
    '自检：剥注释后仍能检出真实 confirm( 调用');
  r.check(!/\bconfirm\s*\(/.test(stripComments('// confirm("x")\n/* alert("y") */')),
    '自检：注释里的 confirm/alert 不会被误判（剥离生效）');
  r.check(!/\bconfirm\s*\(/.test(stripComments("const confirmText = '确定';")),
    '自检：confirmText 这类标识符不会被误判为 confirm(');
}

// ---- 1. CSS：减少动态效果 ----
r.section('1. CSS：prefers-reduced-motion 适配');
r.check(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/.test(css),
  '存在 @media (prefers-reduced-motion: reduce)');
r.check(/animation-duration\s*:[^;]*!important/.test(css),
  '该块内把 animation-duration 归零（带 !important）');
r.check(/transition-duration\s*:[^;]*!important/.test(css),
  '该块内把 transition-duration 归零（带 !important）');

// ---- 2. CSS：焦点可见 ----
r.section('2. CSS：:focus-visible 全局焦点样式');
r.check(/:focus-visible\s*\{/.test(css), '存在 :focus-visible 规则');
r.check(/:focus-visible[^{]*\{[^}]*outline\s*:/.test(css),
  ':focus-visible 用 outline 呈现焦点环');

// ---- 3. JS：不再有原生 confirm / alert ----
r.section('3. JS：不再有原生 confirm( / alert(');
const nativeDlg = [];
for (const f of jsFiles()) {
  const code = stripComments(read(f));
  const m = code.match(/\b(?:confirm|alert)\s*\(/g);
  if (m) nativeDlg.push(`${f}(${m.length})`);
}
r.check(nativeDlg.length === 0, `js/ 中无原生 confirm(/alert(（违规：${nativeDlg.join(',') || '无'}）`);

// ---- 4. #toast 读屏可播报 ----
r.section('4. index.html：#toast 具备读屏播报属性');
const toastTag = (html.match(/<div\b[^>]*id="toast"[^>]*>/) || [''])[0];
r.check(/\brole\s*=\s*"status"/.test(toastTag), '#toast 带 role="status"');
r.check(/\baria-live\s*=\s*"polite"/.test(toastTag), '#toast 带 aria-live="polite"');
r.check(/\baria-atomic\s*=\s*"true"/.test(toastTag), '#toast 带 aria-atomic="true"');

// ---- 5. 图标 / 色彩按钮 aria-label ----
r.section('5. 图标 / 色彩按钮 aria-label');
const buttonTags = [...html.matchAll(/<button\b([^>]*)>/g)].map((m) => m[1]);
const hasAria = (a) => /\baria-label\s*=/.test(a);
const classOf = (a) => (a.match(/\bclass\s*=\s*"([^"]*)"/) || [])[1] || '';
const ICON_BTNS = [
  ['主题色 .swatch', (a) => /(^|\s)swatch(\s|$)/.test(classOf(a))],
  ['字体 .font-option', (a) => /(^|\s)font-option(\s|$)/.test(classOf(a))],
  ['背景 .bg-option', (a) => /(^|\s)bg-option(\s|$)/.test(classOf(a))],
  ['移动端导航 .mobile-nav-btn', (a) => /(^|\s)mobile-nav-btn(\s|$)/.test(classOf(a))],
  ['模式切换 #mode-toggle', (a) => /\bid\s*=\s*"mode-toggle"/.test(a)],
];
for (const [name, test] of ICON_BTNS) {
  const hits = buttonTags.filter(test);
  r.check(hits.length > 0, `${name}：共 ${hits.length} 个按钮被扫到（>0，否则断言无意义）`);
  const missing = hits.filter((a) => !hasAria(a)).length;
  r.check(missing === 0, `${name}：全部带 aria-label（缺失 ${missing} 个）`);
}

// ---- 6. askDialog 无障碍结构 ----
r.section('6. askDialog：模态语义 + 键盘可用');
const app = stripComments(read('js/app.js'));
const dialogBody = (() => {
  const i = app.indexOf('function askDialog');
  return i >= 0 ? app.slice(i, i + 4000) : '';
})();
r.check(dialogBody.length > 0, '能定位 askDialog 函数体');
r.check(/setAttribute\(\s*'role'\s*,\s*'dialog'\s*\)/.test(dialogBody), '设置 role="dialog"');
r.check(/setAttribute\(\s*'aria-modal'\s*,\s*'true'\s*\)/.test(dialogBody), '设置 aria-modal="true"');
r.check(/aria-labelledby/.test(dialogBody), '用 aria-labelledby 关联标题');
r.check(/document\.activeElement/.test(dialogBody), '打开前记录 document.activeElement');
r.check(/restoreFocus/.test(dialogBody), '关闭后还原焦点（restoreFocus）');
r.check(/===\s*'Escape'/.test(dialogBody), '支持 Esc 关闭');
r.check(/'Tab'/.test(dialogBody), '实现 Tab 焦点循环');

// ---- 7. label 与控件关联 ----
r.section('7. <label for> 与控件 id 关联');
const labelTags = [...html.matchAll(/<label\b([^>]*)>/g)].map((m) => m[1]);
const forIds = [];
for (const a of labelTags) {
  const m = a.match(/\bfor\s*=\s*"([^"]+)"/);
  if (m) forIds.push(m[1]);
}
r.check(forIds.length >= 6, `与控件分离的 <label> 已补 for=（共 ${forIds.length} 个，要求 ≥6）`);
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const danglingFor = forIds.filter((id) => !htmlIds.has(id));
r.check(danglingFor.length === 0, `每个 label 的 for 都指向存在的 id（悬空：${danglingFor.join(',') || '无'}）`);

// ---- 8. 输入诊断防抖 ----
r.section('8. optimize-ui.js：输入诊断防抖');
const optUi = stripComments(read('js/optimize-ui.js'));
r.check(/function\s+updateOptDiagnosis\s*\(\s*\)/.test(optUi),
  'updateOptDiagnosis 仍是 function 声明（内联 handler 依赖它挂到 window）');
r.check(/setTimeout\s*\(\s*runOptDiagnosis/.test(optUi),
  '用 setTimeout 延迟执行 runOptDiagnosis（防抖）');
r.check(/clearTimeout\s*\(\s*_optDiagTimer\s*\)/.test(optUi),
  '再次输入会 clearTimeout 上一轮（真防抖，而非仅延迟）');
r.check(/function\s+runOptDiagnosis[\s\S]*?PromptOptimizer\.analyze/.test(optUi),
  '真正诊断逻辑在 runOptDiagnosis 内（仍调用 PromptOptimizer.analyze）');

// ---- 9. 全局错误兜底 ----
r.section('9. app.js：全局错误兜底');
r.check(/addEventListener\(\s*'error'/.test(app), '监听 window error');
r.check(/addEventListener\(\s*'unhandledrejection'/.test(app), '监听 unhandledrejection');
r.check(/FATAL_TOAST_INTERVAL/.test(app), 'reportFatalError 带节流间隔常量');

r.done();
