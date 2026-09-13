// 把 GitHub Pages 地址写进根 version.json 的 updateUrl。
//
// 为什么抽成独立脚本而不是 CI 里内联 node -e：
//   `node -e '...' "$url"` 在 Windows runner 的 Git Bash 下，`-e` 脚本本身含双引号、
//   `$url` 又含 `://`，引号转义链极脆弱（实测会直接 SyntaxError）。
//   抽成文件后 CI 只需 `node scripts/inject-pages-url.mjs "$url"`，彻底消除引号地狱。
//
// 用法：node scripts/inject-pages-url.mjs <url>
//   <url> 形如 https://<owner>.github.io/<repo>/
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = (process.argv[2] || '').trim();

// 校验：必须是 https 开头、非空、且不是一个「空 repo 名」的畸形地址。
// 过去 repo 名为空会静默写成 https://user.github.io// —— 必须拦住。
if (!url) {
  console.error('[inject-pages-url] 中止：未提供 URL。');
  process.exit(1);
}
if (!/^https:\/\/[^/]+\/[^/]+/.test(url)) {
  console.error(`[inject-pages-url] 中止：URL 形如 https://<owner>.github.io/<repo>/，收到「${url}」。`);
  console.error('[inject-pages-url] 常见原因：仓库名为空，或工作流拿到的 repository 上下文缺失。');
  process.exit(1);
}

const p = resolve(root, 'version.json');
const j = JSON.parse(readFileSync(p, 'utf8'));
const before = j.updateUrl || '';
j.updateUrl = url;
writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8');

console.log(`[inject-pages-url] version.json updateUrl: "${before}" -> "${url}"`);
