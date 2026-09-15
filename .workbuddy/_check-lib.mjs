// ============================================================
// .workbuddy/_check-lib.mjs —— 校验脚本共享库
//
// 约定（必须与 .workbuddy/run-all-checks.mjs 的失败判定对齐）：
//   · 通过      → 打印 '  ✓ <说明>'
//   · 失败      → 打印 'FAIL  <说明>'（**必须顶格以 FAIL 开头**）
//                 runner 用 /^\s*(FAIL|✗)\b/ 统计，'✗ ' 后接空格不匹配，
//                 所以失败行统一用 FAIL 前缀，让「退出码」与「正则」两道判定都生效。
//   · 汇总      → 打印 '>>> <套件名>: N PASS / M FAIL'
//   · 退出码    → 有任一失败即 1，否则 0
//
// 沙盒：用 node:vm 复刻浏览器经典脚本的执行环境。
//   顶层 const/let/function 在经典脚本里是「全局词法绑定」，
//   同一 context 内分多次 runInContext 时彼此可见 —— 这正是浏览器 <script> 的行为，
//   因此可以按 index.html 的顺序逐个加载 js/ 下的文件。
// ============================================================
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const P = (...p) => resolve(root, ...p);
export const exists = (rel) => existsSync(P(rel));
export const read = (rel) => readFileSync(P(rel), 'utf8');
export function readJSON(rel) {
  try { return JSON.parse(read(rel)); } catch { return null; }
}

// ------------------------------------------------------------
// 断言与输出
// ------------------------------------------------------------
export function reporter(name) {
  let pass = 0;
  const fails = [];
  const api = {
    ok(msg) { pass++; console.log('  ✓ ' + msg); return true; },
    fail(msg) { fails.push(msg); console.log('FAIL  ' + msg); return false; },
    // 核心断言：cond 为真记通过，否则记失败
    check(cond, msg) { return cond ? api.ok(msg) : api.fail(msg); },
    eq(actual, expected, msg) {
      return api.check(actual === expected,
        `${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
    },
    // 仅记录信息，不计入断言
    info(msg) { console.log('  · ' + msg); },
    section(msg) { console.log('\n[' + msg + ']'); },
    done() {
      console.log('');
      console.log(`>>> ${name}: ${pass} PASS / ${fails.length} FAIL`);
      if (fails.length) {
        fails.forEach((f) => console.log('FAIL  ' + f));
        process.exit(1);
      }
      process.exit(0);
    },
    get fails() { return fails; },
    get pass() { return pass; },
  };
  return api;
}

// ------------------------------------------------------------
// 极简 DOM（仅覆盖本项目用到的 API；不是通用 DOM 实现）
// ------------------------------------------------------------
const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source']);

// 极简 HTML 解析：只建元素节点、记录 class/id 与内联事件属性，丢弃文本节点。
// 目的不是渲染，而是让 `el.innerHTML = tpl` 之后再 querySelector 能命中，
// 从而可以「行为级」断言 XSS 注入面（外部字符串是否被当作 HTML 解析出元素）。
function parseHTML(html, doc) {
  const out = [];
  const stack = [{ children: out }];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^>]*?)?)(\/?)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    last = re.lastIndex;
    if (m[0].startsWith('<!--')) continue;
    const closing = m[1] === '/';
    const tag = (m[2] || '').toLowerCase();
    const attrs = m[3] || '';
    const selfClose = m[4] === '/' || VOID_TAGS.has(tag);
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const node = makeElement(tag, doc);
    // 属性值可能是 "双引号" / '单引号' / 无引号三种写法，都要能取到
    const attrVal = (name) => {
      const rx = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`);
      const mm = attrs.match(rx);
      return mm ? (mm[2] ?? mm[3] ?? mm[4] ?? '') : null;
    };
    const cls = attrVal('class');
    if (cls) { node.className = cls; cls.split(/\s+/).filter(Boolean).forEach((c) => node.classList.add(c)); }
    const idv = attrVal('id');
    if (idv) { node.id = idv; doc.__ids.set(idv, node); }
    // 记录全部属性（含 data-*），供 getAttribute() 与属性选择器 [a="b"] 使用
    for (const am of attrs.matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      node.setAttribute(am[1], am[3] ?? am[4] ?? am[5] ?? '');
    }
    // 内联事件属性原样留存，便于断言「外部载荷未被当作 HTML 解析出可执行属性」
    for (const name of ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus']) {
      const v = attrVal(name);
      if (v !== null) node['_' + name] = v;
    }
    stack[stack.length - 1].children.push(node);
    node.parentNode = stack[stack.length - 1].node || null;
    if (!selfClose) stack.push({ node, children: node.children });
  }
  return out;
}

