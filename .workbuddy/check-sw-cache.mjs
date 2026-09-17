// ============================================================
// check-sw-cache.mjs —— sw.js 的缓存名必须与前端资源版本（version.json 的 webVersion）一致
//
// 背景（真实发布缺陷）：sw.js 对静态资源（STATIC_PATHS 及**所有** .js/.css）走「缓存优先」，
// 浏览器仅在 sw.js 字节变化时才重装 SW ⇒「改了前端却不改 CACHE_NAME」会让网页端 PWA
// 用户永远吃到旧缓存、拿不到新前端。既有规则只覆盖「删除 js 文件要 CACHE_NAME+1」，
// 没覆盖「修改前端」这一类；本节把它固化成断言，并验证 bump 脚本**真的**会改写 sw.js。
//
// 校验目标：
//   A. 静态：sw.js 的 CACHE_NAME == promptforge-v<webVersion>（API_CACHE_NAME 同理）；
//      PROTECTED_CACHES 引用变量而非写死字符串；CACHE_NAME 行上方有「自动改写」说明注释。
//   B. 接线：bump-web-version.mjs 与 bump-version.mjs 都调用共享助手 scripts/sw-cache.mjs。
//   C. 执行级（临时副本，绝不碰工作区）：跑一次 bump-web-version → 两个缓存名都变成新版本，
//      且 sw.js 其余内容逐字节未变。
//   D. 严格性：目标文件 / 目标行缺失时脚本必须**非零退出**（拒绝静默跳过）。
//
// 输入：sw.js、version.json、scripts/sw-cache.mjs、scripts/bump-*.mjs（只读）
// 输出：逐条 '✓' / 'FAIL'，末行 '>>> check-sw-cache: N PASS / M FAIL'
// 失败判定：任一断言失败 → 打印顶格 'FAIL' 行并以退出码 1 结束
// ============================================================
import { read, readJSON, exists, reporter, P, stripComments } from './_check-lib.mjs';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const r = reporter('check-sw-cache');
const meta = readJSON('version.json');
const WV = String((meta && (meta.webVersion || meta.version)) || '').trim();
const sw = read('sw.js');

// ---- A. 静态一致性 ----
r.section('A. sw.js 缓存名 ↔ webVersion');
r.check(/^\d+\.\d+\.\d+$/.test(WV), `version.json 有合法的 webVersion（${WV}）`);
const mCache = sw.match(/const CACHE_NAME\s*=\s*'([^']*)'/);
const mApi = sw.match(/const API_CACHE_NAME\s*=\s*'([^']*)'/);
r.eq(mCache ? mCache[1] : null, `promptforge-v${WV}`,
  'CACHE_NAME 必须等于 promptforge-v<webVersion>（改前端必须 bump webVersion 以 bust 网页端缓存）');
r.eq(mApi ? mApi[1] : null, `promptforge-api-v${WV}`,
  'API_CACHE_NAME 必须等于 promptforge-api-v<webVersion>');
{
  const prot = (sw.match(/PROTECTED_CACHES\s*=\s*\[([^\]]*)\]/) || [])[1] || '';
  r.check(/\bCACHE_NAME\b/.test(prot) && /\bAPI_CACHE_NAME\b/.test(prot),
    'PROTECTED_CACHES 引用 CACHE_NAME / API_CACHE_NAME 变量（跟随版本，不写死）');
  r.check(!/promptforge-v/.test(prot), 'PROTECTED_CACHES 中没有写死的缓存名字符串');
}
{
  const lines = sw.split('\n');
  const idx = lines.findIndex((l) => /const CACHE_NAME\s*=/.test(l));
  const above = idx >= 0 ? lines.slice(Math.max(0, idx - 6), idx).join('\n') : '';
  r.check(/bump/.test(above) && /(自动改写|sw-cache)/.test(above),
    'CACHE_NAME 行上方有「由 bump 自动改写」说明注释（防后人手工改成任意值）');
}

