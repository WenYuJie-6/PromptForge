// 构建发布包：把深藏在 src-tauri/target/release/bundle/** 里的安装包收拢到一级目录 release/，
// 同时在项目根放 Latest-Setup.exe（文件名 L 开头，文件管理器排最前）。
// 总是清理 bundle 目录里旧版本的安装包，避免与 release/ 不一致。
// 用法：node scripts/build-release.mjs [--keep-old]
//   --keep-old  保留 release/ 里的历史文件不删（默认每次打包都清）
import { readFileSync, writeFileSync, readdirSync, copyFileSync, statSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundleRoot = resolve(root, 'src-tauri/target/release/bundle');
const dist = resolve(root, 'dist');
// tauri build 实际打进安装包的是 dist-app/（干净前端）；热更新包按它生成，
// 这样装出来的客户端与热更新包内容严格一致。
const distApp = resolve(root, 'dist-app');
const releaseDir = resolve(root, 'release');
const PRODUCT = 'PromptForge';

const meta = JSON.parse(readFileSync(resolve(root, 'version.json'), 'utf8'));
const version = meta.version;

if (!existsSync(bundleRoot)) {
  console.error('[release] 未找到构建产物，请先运行：npm run tauri:build');
  process.exit(1);
}

mkdirSync(releaseDir, { recursive: true });

// ---- 1. 挑出安装包（优先匹配当前版本，否则取该目录下最新的一个）----
function pick(kind, exts) {
  const dir = join(bundleRoot, kind);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)))
    .map((f) => ({ name: f, path: join(dir, f), m: statSync(join(dir, f)).mtimeMs }));
  if (!files.length) return null;
  const hit = files.find((f) => f.name.includes(version));
  if (hit) return hit;
  files.sort((a, b) => b.m - a.m);
  console.warn(`[release] ${kind} 目录下没有带 ${version} 的安装包，改用最新的 ${files[0].name}`);
  return files[0];
}

const setup = pick('nsis', ['.exe']);
const msi = pick('msi', ['.msi']);

// ---- 1.5 校验安装包版本：绝不能把旧版本打包发布出去 ----
// 双击旧 exe 会装回旧版本（Windows 侧已用 allowDowngrades:false 兜底），
// 但更根本的是让发布脚本在这里就拦下来。
function versionOf(name) {
  const m = name.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}
for (const [kind, p] of [['nsis', setup], ['msi', msi]]) {
  if (!p) continue;
  const v = versionOf(p.name);
  if (v && v !== version) {
    console.error(`\n[release] 中止：${kind} 里的安装包是 v${v}，但 version.json 是 v${version}。`);
    console.error(`[release] 说明你还没重新构建。请先执行：npm run tauri:build\n`);
    process.exit(1);
  }
}

// ---- 2. 复制到 release/ 并改成一眼能看懂的名字 ----
const copied = [];
function publish(src, targetName, label) {
  if (!src) return null;
  const dest = join(releaseDir, targetName);
  copyFileSync(src.path, dest);
  const size = statSync(dest).size;
  copied.push({ label, name: targetName, size });
  return { file: targetName, size };
}

const winExe = publish(setup, `${PRODUCT}-${version}-Setup.exe`, 'Windows 安装包（NSIS）');
const winMsi = publish(msi, `${PRODUCT}-${version}.msi`, 'Windows 安装包（MSI）');

// ---- 3. 生成前端热更新包（base64 打包前端，供热切换，不退出软件）----
// 扫描 dist-app/ 而不是 dist/ —— dist/ 里放着安装包与旧热更新包，
// 一旦把它们 base64 进来，体积会逐版翻倍（实测 654KB → 12.29MB）。
const webPackName = `web-update-${version}.json`;
const files = {};
const B64_MAX = 8 * 1024 * 1024; // 超过 8MB 的单文件跳过，避免生成巨型 JSON
const SELF_RE = /^web-update-.*\.json$/i;
const webSrc = existsSync(distApp) ? distApp : dist;
(function walk(dir, prefix) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, prefix ? `${prefix}/${name}` : name);
    } else {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (SELF_RE.test(name)) {
        console.warn(`[release] 自排除历史热更新包：${rel}`);
        continue;
      }
      if (statSync(full).size > B64_MAX) {
        console.warn(`[release] 跳过超大文件：${rel}`);
        continue;
      }
      files[rel] = readFileSync(full).toString('base64');
    }
  }
})(webSrc, '');

const webPackPath = join(releaseDir, webPackName);
writeFileSync(webPackPath, JSON.stringify({ version, files }), 'utf8');
const webEntry = { file: webPackName, size: statSync(webPackPath).size };
copied.push({ label: '前端热更新包', name: webPackName, size: webEntry.size });

