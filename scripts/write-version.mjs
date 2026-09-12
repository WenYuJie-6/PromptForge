// 把根目录 version.json 写进 dist/，让网页端与客户端读同一份版本信息。
// 由 npm run sync:dist 调用；tauri build 的 beforeBuildCommand 会先执行它，
// 因此 dist/version.json 会被打进安装包，客户端也拿得到同一份数据。
//
// 关键：不能只写 {version, notes}。客户端 check_update 读的是 release/version.json 的
// 同构清单，靠 windows.file / web.file 才能选中安装包；只写版本号会让它在
// 「程序本体落后」时拿不到 app_file，最终仍然报「最新版本」。
// 所以这里做一次桥接：release/version.json 里有 windows/web 就原样带过来。
// 当 DIST_STRICT=1 时（构建安装包、准备分发时），拿不到清单直接失败退出。
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const meta = JSON.parse(readFileSync(resolve(root, 'version.json'), 'utf8'));
const dist = resolve(root, 'dist');
const strict = process.env.DIST_STRICT === '1';

if (!existsSync(dist)) {
  console.error('[write-version] dist 不存在，请先运行 sync-dist');
  process.exit(1);
}

// ---- 1. 读取 build-release 生成的发布清单（权威来源）----
const releaseManifestPath = resolve(root, 'release/version.json');
let releaseManifest = null;
if (existsSync(releaseManifestPath)) {
  try {
    releaseManifest = JSON.parse(readFileSync(releaseManifestPath, 'utf8'));
  } catch (e) {
    console.warn(`[write-version] release/version.json 解析失败：${e.message}`);
  }
}

// ---- 2. 只采纳与当前版本号一致的清单，防止陈旧清单污染 ----
const usable = releaseManifest && releaseManifest.version === meta.version ? releaseManifest : null;
if (releaseManifest && !usable) {
  console.warn(`[write-version] release/version.json 是 v${releaseManifest.version}，`
    + `与当前 v${meta.version} 不一致，已忽略（请重新运行 npm run release:pack）。`);
}

// ---- 3. 引用安装包前核实文件真实存在，避免给出 404 链接 ----
function present(entry, dir) {
  if (!entry || !entry.file) return null;
  const p = dir ? join(root, dir, entry.file) : resolve(root, entry.file);
  if (!existsSync(p)) {
    console.warn(`[write-version] 清单引用的文件不存在，已剔除：${dir ? dir + '/' : ''}${entry.file}`);
    return null;
  }
  return { file: entry.file, size: entry.size || statSync(p).size };
}

const windowsEntry = usable ? present(usable.windows, 'release') : null;

const payload = {
  version: meta.version,
  notes: meta.notes || '',
  publishedAt: new Date().toISOString(),
  updateUrl: meta.updateUrl || '',
};
if (usable && usable.minAppVersion) payload.minAppVersion = usable.minAppVersion;
// windows/web 让 check_update 能在「程序本体落后」时选中安装包；
// 热更新包名是已知规律，不用等 release/ 也能推出候选名。
payload.web = usable ? present(usable.web, 'release') : { file: `web-update-${meta.version}.json` };
if (windowsEntry) payload.windows = windowsEntry;

writeFileSync(resolve(dist, 'version.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');

console.log(`[write-version] dist/version.json = v${meta.version}`
  + `${windowsEntry ? `（含安装包 ${windowsEntry.file}）` : '（无 windows 字段）'}`);

if (!windowsEntry && strict) {
  console.error('\n[write-version] 中止：dist/version.json 里没有 windows 安装包字段，');
  console.error('[write-version] 客户端在「程序本体落后」时将拿不到安装包，仍会显示「最新版本」。');
  console.error('[write-version] 请先执行：npm run release:pack\n');
  process.exit(1);
}