// ---- B. bump 脚本接线 ----
r.section('B. bump 脚本接线');
r.check(exists('scripts/sw-cache.mjs'), '存在共享助手 scripts/sw-cache.mjs');
{
  const helper = read('scripts/sw-cache.mjs');
  r.check(/export\s+function\s+syncSwCache\b/.test(helper), 'sw-cache.mjs 导出 syncSwCache');
  r.check(/const\s+CACHE_NAME/.test(helper) && /const\s+API_CACHE_NAME/.test(helper),
    'sw-cache.mjs 以「赋值行」精确正则匹配 CACHE_NAME / API_CACHE_NAME（不误伤其它 vX.Y.Z 字样）');
}
for (const [file, label] of [
  ['scripts/bump-web-version.mjs', 'bump-web-version'],
  ['scripts/bump-version.mjs', 'bump-version'],
]) {
  const src = stripComments(read(file));
  r.check(/import\s*\{\s*syncSwCache\s*\}/.test(src) && /syncSwCache\(/.test(src),
    `${label} 引入并调用 syncSwCache（版本 bump 时自动改写 sw.js）`);
}

// ---- 影子副本：把相关文件拷到临时目录后运行脚本 ----
function shadow({ omitSw = false, corruptCacheLine = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'pf-swcache-'));
  mkdirSync(join(tmp, 'scripts'), { recursive: true });
  copyFileSync(P('scripts/bump-web-version.mjs'), join(tmp, 'scripts', 'bump-web-version.mjs'));
  copyFileSync(P('scripts/sw-cache.mjs'), join(tmp, 'scripts', 'sw-cache.mjs'));
  copyFileSync(P('version.json'), join(tmp, 'version.json'));
  if (!omitSw) {
    let body = read('sw.js');
    if (corruptCacheLine) {
      body = body.replace(/const CACHE_NAME\s*=\s*'[^']*';/, 'var SW_CACHE = /* 故意破坏 CACHE_NAME 行 */ 0;');
    }
    writeFileSync(join(tmp, 'sw.js'), body, 'utf8');
  }
  const run = spawnSync(process.execPath, [join(tmp, 'scripts', 'bump-web-version.mjs'), '9.9.9'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  return { tmp, run, swPath: join(tmp, 'sw.js') };
}

// ---- C. 执行级：bump-web-version 真的改写 sw.js ----
r.section('C. 执行级验证（临时副本）');
const originSw = read('sw.js');
const originVersion = read('version.json');
{
  const t = shadow();
  try {
    r.check(t.run.status === 0, `临时副本上脚本执行成功（exit=${t.run.status}）`);
    const after = readFileSync(t.swPath, 'utf8');
    r.check(after.includes("const CACHE_NAME = 'promptforge-v9.9.9';"),
      'CACHE_NAME 被改写为 promptforge-v9.9.9');
    r.check(after.includes("const API_CACHE_NAME = 'promptforge-api-v9.9.9';"),
      'API_CACHE_NAME 被改写为 promptforge-api-v9.9.9');
    // 逐字节：除那两行版本号外，其余内容一律不得变化（正则不误伤）
    const expected = originSw
      .replace(/const CACHE_NAME\s*=\s*'[^']*';/, "const CACHE_NAME = 'promptforge-v9.9.9';")
      .replace(/const API_CACHE_NAME\s*=\s*'[^']*';/, "const API_CACHE_NAME = 'promptforge-api-v9.9.9';");
    r.check(after === expected, 'sw.js 其余内容逐字节未变（只改了那两个缓存名版本号）');
    const vj = JSON.parse(readFileSync(join(t.tmp, 'version.json'), 'utf8'));
    r.check(vj.webVersion === '9.9.9', 'version.json 的 webVersion 同步为 9.9.9');
  } finally {
    rmSync(t.tmp, { recursive: true, force: true });
  }
  r.check(read('sw.js') === originSw && read('version.json') === originVersion,
    '工作区 sw.js / version.json 未被触碰（仅在临时副本上运行）');
}

// ---- D. 严格性：缺失即非零退出（拒绝静默跳过）----
r.section('D. 严格性：找不到就报错退出');
{
  const t = shadow({ omitSw: true });
  try {
    r.check(t.run.status !== 0, '临时副本不含 sw.js 时脚本非零退出（不静默跳过）');
    const msg = String(t.run.stderr || '') + String(t.run.stdout || '');
    r.check(/sw\.js|CACHE_NAME/.test(msg), '错误信息指向 sw.js / CACHE_NAME');
  } finally {
    rmSync(t.tmp, { recursive: true, force: true });
  }
}
{
  const t = shadow({ corruptCacheLine: true });
  try {
    r.check(t.run.status !== 0, 'sw.js 存在但匹配不到 CACHE_NAME 行时脚本非零退出');
  } finally {
    rmSync(t.tmp, { recursive: true, force: true });
  }
}

r.done();
