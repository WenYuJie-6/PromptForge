// 构建前置校验：所有出包路径的版本号必须一致，否则直接中止。
// 这个脚本诞生于一个真实事故：源码升到 0.2.0，但安装包/清单/网页副本都停在 0.1.4，
// 结果桌面端「检查更新」永远显示「最新版本」、网页端下到的是旧包。
// 用法：node scripts/check-dist.mjs
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
const ok = [];
// stale：产物尚未生成（首次克隆、还没跑过 sync:dist）。这类不算错误，但要显式说清楚
// "这不是通过、是没检查"，避免输出里出现含糊的「不存在」让人误以为文件丢了。
const stale = [];

function readJSON(rel) {
  const p = resolve(root, rel);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch {
    errors.push(`${rel} 不是合法 JSON`);
    return null;
  }
}

const meta = readJSON('version.json');
if (!meta) {
  console.error('[check-dist] 找不到或无法解析 version.json');
  process.exit(1);
}
const V = meta.version;
ok.push(`version.json = ${V}`);

// ---- 1. 四处版本号必须一致 ----
const pkg = readJSON('package.json');
if (pkg && pkg.version !== V) errors.push(`package.json 是 ${pkg.version}，应为 ${V}（运行：npm run bump ${V}）`);
else if (pkg) ok.push(`package.json = ${pkg.version}`);

const tauri = readJSON('src-tauri/tauri.conf.json');
if (tauri && tauri.version !== V) errors.push(`tauri.conf.json 是 ${tauri.version}，应为 ${V}`);
else if (tauri) ok.push(`tauri.conf.json = ${tauri.version}`);

const cargoPath = resolve(root, 'src-tauri/Cargo.toml');
if (existsSync(cargoPath)) {
  const m = readFileSync(cargoPath, 'utf8').match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (m && m[1] !== V) errors.push(`Cargo.toml 是 ${m[1]}，应为 ${V}`);
  else if (m) ok.push(`Cargo.toml = ${m[1]}`);
}

