// 生成前端热更新包：把 dist 打包成 web-update-x.x.x.json 并更新 latest.json
// 用法：node scripts/make-web-update.mjs <版本号> [输出目录]
// 默认输出到 %LOCALAPPDATA%\PromptForge\Updates\
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(root, 'dist');

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法: node scripts/make-web-update.mjs <版本号> 如 0.1.3');
  process.exit(1);
}

const outDir = process.argv[3]
  ? resolve(process.argv[3])
  : join(homedir(), 'AppData', 'Local', 'PromptForge', 'Updates');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

function walk(dir, base) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const rel = join(base, name).replace(/\\/g, '/');
    if (name.isDirectory()) out.push(...walk(join(dir, name), rel));
    else out.push(rel);
  }
  return out;
}

const files = {};
for (const rel of walk(distDir, '')) {
  files[rel] = readFileSync(join(distDir, rel)).toString('base64');
}

const pack = { version, generatedAt: new Date().toISOString(), files };
const packName = `web-update-${version}.json`;
writeFileSync(join(outDir, packName), JSON.stringify(pack));
writeFileSync(
  join(outDir, 'latest.json'),
  JSON.stringify({ version, file: packName }, null, 2),
);
console.log(`已生成 ${packName}（${Object.keys(files).length} 个文件）与 latest.json → ${outDir}`);