// 统一跑全部校验套件。失败判定只认「行首带 FAIL/✗」，避免匹配到
// '>>> 结果: 17 PASS / 0 FAIL' 这类自述统计行造成假失败。
import { spawnSync } from 'node:child_process';

const NODE = process.execPath;
const suites = [
  ['check-dist', 'scripts/check-dist.mjs'],
  ['check-frameworks', '.workbuddy/check-frameworks.mjs'],
  ['check-styles', '.workbuddy/check-styles.mjs'],
  ['check-ui-wiring', '.workbuddy/check-ui-wiring.mjs'],
  ['check-download-ux', '.workbuddy/check-download-ux.mjs'],
  ['check-update-chain', '.workbuddy/check-update-chain.mjs'],
  ['check-runtime-info', '.workbuddy/check-runtime-info.mjs'],
  ['check-sw-cache', '.workbuddy/check-sw-cache.mjs'],
  ['check-suite-registry', '.workbuddy/check-suite-registry.mjs'],
  ['check-model-metadata', '.workbuddy/check-model-metadata.mjs'],
  ['check-model-derivation', '.workbuddy/check-model-derivation.mjs'],
  ['check-settings-cache', '.workbuddy/check-settings-cache.mjs'],
  ['check-xss-and-styles', '.workbuddy/check-xss-and-styles.mjs'],
  ['check-a11y-static', '.workbuddy/check-a11y-static.mjs'],
  ['verify:update', 'scripts/verify-update-chain.mjs'],
];

const clean = (s) => (s || '').split('\n').filter((l) => !/shell-runtime-bash-env|dirname: command not found/.test(l));

// 真正的失败：以 FAIL 或 ✗ 开头的行，或 '✗ ' / 'FAIL  ' 出现在行首空白之后
const isFailLine = (l) => /^\s*(FAIL|✗)\b/.test(l) && !/^\s*>>>/.test(l);

let bad = 0;
const rows = [];
for (const [name, script] of suites) {
  const r = spawnSync(NODE, [script], { encoding: 'utf8', timeout: 300000 });
  const lines = clean((r.stdout || '') + (r.stderr || ''));
  const fails = lines.filter(isFailLine);
  const summary = lines.find((l) => /^>>>/.test(l)) || '';
  if (r.status !== 0 || fails.length) bad++;
  rows.push({ name, status: r.status, fails, summary: summary.trim() });
  console.log('  ' + name.padEnd(24) + 'exit=' + String(r.status).padEnd(3) + ' 失败行=' + fails.length + (summary ? '   ' + summary : ''));
  fails.slice(0, 5).forEach((l) => console.log('        ' + l.trim()));
}

console.log('');
console.log(bad ? ('>>> ' + bad + ' 个套件未通过') : '>>> 全部套件通过');
process.exit(bad ? 1 : 0);