function makeElement(tag, doc) {
  const children = [];
  const attrs = new Map();
  const listeners = new Map();
  const classSet = new Set();
  const style = {
    setProperty(k, v) { style[k] = v; },
    removeProperty(k) { delete style[k]; },
    getPropertyValue(k) { return style[k] || ''; },
    cssText: '',
  };
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    nodeType: 1,
    id: '',
    className: '',
    value: '',
    checked: false,
    disabled: false,
    href: '',
    download: '',
    rel: '',
    src: '',
    alt: '',
    dataset: {},
    style,
    children,
    childNodes: children,
    parentNode: null,
    _text: '',
    get textContent() { return this._text; },
    // 真实 DOM 里 set textContent 会清空子节点。这里照做，
    // 从而可以断言「外部字符串走的是 textContent，没有产生元素节点」。
    set textContent(v) { this._text = String(v); children.length = 0; },
    _innerHTML: '',
    get innerHTML() { return this._innerHTML; },
    // 赋值时做一次极简解析，让后续 querySelector 能命中真实节点结构；
    // 同时保留 _innerHTML 原文，供断言「外部字符串没有被拼进 HTML」。
    set innerHTML(v) {
      this._innerHTML = String(v);
      const kids = parseHTML(this._innerHTML, doc);
      children.length = 0;
      kids.forEach((k) => { children.push(k); k.parentNode = node; });
    },
    get firstChild() { return children[0] || null; },
    get classList() {
      return {
        add: (...c) => c.forEach((x) => classSet.add(x)),
        remove: (...c) => c.forEach((x) => classSet.delete(x)),
        contains: (c) => classSet.has(c),
        toggle: (c, f) => {
          const on = f === undefined ? !classSet.has(c) : !!f;
          on ? classSet.add(c) : classSet.delete(c);
          return on;
        },
      };
    },
    appendChild(c) { children.push(c); c.parentNode = node; if (c.id) doc.__ids.set(c.id, c); return c; },
    removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); return c; },
    insertBefore(c) { children.unshift(c); c.parentNode = node; return c; },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },
    setAttribute(k, v) { attrs.set(k, String(v)); if (k === 'id') { node.id = String(v); doc.__ids.set(String(v), node); } },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
    removeEventListener() {},
    dispatchEvent() {},
    click() { (listeners.get('click') || []).forEach((fn) => fn({ preventDefault() {}, target: node })); },
    focus() {},
    querySelector(sel) { return queryAll(node, sel)[0] || null; },
    querySelectorAll(sel) { return queryAll(node, sel); },
    contains() { return false; },
    closest() { return null; },
    // 便于断言：拿所有后代元素
    get descendants() { const out = []; (function walk(n) { n.children.forEach((c) => { out.push(c); walk(c); }); })(node); return out; },
    matches: () => false,
    _attrs: attrs,
  };
  return node;
}

