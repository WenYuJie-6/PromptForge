// 构建前自动执行：将源码资源同步到 dist（字节级拷贝，保证打包内容与源码一致）
// 用法：node scripts/sync-dist.mjs
//
// 输出两个目录，职责严格区分 —— 这是体积正确性的关键：
//   dist/      对外部署用。源码 + 安装包（网页端「下载桌面版」的下载目标）+ 热更新包
//   dist-app/  仅供 tauri build 打进安装包的干净前端（frontendDist 指向它）
//
// 为什么不共用一个目录：若 frontendDist 指向 dist/，而 dist/ 里又放着安装包，
// 安装包就会把自己（以及另一个安装包、整个热更新包）打包进自身 —— 体积逐版膨胀。
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const distApp = resolve(root, 'dist-app');
const metaAll = JSON.parse(readFileSync(resolve(root, 'version.json'), 'utf8'));
const V = metaAll.version;

// 拷贝前端源码（dist/ 与 dist-app/ 共用同一份）
const copyItems = [
  'index.html',
  'manifest.json',
  'sw.js',
  // 网页端部署后，客户端可从同一地址拉取内置在线服务配置（装好即用）
  'service.json',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'css',
  'js',
  'fonts',
];

// 「启动.bat / 启动.ps1」是 dist/ 专属资产 —— 只在网页端部署场景下有用。
// 在 dist-app/ 里出现会污染 Tauri 打包（让安装包把启动器也打进去，毫无意义）。
// 加上它：解决了「file:// 下浏览器阻止 <a download> / Service Worker / fetch 同源资源」
// 这组同源限制。用户在网页端下载完发布包后，双击 启动.bat 即可起一个
// 127.0.0.1 的本地服务，下面的所有按钮（下载桌面版、检查更新、PWA 安装）都恢复正常。
const distOnlyItems = ['assets-templates/启动.bat', 'assets-templates/启动.ps1'];

// tauri build 用的干净副本：只含源码，绝不含安装包 —— 否则安装包会把自己打进自身
if (existsSync(distApp)) rmSync(distApp, { recursive: true, force: true });
mkdirSync(distApp, { recursive: true });
for (const item of copyItems) {
  cpSync(resolve(root, item), resolve(distApp, item), { recursive: true });
}