// ---- 2. 分发物必须属于当前版本 ----
function versionOfFile(name) {
  const m = name.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

const targets = [
  { label: '根目录 Latest-Setup.exe', rel: 'Latest-Setup.exe' },
  { label: '根目录 Latest.msi', rel: 'Latest.msi' },
  { label: 'dist/Latest-Setup.exe', rel: 'dist/Latest-Setup.exe' },
  { label: 'dist/Latest.msi', rel: 'dist/Latest.msi' },
];
for (const t of targets) {
  const p = resolve(root, t.rel);
  if (!existsSync(p)) { warnings.push(`${t.label} 不存在（未打包时正常）`); continue; }
  // Latest-* 文件名不带版本号，改从 release/ 的版本化文件名反查
  ok.push(`${t.label} 存在（${(statSync(p).size / 1024 / 1024).toFixed(1)} MB）`);
}

// release/ 里的版本化安装包 —— 文件名自带版本号，是判断陈旧与否最直接的证据
for (const [label, dir, ext] of [['NSIS', 'release', '-Setup.exe'], ['MSI', 'release', '.msi']]) {
  const p = resolve(root, dir);
  if (!existsSync(p)) continue;
  const hits = readdirSync(p).filter((f) => f.endsWith(ext));
  for (const f of hits) {
    const v = versionOfFile(f);
    if (v && v !== V) errors.push(`release/${f} 是旧版本 v${v}（当前 v${V}），请重新打包`);
    else if (v) ok.push(`release/${f} 版本正确`);
  }
}

// ---- 3. 清单里引用的文件必须真实存在 ----
for (const rel of ['release/version.json', 'dist/version.json']) {
  const m = readJSON(rel);
  if (!m) { warnings.push(`${rel} 不存在`); continue; }
  if (m.version !== V) errors.push(`${rel} 是 v${m.version}，应为 v${V}`);
  else ok.push(`${rel} = v${m.version}`);
  for (const key of ['windows', 'web']) {
    const e = m[key];
    if (!e || !e.file) continue;
    const dir = rel.startsWith('release/') ? 'release' : 'dist';
    const fp = join(root, dir, e.file);
    if (!existsSync(fp)) errors.push(`${rel} 的 ${key}.file=${e.file} 在 ${dir}/ 下不存在（会造成 404）`);
    else if (versionOfFile(e.file) && versionOfFile(e.file) !== V) {
      errors.push(`${rel} 的 ${key}.file=${e.file} 版本不符（当前 v${V}）`);
    } else ok.push(`${rel} → ${key}.file=${e.file} 已就位`);
  }
}

// ---- 4. dist / dist-app 源码不得与源码树漂移 ----
// 注意：这一步校验的是「上一次 sync:dist 的结果」。链路里 check:dist 跑在最前，
// 所以它拦不住"源码刚改、还没 sync"的情况——那种漂移由第 4b 步的 mtime 检查负责。
for (const dir of ['dist', 'dist-app']) {
  for (const f of ['index.html', 'sw.js', 'js/app.js', 'js/style-variants.js', 'js/optimizer.js']) {
    const a = resolve(root, f), b = resolve(root, dir, f);
    if (!existsSync(a)) continue;
    if (!existsSync(b)) {
      // 目录整体缺失是一种情况（首次克隆还没 sync），个别文件缺失是另一种（同步被中断）
      if (!existsSync(resolve(root, dir))) stale.push(`${dir}/ 尚未生成`);
      else errors.push(`${dir}/${f} 缺失，同步不完整（运行 npm run sync:dist）`);
      continue;
    }
    if (statSync(a).size !== statSync(b).size) {
      errors.push(`${dir}/${f} 与源码大小不一致，已漂移（运行 npm run sync:dist）`);
    }
  }
}

// ---- 5. dist-app 绝不能含安装包（否则安装包会把自己打包进自身）----
{
  const d = resolve(root, 'dist-app');
  if (existsSync(d)) {
    const heavy = readdirSync(d).filter((f) => /\.(exe|msi)$/i.test(f) || /^web-update-.*\.json$/i.test(f));
    if (heavy.length) {
      errors.push(`dist-app/ 含 ${heavy.join(', ')} —— 它会被打进安装包，导致安装包自包含、体积逐版膨胀`);
    } else {
      ok.push('dist-app/ 干净（无安装包 / 无热更新包）');
    }
  } else {
    stale.push('dist-app/ 尚未生成（运行 npm run sync:dist）');
  }
}

// ---- 5.5 新鲜度：源码是否比 dist-app 里的副本更新 ----
// 这是"改完代码忘了重新打包"的直接探测器。体积比对抓不到"改了几个字但长度相同"的情况，
// mtime 能。若有源码比 dist-app 里的副本新，说明安装包会打进旧前端。
{
  const watched = ['index.html', 'sw.js'];
  try {
    for (const f of readdirSync(resolve(root, 'js'))) if (f.endsWith('.js')) watched.push('js/' + f);
  } catch { /* js/ 不存在时忽略 */ }
  try {
    for (const f of readdirSync(resolve(root, 'css'))) if (f.endsWith('.css')) watched.push('css/' + f);
  } catch { /* css/ 不存在时忽略 */ }

  // 容忍 1 秒误差：文件系统时间戳精度有限，同一次 sync 内复制不可避免有微小先后差
  const TOLERANCE_MS = 1000;
  const newer = [];
  for (const f of watched) {
    const src = resolve(root, f), dst = resolve(root, 'dist-app', f);
    if (!existsSync(src) || !existsSync(dst)) continue;
    if (statSync(src).mtimeMs - statSync(dst).mtimeMs > TOLERANCE_MS) newer.push(f);
  }
  if (newer.length) {
    const show = newer.slice(0, 5).join(', ') + (newer.length > 5 ? ` 等 ${newer.length} 个` : '');
    warnings.push(`源码比 dist-app/ 内的副本更新（${show}）—— 安装包会打进旧前端，请先跑 npm run sync:dist`);
  } else if (watched.length) {
    ok.push(`dist-app/ 前端与源码同步（比对 ${watched.length} 个文件）`);
  }
}

// ---- 6. 安装包不应远大于主程序（自包含的典型症状）----
{
  const exe = resolve(root, 'release');
  if (existsSync(exe)) {
    const setup = readdirSync(exe).find((f) => f.endsWith('-Setup.exe'));
    const pePath = resolve(root, 'src-tauri/target/release/promptforge.exe');
    if (setup && existsSync(pePath)) {
      const setupMB = statSync(join(exe, setup)).size / 1048576;
      const peMB = statSync(pePath).size / 1048576;
      // NSIS 用 LZMA，安装包通常明显小于未压缩主程序；大于主程序即可疑
      if (setupMB > peMB) {
        errors.push(`安装包 ${setupMB.toFixed(1)}MB 大于主程序 ${peMB.toFixed(1)}MB —— `
          + '疑似把 自身/其它安装包 打进了 frontendDist，请检查 dist-app/ 是否干净');
      } else {
        ok.push(`安装包 ${setupMB.toFixed(1)}MB < 主程序 ${peMB.toFixed(1)}MB（体积正常）`);
      }
    }
  }
}

console.log(`\n[check-dist] 版本 v${V} 一致性校验`);
ok.forEach((s) => console.log(`  ✓ ${s}`));
warnings.forEach((s) => console.log(`  ! ${s}`));
// 未生成 ≠ 通过：单独成段，避免被当成"检查过了没问题"
if (stale.length) {
  console.log('  – 未检查（产物尚未生成）：');
  stale.forEach((s) => console.log(`      ${s}`));
}
if (errors.length) {
  console.error('\n[check-dist] 发现阻断性问题：');
  errors.forEach((s) => console.error(`  ✗ ${s}`));
  console.error('\n[check-dist] 请先修复以上问题再构建，否则会发布出「检查更新永远显示最新版本」的包。\n');
  process.exit(1);
}
console.log('\n[check-dist] 通过。\n');
