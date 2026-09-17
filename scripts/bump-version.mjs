// 统一「程序本体（app）」版本号：以根目录 version.json 为唯一真源，
// 同步到 package.json / tauri.conf.json / Cargo.toml，并把前端资源版本 webVersion 对齐成同一个值。
// 用法：node scripts/bump-version.mjs 0.1.4
//
// ---- 为什么需要两条版本轴（version 与 webVersion）----
// 桌面端加载前端资源的顺序是：① 热更新目录 %LOCALAPPDATA%\PromptForge\WebApp\<版本>\ 优先
// → ② 回退安装包内嵌资源。而 check_update 的判定是：
//     newest > cur_app          → 走「app 分支」：要求下载完整安装包并重装
//     else if newest > cur_web  → 走「web 分支」：前端热更新，不用重装
// 当只有一条版本轴时，「bump version」会同时抬高 app 与 web 两个比较基准，
// 于是纯前端改动也被判定成「程序本体落后」，被迫走重装 —— 「前端改动免重装」这条通道实际不可达。
// 拆出 webVersion 后：app 改动才 bump version（发全量包），纯前端改动只 bump webVersion
// （走热更新）。本脚本负责「发全量包」：它把 version 与 webVersion 一起抬到同一值，
// 因为全量包内嵌的前端资源，其版本就是该全量包的版本 —— 这是正确语义。
// 只发前端热更新时请改用：node scripts/bump-web-version.mjs <版本号>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncSwCache } from './sw-cache.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const next = process.argv[2];

if (!next || !/^\d+\.\d+\.\d+/.test(next)) {
  console.error('用法：node scripts/bump-version.mjs <版本号>，例如 0.1.4');
  process.exit(1);
}

const versionPath = resolve(root, 'version.json');
const meta = JSON.parse(readFileSync(versionPath, 'utf8'));
const from = meta.version;
meta.version = next;
// 发全量包时，内嵌前端资源版本 = 全量包版本，两者对齐是正确语义（见文件头说明）。
meta.webVersion = next;
writeFileSync(versionPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
console.log(`[bump] version.json 程序版本 ${from} → ${next}`);
console.log(`[bump] version.json 前端版本 webVersion = ${next}（全量包内嵌前端即此版本，一并对齐）`);

// 发全量包同样要 bust 网页端缓存：sw.js 的缓存名跟随 webVersion（发全量包时即本次版本）。
// 改不到就报错退出，绝不静默跳过。
try {
  const sw = syncSwCache(root, next);
  console.log(`[bump] sw.js 缓存名 CACHE_NAME ${sw.from} → ${next}${sw.changed ? '' : '（已是最新）'}`);
} catch (e) {
  console.error(`[bump] 同步 sw.js 缓存名失败：${e.message}`);
  process.exit(1);
}

// 注意：不能用「替换前后是否相同」来判断「有没有找到字段」——
// 目标值本来就等于当前值时，替换结果与原文一致，会被误报成"未找到版本号"，
// 反而让人去手工核对一个已经正确的值。这里用「正则是否命中」来判定，
// 并区分「已是最新」与「没找到字段」两种情况。
const bumpOne = (rel, re, replacer, label) => {
  const file = resolve(root, rel);
  const src = readFileSync(file, 'utf8');
  const m = src.match(re);
  if (!m) {
    console.warn(`[bump] ${label} 未找到版本号字段，请手动确认：${rel}`);
    return;
  }
  const current = m[1];
  if (current === next) {
    console.log(`[bump] ${label} 已是 ${next}，跳过`);
    return;
  }
  writeFileSync(file, src.replace(re, replacer), 'utf8');
  console.log(`[bump] ${label} ${current} → ${next}`);
};

bumpOne('package.json',
  /"version":\s*"([^"]+)"/,
  `"version": "${next}"`,
  'package.json');

bumpOne('src-tauri/tauri.conf.json',
  /"version":\s*"([^"]+)"/,
  `"version": "${next}"`,
  'tauri.conf.json');

// Cargo.toml 里 [package] 段的 version 是第一个匹配项，依赖里的 version = 出现在它之后
bumpOne('src-tauri/Cargo.toml',
  /^version = "([^"]+)"/m,
  `version = "${next}"`,
  'Cargo.toml');

console.log(`\n[bump] 完成。下一步：npm run release`);