// dist-app/version.json：装好的客户端要能读到自己"出生时的版本清单"。
//
// 这是更新链路能自愈的核心一环。没有它时，客户端唯一的清单来源是
// %LOCALAPPDATA%\PromptForge\Updates\version.json（要人工放）或手填的更新源地址；
// 两者都没做，"检查更新"就永远显示"最新版本"—— 即用户反复报告的故障。
//
// 有了它以后：客户端从自身安装目录读到这份清单，清单里的 updateUrl / internalLatest
// 指向真正的分发源，客户端据此联网检测；即使更新源地址为空的便携部署，
// 客户端也能靠"自己所在目录的清单"完成比对并发现版本落后。
//
// windows/web 字段：首次 sync（tauri build 之前）时安装包尚未产出，这里拿不到；
// 但**发布链路末尾还会再跑一次 sync-dist**，那时 release/version.json 已由 build-release 生成，
// 于是可以把 windows/web 一并桥接进来 —— 这一点很关键：
//
//   安装包内嵌的 dist-app/version.json 是「客户端出生时的清单」。它若缺 windows 字段，
//   客户端就只能靠联网拿 dist/version.json；一旦断网或 updateUrl 失效，就会退化成
//   「已是最新版本」（本项目反复出现的那类故障）。补上桥接后，客户端从自己安装目录
//   就能拿到完整清单，不依赖联网。
//
// 只采纳与当前版本号一致的 release 清单，且核实文件真实存在，避免陈旧清单污染。
const appManifest = {
  version: V,
  notes: metaAll.notes || '',
  publishedAt: new Date().toISOString(),
};
for (const k of ['updateUrl', 'internalLatest', 'minAppVersion']) {
  if (metaAll[k]) appManifest[k] = metaAll[k];
}
try {
  const rp = resolve(root, 'release/version.json');
  if (existsSync(rp)) {
    const rel = JSON.parse(readFileSync(rp, 'utf8'));
    if (rel && rel.version === V) {
      // entry.file 必须真实存在于 release/ 下，否则给出的是 404 链接
      const pick = (entry) => {
        if (!entry || !entry.file) return null;
        const fp = resolve(root, 'release', entry.file);
        return existsSync(fp) ? { file: entry.file, size: entry.size || statSync(fp).size } : null;
      };
      const win = pick(rel.windows);
      const web = pick(rel.web);
      if (win) appManifest.windows = win;
      if (web) appManifest.web = web;
    } else if (rel && rel.version !== V) {
      console.warn(`[sync-dist] release/version.json 是 v${rel.version}，与当前 v${V} 不一致，`
        + 'dist-app 清单不桥接 windows/web（请重跑 npm run release:pack）。');
    }
  }
} catch (e) {
  console.warn('[sync-dist] 桥接 release 清单失败（不影响 dist-app 生成）：' + e.message);
}
// 约定名兜底：万一 release/version.json 还不存在（**CI 首次构建就是这样**），
// 也要把 windows/web 按命名约定补上。
//
// 为什么必须在这里兜底、而不是等 build-release 之后：
//   dist-app/ 的资源是在 **cargo 编译期**就被嵌进二进制的，安装包里的那份清单
//   取决于 `cargo build` 那一刻磁盘上的 dist-app/version.json。
//   若那时它缺 windows 字段，装好的客户端就永远只能靠联网拿清单 —— 断网/更新源失效
//   时退化成「已是最新版本」，正是本项目反复出现的那类故障。
//   文件名与 build-release.mjs 的约定一致（PRODUCT-<v>-Setup.exe / web-update-<v>.json），
//   check-update-chain.mjs 有断言守着两者不漂移。
if (!appManifest.windows) appManifest.windows = { file: `PromptForge-${V}-Setup.exe` };
if (!appManifest.web) appManifest.web = { file: `web-update-${V}.json` };
writeFileSync(resolve(distApp, 'version.json'), JSON.stringify(appManifest, null, 2) + '\n', 'utf8');

// 拷贝后校验：任何一项缺失都直接失败。
// 为什么必须显式校验：同时有别的构建进程在读这些目录时，
// cpSync 可能只完成一部分就被打断，留下「css 在、js 不在」的空壳。
// 这种目录喂给 tauri build 会打出一个缺 js 的安装包，但构建本身成功、不报错。
function countFiles(p) {
  let n = 0;
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const f = resolve(d, name);
      if (statSync(f).isDirectory()) walk(f); else n++;
    }
  })(p);
  return n;
}
const missing = copyItems.filter((i) => typeof i === 'string' && !existsSync(resolve(distApp, i)));
if (missing.length) {
  console.error('[sync-dist] 中止：dist-app/ 缺少 ' + missing.join(', ') + '，拷贝不完整。');
  console.error('[sync-dist] 请关闭正在占用这些目录的进程后重跑。');
  process.exit(1);
}
// js/ 是核心资源，单独数一遍文件数，防止目录存在但内容为空
const srcJsCount = readdirSync(resolve(root, 'js')).length;
const appJsCount = existsSync(resolve(distApp, 'js')) ? readdirSync(resolve(distApp, 'js')).length : 0;
if (appJsCount !== srcJsCount) {
  console.error(`[sync-dist] 中止：dist-app/js 有 ${appJsCount} 个文件，源码有 ${srcJsCount} 个，拷贝不完整。`);
  process.exit(1);
}

