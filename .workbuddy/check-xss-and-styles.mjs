// ============================================================
// check-xss-and-styles.mjs —— XSS 注入面 + 样式幂等注入
//
// 校验目标
//   XSS：
//     1. 静态 —— 全项目 `.innerHTML` 模板里的插值，禁止出现 err/error/.message 这类
//        外部文本；标题类文案（title/confirmText/cancelText）必须经 escapeHTML()；
//     2. 行为 —— 把真实载荷 `<img src=x onerror=alert(1)>` 当作错误消息喂进
//        renderDeviceInfo() 的失败分支，断言它只出现在 textContent 里、
//        没有生成 <img> 元素、没有产生 onerror 属性；
//     3. 行为 —— setModelStatus() 走 textContent（innerHTML 从未被赋值）。
//   样式幂等：
//     4. injectStyleOnce(id, css) 连调多次只注入 1 个 <style>；
//     5. pwa.js 的两处注入点都走 injectStyleOnce，没有裸 createElement('style')。
//
// 输入：js/*.js（静态）+ js/offline-ui.js / js/pwa.js（沙盒执行）
// 输出：逐条 '✓' / 'FAIL'，末行 '>>> check-xss-and-styles: N PASS / M FAIL'
// 失败判定：任一断言失败 → 打印 FAIL 行并以退出码 1 结束
//
// 注意：本套件含「校验器自检」——先证明检测手段对已知载荷有效，
// 避免出现「断言恒真、什么都没检查」的假绿。
// ============================================================
import { makeEnv, reporter, jsFiles, read, stripComments } from './_check-lib.mjs';

const r = reporter('check-xss-and-styles');
const PAYLOAD = '<img src=x onerror=alert(1)>';

// ---- 0. 校验器自检：证明检测手段有效 ----
r.section('0. 校验器自检（确保断言不是恒真）');
{
  const probe = makeEnv();
  const box = probe.el('probe-box');
  box.innerHTML = `<div class="wrap">${PAYLOAD}</div>`;
  const img = box.descendants.find((d) => d.tagName === 'IMG');
  r.check(!!img, '自检：innerHTML 注入的载荷确实会被解析成 <img> 元素');
  r.check(!!img && img._onerror === 'alert(1)', '自检：载荷上的 onerror 内联事件被检出');
  const clean = probe.el('clean-box');
  clean.textContent = PAYLOAD;
  r.check(clean.descendants.length === 0, '自检：同样的载荷走 textContent 不产生任何元素');
}

// ---- A. 静态：innerHTML 插值 ----
r.section('A. 静态扫描：innerHTML 插值');
const LIT_RE = /\.innerHTML\s*\+?=\s*(`[\s\S]*?`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
const INT_RE = /\$\{([^}]*)\}/g;
const allInterps = [];
for (const f of jsFiles()) {
  const src = stripComments(read(f));
  for (const m of src.matchAll(LIT_RE)) {
    const lit = m[1];
    if (!lit.startsWith('`')) continue;
    for (const im of lit.matchAll(INT_RE)) allInterps.push({ file: f, expr: im[1].trim() });
  }
}
r.check(allInterps.length > 0, `扫到 ${allInterps.length} 处 innerHTML 插值（>0 说明扫描有效）`);

// 外部错误文本绝不允许进 innerHTML（必须走 textContent）
const DANGEROUS = /\b(err|error|message|reason|detail)\b/;
const bad = allInterps.filter((x) => DANGEROUS.test(x.expr) || /\.message\b/.test(x.expr));
r.check(bad.length === 0,
  `无 innerHTML 插值引用错误对象（违规：${bad.map((x) => x.file + ':${' + x.expr + '}').join(' / ') || '无'}）`);

