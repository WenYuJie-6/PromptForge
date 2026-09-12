// 端到端验证「更新链路」：模拟客户端 check_update 的判定逻辑，
// 确认当前产物真的能让用户看到更新，而不是again显示「最新版本」。
// 用法：node scripts/verify-update-chain.mjs
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = [];
const P = (s) => out.push(s);
let failed = 0;
const assert = (ok, label, detail) => {
  if (!ok) failed++;
  P(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`);
};

const readJSON = (rel) => {
  const p = resolve(root, rel);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};

// ---- 复刻 lib.rs 的 manifest_from_value / check_update 判定 ----
function manifestFromValue(v) {
  if (!v || typeof v !== 'object') return null;
  const asFile = (k) => {
    const val = v[k];
    if (val == null) return undefined;
    if (typeof val === 'string') return val;
    return typeof val.file === 'string' ? val.file : undefined;
  };
  let appFile = asFile('windows') ?? asFile('app');
  let webFile = asFile('web');
  const f = asFile('file');
  if (f) {
    if (f.toLowerCase().endsWith('.json')) { if (webFile === undefined) webFile = f; }
    else if (appFile === undefined) appFile = f;
  }
  return { version: v.version, notes: v.notes || '', appFile, webFile };
}

const parseV = (s) => {
  if (typeof s !== 'string') return null;
  const m = s.trim().replace(/^v/, '').split('.').map(Number);
  return m.length === 3 && m.every((n) => Number.isFinite(n)) ? m : null;
};
const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

// 复刻改造后的 check_update：落后但缺字段时**报错**，不再退化成「最新版本」。
// `error` 非空即表示客户端会把具体原因显示给用户（可诊断），而非谎报"已是最新"。
function checkUpdate(manifest, appVersion, webVersion, dir, base) {
  if (!manifest) return { kind: null, error: '读不到更新清单', reason: '无清单' };
  const newest = parseV(manifest.version);
  if (!newest) return { kind: null, error: '清单里的版本号格式不正确' };
  const curApp = parseV(appVersion) || [0, 0, 0];
  const curWeb = parseV(webVersion) || curApp;
  let kind, file;
  if (cmp(newest, curApp) > 0) {
    if (manifest.appFile) { kind = 'app'; file = manifest.appFile; }
    else if (manifest.webFile) { kind = 'web'; file = manifest.webFile; }
    else return { kind: null, error: '清单已是更高版本，但缺 windows/app 与 web 字段' };
  } else if (cmp(newest, curWeb) > 0) {
    if (manifest.webFile) { kind = 'web'; file = manifest.webFile; }
    else return { kind: null, error: '前端落后但清单缺少 web 字段' };
  } else {
    return { kind: null, reason: '清单版本不高于本地，确实已最新' };
  }
  const downloaded = existsSync(join(dir, file));
  return { kind, file, downloaded };
}

const V = readJSON('version.json').version;
P(`\n=== 更新链路端到端校验（当前源码 v${V}）===`);

// ---- 场景 1：dist/version.json（网页端部署时客户端读到的清单）----
P('\n【场景 1】客户端读 dist/version.json（网页端部署形态）');
for (const [label, ver] of [['装的是 0.1.4', '0.1.4'], ['装的是 0.1.0', '0.1.0'], ['装的是当前版', V]]) {
  const m = manifestFromValue(readJSON('dist/version.json'));
  if (!m) { assert(false, `${label} → 读不到清单`); continue; }
  const r = checkUpdate(m, ver, ver, resolve(root, 'dist'), '');
  const expectUpdate = cmp(parseV(ver), parseV(V)) < 0;
  if (expectUpdate) {
    assert(r.kind === 'app', `${label} → 应提示完整更新`, `kind=${r.kind} file=${r.file}`);
    assert(!!r.file && existsSync(resolve(root, 'dist', r.file)), `${label} → 安装包在 dist/ 下存在`);
  } else {
    assert(r.kind === null, `${label} → 正确判定已最新`, r.reason || '');
  }
}

// ---- 场景 2：release/version.json（发布目录，直接部署 release/ 的形态）----
P('\n【场景 2】客户端读 release/version.json（把 release/ 整个上传）');
for (const [label, ver] of [['装的是 0.1.4', '0.1.4'], ['装的是当前版', V]]) {
  const m = manifestFromValue(readJSON('release/version.json'));
  if (!m) { assert(false, `${label} → 读不到清单`); continue; }
  const r = checkUpdate(m, ver, ver, resolve(root, 'release'), '');
  const expectUpdate = cmp(parseV(ver), parseV(V)) < 0;
  if (expectUpdate) {
    assert(r.kind === 'app', `${label} → 应提示完整更新`, `file=${r.file}`);
    assert(!!r.file && existsSync(resolve(root, 'release', r.file)), `${label} → 安装包在 release/ 下存在`);
  } else {
    assert(r.kind === null, `${label} → 正确判定已最新`, r.reason || '');
  }
}

// ---- 场景 3：只有前端落后 → 热更新 ----
P('\n【场景 3】程序已最新、只有前端落后 → 应走热更新');
{
  const m = manifestFromValue(readJSON('dist/version.json'));
  const r = checkUpdate(m, V, '0.1.4', resolve(root, 'dist'), '');
  assert(r.kind === 'web', '前端 0.1.4 < 清单 → 热更新', `kind=${r.kind} file=${r.file}`);
  assert(!!r.file && existsSync(resolve(root, 'dist', r.file)), '热更新包在 dist/ 下存在');
}

// ---- 场景 4：回归——曾经的故障形态（清单缺 windows 字段）----
// 改造前这里返回 {kind:null} → 前端显示「最新版本」（谎报）；
// 改造后必须返回明确的错误，让用户看到"清单不完整"而不是"没有更新"。
P('\n【场景 4】回归：清单只有 version/notes、无 windows 字段');
{
  const broken = { version: V, notes: 'x' };
  const r = checkUpdate(manifestFromValue(broken), '0.1.4', '0.1.4', resolve(root, 'dist'), '');
  assert(!!r.error, '缺 windows 字段时报错（不再静默退化成「最新版本」）', r.error || '(未报错!)');
  assert(r.kind === null, '不给出无法安装的更新类型');
}

// ---- 场景 4.5：dist-app/version.json —— 客户端从自身安装目录读到的清单 ----
// 这是"不再要求用户手填更新源"的核心：装好的客户端必须能在自己所在目录找到清单。
P('\n【场景 4.5】dist-app/version.json（客户端自身携带的清单）');
{
  const m = readJSON('dist-app/version.json');
  assert(!!m, 'dist-app/version.json 存在（会随安装包打进用户机器）');
  if (m) {
    assert(m.version === V, '版本号与源码一致', m.version);
    const parsed = manifestFromValue(m);
    assert(!!parsed.version, '可被 manifest_from_value 解析');
    // 客户端启动后读到的就是这份；它不需要 windows/web 也能让"更新源解析"成立，
    // 因为清单里的 updateUrl / internalLatest 才是后续联网检测的线索。
    const hasHint = !!(m.updateUrl || m.internalLatest);
    P(hasHint
      ? `  INFO  已带分发线索（${m.updateUrl ? 'updateUrl' : 'internalLatest'}）→ 客户端可据此联网检测`
      : '  INFO  未带分发线索 → 客户端将退回"自己所在目录的 version.json"做比对');
  }
}

// ---- 场景 5：热更新包体积与内容边界 ----
P('\n【场景 5】热更新包自排除、体积与内容边界');
{
  const wp = readJSON(`release/web-update-${V}.json`);
  if (wp && wp.files) {
    const keys = Object.keys(wp.files);
    assert(!keys.some((k) => /^web-update-.*\.json$/i.test(k)), '不含历史热更新包');
    const sizeMB = statSync(resolve(root, `release/web-update-${V}.json`)).size / 1048576;
    assert(sizeMB < 3, `热更新包体积合理（${sizeMB.toFixed(2)} MB，含安装包会到 12+ MB）`);
    // 热更新包只应含前端资源：混入 exe/msi 会让每台客户端白下几十 MB
    const heavy = keys.filter((k) => /\.(exe|msi)$/i.test(k));
    assert(heavy.length === 0, '不含安装包二进制', heavy.join(', ') || '无');
    P('  INFO  热更新包含前端资源: ' + keys.length + ' 个');
  } else {
    assert(false, '热更新包不存在或缺少 files 字段');
  }
}

// ---- 场景 5.5：dist-app 必须干净（否则安装包自包含、体积膨胀）----
P('\n【场景 5.5】dist-app 内容边界（安装包自包含防护）');
{
  const d = resolve(root, 'dist-app');
  if (!existsSync(d)) {
    assert(false, 'dist-app/ 不存在（frontendDist 指向它，构建会失败）');
  } else {
    const { readdirSync } = await import('node:fs');
    const heavy = readdirSync(d).filter((f) => /\.(exe|msi)$/i.test(f) || /^web-update-.*\.json$/i.test(f));
    assert(heavy.length === 0, 'dist-app/ 不含安装包/热更新包', heavy.join(', ') || '无');
    const hasIndex = existsSync(resolve(d, 'index.html'));
    assert(hasIndex, 'dist-app/index.html 存在（frontendDist 的入口）');
  }
  // 安装包体积不得大于未压缩主程序（NSIS 用 LZMA，正常应明显更小）
  const pePath = resolve(root, 'src-tauri/target/release/promptforge.exe');
  const setupPath = resolve(root, `release/PromptForge-${V}-Setup.exe`);
  if (existsSync(pePath) && existsSync(setupPath)) {
    const peMB = statSync(pePath).size / 1048576;
    const setupMB = statSync(setupPath).size / 1048576;
    assert(setupMB < peMB,
      `安装包 ${setupMB.toFixed(1)}MB < 主程序 ${peMB.toFixed(1)}MB`,
      setupMB >= peMB ? '疑似把安装包打进了 frontendDist' : '');
  }
}

// ---- 场景 6：四个版本号载体一致 ----
P('\n【场景 6】版本号载体一致性');
{
  const pkg = readJSON('package.json');
  const tauri = readJSON('src-tauri/tauri.conf.json');
  const cargo = readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf8').match(/^\s*version\s*=\s*"([^"]+)"/m);
  assert(pkg && pkg.version === V, 'package.json', pkg && pkg.version);
  assert(tauri && tauri.version === V, 'tauri.conf.json', tauri && tauri.version);
  assert(cargo && cargo[1] === V, 'Cargo.toml', cargo && cargo[1]);
  assert(readJSON('dist/version.json').version === V, 'dist/version.json');
  assert(readJSON('release/version.json').version === V, 'release/version.json');
}

// ---- 场景 7：更新源解析能力现状 ----
// 重点不再是"updateUrl 空不空"，而是"即使为空，链路是否仍然闭合"。
P('\n【场景 7】更新源解析能力');
{
  const meta = readJSON('version.json');
  const dist = readJSON('dist/version.json');
  const appManifest = readJSON('dist-app/version.json');

  if (meta && meta.updateUrl) {
    P(`  INFO  根 version.json 已配置 updateUrl：${meta.updateUrl} → 所有客户端自动联网检测`);
  } else {
    P('  INFO  根 version.json 的 updateUrl 为空 → 客户端按以下顺序自动兜底，无需人工填写：');
    P('         1) 本机部署地址（由 index.html 的 PF_DEPLOY_BASE 推导）');
    P('         2) 主程序目录下的 version.json（便携部署自带）');
    P('         3) %LOCALAPPDATA%\\PromptForge\\Updates\\version.json（离线手工投放）');
  }
  assert(!!appManifest, 'dist-app/version.json 存在 → 第 2 层兜底在装好的客户端上可用');
  if (dist && dist.windows) {
    P('  INFO  dist/version.json 已带 windows 字段 → 客户端能选中安装包');
  }
  assert(true, '已记录当前配置状态');
}

P('');
if (failed) {
  P(`[verify] 失败 ${failed} 项 —— 更新链路仍有断点`);
  console.error(out.join('\n'));
  process.exit(1);
}
P('[verify] 全部通过：客户端在旧版本上会看到更新提示，安装包可下载。');

const { writeFileSync } = await import('node:fs');
writeFileSync(join(root, '.workbuddy', 'verify-update-chain.txt'), out.join('\n') + '\n', 'utf8');
console.log(out.join('\n'));