// 网页端「下载桌面版」按钮的下载目标 + 客户端热更新包（只进 dist/，不进 dist-app/）。
// 优先从 release/ 取（build-release 收拢后的权威产物），其次根目录同名文件，
// 都没有才跳过——避免把过期安装包同步进 dist。
// 必须带版本化文件名：dist/version.json 里的 windows.file / web.file 是按
// release/version.json 原样桥接过来的，只放 Latest-* 会让清单指向不存在的文件。
// 注意：web-update-*.json 体积是完整前端包的 1.3 倍，它自身必须在打包时跳过，
// 否则每发一版，下一版的 dist 就会翻倍。
const deployItems = [];
for (const opt of [
  { src: ['release/Latest-Setup.exe', 'Latest-Setup.exe'], as: 'Latest-Setup.exe', versioned: `PromptForge-${V}-Setup.exe` },
  { src: ['release/Latest.msi', 'Latest.msi'], as: 'Latest.msi', versioned: `PromptForge-${V}.msi` },
  { src: [`release/web-update-${V}.json`], as: `web-update-${V}.json` },
]) {
  const found = opt.src.find((p) => existsSync(resolve(root, p)));
  if (!found) continue;
  deployItems.push({ from: found, to: opt.as });
  // 同时提供版本化别名，保证 version.json 的引用在 dist/ 下也能命中
  if (opt.versioned && opt.versioned !== opt.as) deployItems.push({ from: found, to: opt.versioned });
}

if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const copied = [];
for (const item of copyItems) {
  cpSync(resolve(root, item), resolve(dist, item), { recursive: true });
  copied.push(item);
}
for (const item of distOnlyItems) {
  cpSync(resolve(root, item), resolve(dist, basename(item)), { recursive: true });
  copied.push(`${basename(item)}(←${item})`);
}
for (const item of deployItems) {
  cpSync(resolve(root, item.from), resolve(dist, item.to), { recursive: true });
  copied.push(`${item.to}(←${item.from})`);
}

// 「启动.ps1 / 启动.bat」必须是 UTF-8 BOM + CRLF，否则 powershell.exe(5.1)
// 按 ANSI 解码会报位置完全错误的假语法错误，导致用户在 end-user 机器上一打开就失败。
// 这里写完后立即校验/修复；任何 BOM 缺失都视为构建失败。
const psFiles = ['启动.ps1', '启动.bat']
  .map((n) => resolve(dist, n))
  .filter((p) => existsSync(p));
if (psFiles.length) {
  try {
    execFileSync(process.execPath, [resolve(root, 'scripts/fix-ps-encoding.mjs'), '--check', ...psFiles], { stdio: 'inherit' });
  } catch {
    console.error('[sync-dist] 启动器文件 BOM 校验失败，自动修复中…');
    execFileSync(process.execPath, [resolve(root, 'scripts/fix-ps-encoding.mjs'), ...psFiles], { stdio: 'inherit' });
  }
}

// dist/ 同样校验：网页端靠它下载安装包与热更新，缺一个就 404
const distExpected = [
  ...copyItems,
  ...distOnlyItems.map((i) => basename(i)),
  ...deployItems.map((i) => i.to),
];
const missingDist = distExpected.filter((i) => !existsSync(resolve(dist, i)));
if (missingDist.length) {
  console.error('[sync-dist] 中止：dist/ 缺少 ' + missingDist.join(', ') + '，拷贝不完整。');
  process.exit(1);
}
const distJsCount = existsSync(resolve(dist, 'js')) ? readdirSync(resolve(dist, 'js')).length : 0;
if (distJsCount !== srcJsCount) {
  console.error(`[sync-dist] 中止：dist/js 有 ${distJsCount} 个文件，源码有 ${srcJsCount} 个，拷贝不完整。`);
  process.exit(1);
}

console.log('[sync-dist] dist-app/（打进安装包的干净前端）：' + copyItems.join(', '));
console.log('[sync-dist] dist/（对外部署，含安装包）：' + copied.join(', '));
if (!deployItems.length) {
  console.warn('[sync-dist] 未找到 Latest-Setup.exe / Latest.msi，dist 将不含安装包。');
  console.warn('[sync-dist] 网页端「下载桌面版」会提示暂未提供下载；请先运行 npm run release:pack。');
}