// 弹窗文案必须转义（历史缺陷：title/正文被直接拼进 innerHTML）
const MUST_ESCAPE = ['title', 'confirmText', 'cancelText'];
const unescaped = [];
for (const x of allInterps) {
  for (const name of MUST_ESCAPE) {
    if (new RegExp(`\\b${name}\\b`).test(x.expr) && !/^\s*escapeHTML\s*\(/.test(x.expr)) {
      unescaped.push(`${x.file}: ${name} -> ${x.expr}`);
    }
  }
}
r.check(unescaped.length === 0,
  `弹窗文案插值都经 escapeHTML()（未转义：${unescaped.join(' / ') || '无'}）`);
r.check(jsFiles().some((f) => /function\s+escapeHTML\s*\(/.test(read(f))), 'escapeHTML() 已定义');

// ---- B. 行为：真实载荷进 renderDeviceInfo 失败分支 ----
r.section('B. 行为验证：载荷进注入面');
{
  const env = makeEnv({
    globals: {
      // 让设备检测以载荷作为错误消息失败
      DeviceDetector: { detectDevice: async () => { throw new Error(PAYLOAD); } },
      OfflineLLM: { getDevice: async () => 'wasm' },
    },
  });
  env.run('js/offline-ui.js');
  const host = env.el('device-info');
  await env.eval('renderDeviceInfo()');

  r.check(host.innerHTML.includes('device-error'), '失败分支渲染了错误骨架');
  r.check(!host.innerHTML.includes('<img'), 'innerHTML 中不含载荷标签（未被拼进 HTML）');
  const msgEl = host.querySelector('.device-error-msg');
  r.check(!!msgEl, '能定位到错误消息节点 .device-error-msg');
  r.check(!!msgEl && msgEl.textContent === PAYLOAD, '载荷原样进入 textContent（未被解析/转义丢失）');
  r.check(host.descendants.filter((d) => d.tagName === 'IMG').length === 0, '没有生成任何 <img> 元素');
  r.check(host.descendants.every((d) => !d._onerror), '没有任何元素带 onerror 内联属性');
  r.check(host.innerHTML !== PAYLOAD, 'innerHTML 不等于载荷本身');
}

// ---- C. 行为：setModelStatus 走 textContent ----
r.section('C. 行为验证：setModelStatus');
{
  const env = makeEnv();
  env.run('js/offline-ui.js');
  const el = env.el('model-status');
  env.eval(`setModelStatus(${JSON.stringify(PAYLOAD)}, 'var(--danger)')`);
  r.check(el.textContent === PAYLOAD, 'setModelStatus 用 textContent 原样写入');
  r.check(el._innerHTML === '', 'setModelStatus 从未给 innerHTML 赋值');
  r.check(el.children.length === 0, 'setModelStatus 未产生任何元素节点');
  r.check(el.style.color === 'var(--danger)', 'setModelStatus 同步设置了颜色');
}

// ---- D. 行为：injectStyleOnce 幂等 ----
r.section('D. 样式幂等注入');
{
  const src = read('js/pwa.js');
  const m = src.match(/function\s+injectStyleOnce\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  r.check(!!m, '能从 pwa.js 提取到 injectStyleOnce 源码');
  const env = makeEnv();
  env.eval(m[0]);
  const CSS = '@keyframes pf-k { from { opacity: 0 } to { opacity: 1 } }';
  for (let i = 0; i < 3; i++) env.eval(`injectStyleOnce('pf-probe-style', ${JSON.stringify(CSS)})`);
  const injected = env.document.head.children.filter((c) => c.id === 'pf-probe-style');
  r.eq(injected.length, 1, '同一 id 连调 3 次只注入 1 个 <style>');
  env.eval(`injectStyleOnce('pf-probe-style-2', ${JSON.stringify(CSS)})`);
  r.eq(env.document.head.children.filter((c) => c.id.startsWith('pf-probe-style')).length, 2, '不同 id 各自注入 1 个');
  r.check(/getElementById\(id\)/.test(m[0]), 'injectStyleOnce 内含「已存在则跳过」的守卫');
}

// ---- E. 静态：pwa.js 的注入点 ----
r.section('E. 静态扫描：pwa.js 注入方式');
{
  const pwa = stripComments(read('js/pwa.js'));
  const fnMatch = pwa.match(/function\s+injectStyleOnce\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  r.check(!!fnMatch, '能定位 injectStyleOnce 的函数体');
  const start = fnMatch ? pwa.indexOf(fnMatch[0]) : -1;
  const end = start + (fnMatch ? fnMatch[0].length : 0);

  // 关键点：createElement('style') 与 head.appendChild 允许存在，但只能出现在
  // injectStyleOnce 内部 —— 出现在别处就意味着绕过了幂等守卫。
  const findOutside = (re) => {
    const out = [];
    let m;
    while ((m = re.exec(pwa)) !== null) {
      if (m.index < start || m.index > end) out.push(pwa.slice(m.index, m.index + 40).replace(/\s+/g, ' '));
    }
    return out;
  };
  const rawCreate = findOutside(/document\.createElement\(\s*['"]style['"]\s*\)/g);
  const rawAppend = findOutside(/head\.appendChild\s*\(/g);
  r.check(rawCreate.length === 0, `createElement('style') 只出现在 injectStyleOnce 内（越界：${rawCreate.join(' / ') || '无'}）`);
  r.check(rawAppend.length === 0, `head.appendChild 只出现在 injectStyleOnce 内（越界：${rawAppend.join(' / ') || '无'}）`);

  const calls = (pwa.match(/injectStyleOnce\s*\(/g) || []).length;
  r.check(calls >= 3, `pwa.js 引用 injectStyleOnce ${calls} 次（≥3：1 处定义 + 2 处注入点）`);
}

r.done();