// ---- 4. 生成更新清单（客户端 check_update 读的就是它）----
// 字段说明（客户端 Manifest 结构体按这些键取值，改名前请同步 lib.rs）：
//   windows  → 完整安装包（read as app_file，触发"需退出安装"的完整更新）
//   web      → 前端热更新包（不退出软件，装完刷新）
//   service  → 内置在线服务配置，随清单下发，改地址不用发新版客户端
//   internalLatest → 可选：部署方自己的分发源，客户端没配更新源时兜底
//   updateUrl → 可选：整个部署的公共更新源，随清单下发给所有客户端
//
// 注意 updateUrl 从根目录 version.json 透传（RELEASE_UPDATE_URL 可覆盖单个发布）。
// 这一步是"发布新版本后旧客户端能收到更新"的关键：客户端把自己部署位置
// 推导出的地址当作更新源，这份清单又告诉它真正的公共源在哪，链路不依赖人工填写。
// 留空也不会失效 —— 客户端会退回"自己所在目录的 version.json"。
const updateUrl = (process.env.RELEASE_UPDATE_URL || meta.updateUrl || '').trim();
const manifest = {
  version,
  notes: meta.notes || '',
  publishedAt: new Date().toISOString(),
  minAppVersion: meta.minAppVersion || '0.0.0',
  ...(updateUrl ? { updateUrl } : {}),
  web: webEntry,
  ...(winExe ? { windows: winExe } : {}),
  ...(process.env.RELEASE_INTERNAL_LATEST
    ? {
        internalLatest: {
          enabled: true,
          endpoint: process.env.RELEASE_INTERNAL_LATEST,
          name: '官方分发源',
        },
      }
    : {}),
};
// 把根目录 service.json 的内核并进清单，客户端一次请求即可拿到内置服务
try {
  const svcMeta = JSON.parse(readFileSync(resolve(root, 'service.json'), 'utf8'));
  if (svcMeta && svcMeta.enabled && svcMeta.endpoint) {
    manifest.service = {
      enabled: true,
      endpoint: svcMeta.endpoint,
      model: svcMeta.model || '',
      key: svcMeta.key || '',
      name: svcMeta.name || '内置在线服务',
    };
  }
} catch {}
writeFileSync(join(releaseDir, 'version.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

// ---- 4.5 内置在线服务配置（客户端装好即用的关键）----
// 根目录有 service.json 就原样带进发布包；没有就生成一个禁用模板，
// 提醒发布者去填，避免客户端永远拿不到内置服务。
const svcSrc = resolve(root, 'service.json');
const svcDst = join(releaseDir, 'service.json');
if (existsSync(svcSrc)) {
  copyFileSync(svcSrc, svcDst);
  copied.push({ label: '内置在线服务配置', name: 'service.json', size: statSync(svcDst).size });
} else {
  writeFileSync(svcDst, JSON.stringify({
    enabled: false,
    name: '',
    endpoint: '',
    model: '',
    key: '',
    note: '内置在线服务未启用。填入一个代理到 OpenAI 兼容接口的自建地址后，新装客户端无需配置 API 即可联网使用。',
  }, null, 2) + '\n', 'utf8');
  copied.push({ label: '内置在线服务配置（模板，未启用）', name: 'service.json', size: statSync(svcDst).size });
}

// ---- 4.6 在「项目根」和「release/」各放一份 Latest-* —— 文件名以 L 开头，文件管理器里排最前 ----
// 用户打开目录一眼就能看到最新版，不用在一堆 exe 里翻。
// release/ 的那份同时是「下载桌面版」按钮的下载目标：与 version.json 同目录，
// 部署时整个 release/ 一起上传即可，不需要额外记文件位置。
// 必须先于清理执行——清理只放过 keepNames 里的文件，晚于清理创建的文件会被下一轮误删。
const latestExe = join(root, 'Latest-Setup.exe');
const latestMsi = join(root, 'Latest.msi');
try { rmSync(latestExe, { force: true }); } catch {}
try { rmSync(latestMsi, { force: true }); } catch {}
if (winExe) {
  copyFileSync(join(releaseDir, winExe.file), latestExe);
  copyFileSync(join(releaseDir, winExe.file), join(releaseDir, 'Latest-Setup.exe'));
  console.log(`[release] 快捷副本：Latest-Setup.exe（根目录 + release/）→ ${winExe.file}`);
}
if (winMsi) {
  copyFileSync(join(releaseDir, winMsi.file), latestMsi);
  copyFileSync(join(releaseDir, winMsi.file), join(releaseDir, 'Latest.msi'));
  console.log(`[release] 快捷副本：Latest.msi（根目录 + release/）→ ${winMsi.file}`);
}

// ---- 4.7 清理 release/ 里的历史版本（默认开启，避免文件夹里堆一堆积压的旧包）----
// 只保留当前版本所需的文件：两个安装包 / Latest-* 别名 / web-update / 清单元数据
const keepOld = process.argv.includes('--keep-old');
const keepNames = new Set([
  winExe && winExe.file,
  winMsi && winMsi.file,
  winExe && 'Latest-Setup.exe',
  winMsi && 'Latest.msi',
  webPackName,
  'version.json',
  'service.json',
  '发布说明.md',
].filter(Boolean));

let cleaned = [];
if (!keepOld) {
  for (const name of readdirSync(releaseDir)) {
    if (keepNames.has(name)) continue;
    rmSync(join(releaseDir, name), { recursive: true, force: true });
    cleaned.push(name);
  }
}

// ---- 6. 发布说明 ----
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
const sizeOf = (n) => (n > 1024 * 1024 ? mb(n) : kb(n));

const notes = `# PromptForge v${version} 发布说明

发布时间：${new Date().toLocaleString('zh-CN')}

## 一、下载位置

所有发布文件都在项目根目录的 \`release/\` 一级目录下：

| 文件 | 说明 | 大小 |
| --- | --- | --- |
${copied.map((c) => `| \`release/${c.name}\` | ${c.label} | ${sizeOf(c.size)} |`).join('\n')}

