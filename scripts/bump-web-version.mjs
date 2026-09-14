// 只抬「前端资源版本」webVersion —— 用于纯前端改动（改 HTML/CSS/JS）走热更新下发，无需重装。
// 用法：node scripts/bump-web-version.mjs 0.2.2
//
// ---- 为什么需要这条轴（与 bump-version.mjs 的分工）----
// 桌面端的更新判定同时看两条轴：
//     newest(清单 version)    > cur_app → app 分支：下载完整安装包并重装
//     newest(清单 webVersion) > cur_web → web 分支：前端热更新，不退出软件
// 过去只有 version 一条轴，「改一行前端也要 bump version」会连带抬高 app 基准，
// 结果永远命中 app 分支、必须重装 —— 热更新通道形同虚设。
// 现在：
//   · 只改了前端资源      → 本脚本 bump webVersion（只改 version.json 一个字段）→ 走热更新
//   · 改了 Rust/需要重装  → 用 scripts/bump-version.mjs，它会把 version 与 webVersion 一起抬
//
// 注意：本脚本**只**改 version.json 的 webVersion，绝不触碰 version，
// 也不同步 package.json / tauri.conf.json / Cargo.toml —— 那些是「程序本体」版本，纯前端改动不该动它们。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const next = process.argv[2];

if (!next || !/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('用法：node scripts/bump-web-version.mjs <版本号>，例如 0.2.2');
  process.exit(1);
}

const versionPath = resolve(root, 'version.json');
const meta = JSON.parse(readFileSync(versionPath, 'utf8'));
const from = meta.webVersion || meta.version;
const appVersion = meta.version;
meta.webVersion = next;
writeFileSync(versionPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');

console.log(`[bump:web] version.json 前端版本 webVersion ${from} → ${next}`);
console.log(`[bump:web] 程序版本 version 保持 ${appVersion} 不变（纯前端改动不需要重装）`);

// 语义提醒：webVersion 若低于程序版本，说明"全量包里的前端比这次热更新还新"，
// 属于误操作预告，这里只提醒不拦截（发布者可能是刻意回滚前端）。
const cmp = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  return (pa[0] - pb[0]) || (pa[1] - pb[1]) || (pa[2] - pb[2]);
};
if (cmp(next, appVersion) < 0) {
  console.warn(`[bump:web] 提醒：webVersion(${next}) 低于程序版本(${appVersion})，`
    + '热更新判定会认为前端已是最新，本次前端改动可能推不下去。请确认这是有意的。');
}

console.log('\n[bump:web] 完成。下一步：node scripts/build-release.mjs && npm run sync:dist && node scripts/verify-update-chain.mjs');
