// 统一版本号：以根目录 version.json 为唯一真源，同步到 package.json / tauri.conf.json / Cargo.toml
// 用法：node scripts/bump-version.mjs 0.1.4
// 三处版本号各自维护是"客户端与网页端更新不同步"的隐藏根因，必须从源头收敛成一处。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
writeFileSync(versionPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');

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