完整路径（复制即可用）：

\`\`\`
${join(releaseDir, winExe ? winExe.file : webPackName)}
\`\`\`

> 旧路径 \`src-tauri\\target\\release\\bundle\\nsis\\...\` 是 Tauri 的默认输出，层级深且文件名带下划线，
> 现已统一由 \`npm run release\` 复制到上面的 \`release/\` 并重命名为 \`${PRODUCT}-<版本>-Setup.exe\`。
> \`release/\` 里**只保留当前版本**，每次打包会自动清理旧包（想保留请加 \`--keep-old\`）。

## 二、安装后怎么找到主程序

- 开始菜单 → **PromptForge**（安装时自动创建）
- 桌面快捷方式：应用内「设置 → 程序位置 → 创建桌面快捷方式」
- 安装目录：应用内「设置 → 程序位置 → 打开安装目录」一键直达
- 主程序文件名：\`PromptForge.exe\`

> 安装包已开启 \`allowDowngrades: false\`，**双击旧版安装包不会降级**；即使装到了旧版本，
> 启动后也会自动检测并提示升级到最新版。

## 二、本次更新

${meta.notes || '（未填写更新说明，可在根目录 version.json 的 notes 字段补充）'}

## 三、让客户端能自动更新

1. 把整个 \`release/\` 目录上传到任意静态托管（对象存储、GitHub Pages、Nginx 都行），
   记下可访问的根地址，例如 \`https://example.com/promptforge\`。
2. 在桌面端「设置 → 软件更新源地址」填入该地址，保存。
3. 点侧边栏「⟳ 检查更新」：客户端会读取 \`<地址>/version.json\`，发现新版本后自动下载并安装。
   - 前端热更新（\`web-update-*.json\`）：不退出软件，装完自动刷新。
   - 完整安装包（\`-Setup.exe\`）：会提示后退出静默安装。

启动时若发现完整包更新，会主动问一次"是否立即升级"，同一版本号只问一次。

离线场景：不填更新源地址也可以——把 \`version.json\` 与更新包一起放进更新文件夹
（设置页点「打开更新文件夹」即可直达），客户端同样能检测并安装。

## 四、内置在线服务（让用户装好就能用）

客户端启动时会读取更新源下的 \`service.json\`。填好后，新装用户**不用配置任何 API** 就能直接
联网生成和优化提示词；用户在设置里填了自己的 API 时，优先用用户的。

\`\`\`json
{
  "enabled": true,
  "name": "官方体验服务",
  "endpoint": "https://your-proxy.example.com/v1",
  "model": "your-model",
  "key": ""
}
\`\`\`

> 注意：前端配置里的 \`key\` 对任何访客都可见，只应填**自建代理的受限令牌**，
> 不要把高额度主账号 Key 写进去。改服务地址不需要发新版客户端。

## 六、发布流程

\`\`\`bash
npm run bump 0.1.4            # 统一改版本号（version.json / package.json / tauri.conf.json / Cargo.toml）
npm run tauri:build           # 构建 NSIS / MSI 安装包
node scripts/build-release.mjs # 收拢到 release/，自动清理旧版本（不删旧版用 --keep-old）
\`\`\`

> 安装包会校验：build-release 启动时若发现 bundle 里的 exe 版本与 version.json 不一致，会**直接报错退出**，
> 避免把过期安装包发布出去。
`;

writeFileSync(join(releaseDir, '发布说明.md'), notes, 'utf8');

console.log('\n[release] 发布文件已生成：');
copied.forEach((c) => console.log(`  release/${c.name}  (${c.label}, ${sizeOf(c.size)})`));
console.log(`  release/version.json  (更新清单)`);
console.log(`  release/发布说明.md`);
if (cleaned.length) {
  console.log(`\n[release] 已清理 ${cleaned.length} 个历史版本文件：`);
  cleaned.forEach((n) => console.log(`  - ${n}`));
}
console.log(`\n[release] 目录：${releaseDir}`);