// 支持 '#id' / '.class' / 'tag' / 组合（空格分隔的简单后代选择器）
function queryAll(scopeNode, sel) {
  const parts = String(sel).trim().split(/\s+/);
  let pool = [scopeNode];
  for (const part of parts) {
    const next = [];
    for (const n of pool) {
      n.descendants.forEach((d) => { if (matchSimple(d, part)) next.push(d); });
    }
    pool = next;
    if (!pool.length) return [];
  }
  return pool;
}
function matchSimple(el, part) {
  if (part.startsWith('#')) return el.id === part.slice(1);
  if (part.startsWith('.')) return String(el.className).split(/\s+/).includes(part.slice(1)) || el.classList.contains(part.slice(1));
  // 属性选择器 [attr] / [attr="值"]（支持 data-*，供「按数据钩子定位元素」这类断言使用）
  const am = part.match(/^\[([a-zA-Z_:][-\w:.]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]$/);
  if (am) {
    const v = el.getAttribute(am[1]);
    const want = am[2] !== undefined ? am[2] : (am[3] !== undefined ? am[3] : am[4]);
    return want === undefined ? v !== null : v === want;
  }
  return el.tagName === part.toUpperCase();
}

/**
 * 造一个浏览器沙盒。
 * @param {object} opt
 *   opt.url       当前页面地址（默认 https 站点根）
 *   opt.protocol  location.protocol
 *   opt.storage   { key: value } 预置 localStorage
 *   opt.globals   额外注入的全局（如 toast / askDialog）
 */
export function makeEnv(opt = {}) {
  const url = opt.url || 'https://example.com/';
  const u = new URL(url);
  const store = new Map();
  for (const [k, v] of Object.entries(opt.storage || {})) {
    store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };

  const doc = {
    __ids: new Map(),
    createElement: (t) => makeElement(t, doc),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    getElementById: (id) => doc.__ids.get(id) || null,
    querySelector: (s) => queryAll(doc.__root, s)[0] || null,
    querySelectorAll: (s) => queryAll(doc.__root, s),
    addEventListener() {},
    removeEventListener() {},
    get head() { return doc.__head; },
    get body() { return doc.__body; },
    documentElement: null,
    readyState: 'complete',
    title: 'PromptForge',
  };
  doc.__head = makeElement('head', doc);
  doc.__body = makeElement('body', doc);
  doc.__root = makeElement('html', doc);
  doc.__root.appendChild(doc.__head);
  doc.__root.appendChild(doc.__body);
  doc.documentElement = doc.__root;
  doc.head.id = '__head';
  doc.body.id = '__body';
  doc.__ids.delete('__head'); doc.__ids.delete('__body');

  const g = {
    console,
    // 真定时器：脚本末尾 process.exit 会一并终止，无需清理
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  };

  const win = {
    ...g,                                  // console / 定时器/ 微任务
    document: doc,
    localStorage,
    location: { href: url, origin: u.origin, protocol: opt.protocol || u.protocol, pathname: u.pathname, search: '', hash: '', hostname: u.hostname, host: u.host, port: u.port },
    navigator: {
      userAgent: 'node-sandbox',
      language: 'zh-CN',
      gpu: null,
      clipboard: { writeText: async () => {}, readText: async () => '' },
      serviceWorker: { ready: Promise.resolve({ update: async () => {}, addEventListener() {} }), register: async () => ({}), addEventListener() {} },
      onLine: true,
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
    indexedDB: {},                       // LocalModelManager 的存在性检测
    caches: { open: async () => ({ keys: async () => [], delete: async () => true, match: async () => null, put: async () => {}, add: async () => {} }), keys: async () => [], match: async () => null, delete: async () => true },
    screen: { width: 1440, height: 900, colorDepth: 24 },
    addEventListener() {}, removeEventListener() {},
    fetch: opt.fetch || (async () => { throw new Error('sandbox: fetch 未桩'); }),
    URL, URLSearchParams, TextEncoder, TextDecoder,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    alert() {}, confirm: () => true, prompt: () => null,
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(16).slice(2) },
    ...(opt.globals || {}),
  };
  // window.window === window（代码里常见 window.X 写法）
  win.window = win;
  win.self = win;
  win.globalThis = win;
  win.top = win;
  win.parent = win;

  const ctx = vm.createContext(win);
  return {
    window: win, document: doc, localStorage,
    ctx,
    /** 预置一个带 id 的元素，供 document.getElementById 命中 */
    el(id, props = {}) {
      const e = makeElement(props.tag || 'div', doc);
      e.id = id;
      Object.assign(e, props);
      doc.__ids.set(id, e);
      doc.__body.appendChild(e);
      return e;
    },
    run(file) { vm.runInContext(read(file), ctx, { filename: file }); },
    eval(code) { return vm.runInContext(code, ctx, { filename: '<eval>' }); },
  };
}

// ------------------------------------------------------------
// 按 index.html 的顺序加载全部前端脚本（等价于浏览器加载整站）
// ------------------------------------------------------------
export const ALL_SCRIPTS = [
  'js/frameworks.js', 'js/storage.js', 'js/builtin-service.js', 'js/unified-llm.js',
  'js/offline-llm.js', 'js/device-detection.js', 'js/offline-ui.js', 'js/pwa.js',
  'js/api.js', 'js/sync.js', 'js/export.js', 'js/local-model.js', 'js/personalize.js',
  'js/style-variants.js', 'js/optimizer.js', 'js/optimize-ui.js', 'js/app.js',
];

export function loadAll(env, files = ALL_SCRIPTS) {
  for (const f of files) env.run(f);
  return env;
}

// ------------------------------------------------------------
// 静态源码扫描小工具
// ------------------------------------------------------------
export function jsFiles() {
  return readdirSync(P('js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f);
}
export function stripComments(src) {
  // 去掉 // 行注释与 /* */ 块注释，避免注释里的示例被误判
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
export { statSync };
