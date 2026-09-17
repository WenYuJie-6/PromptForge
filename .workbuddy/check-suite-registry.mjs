// ============================================================
// check-suite-registry.mjs —— 套件注册表一致性（目录 ↔ runner ↔ check:all）
//
// 背景（与本项目反复出现的「断言存在却没人执行」同源）：
//   · .workbuddy/ 下新增了 check-*.mjs，却忘了注册进 run-all-checks.mjs → runner 漏跑；
//   · run-all-checks.mjs 注册了套件，却忘了加进 package.json 的 check:all → 跑 check:all 漏跑。
// 两者都会让"新增的护栏"静默失效。本节把这三者的对齐锁成断言，防止再次发生。
//
// 校验目标：
//   A. .workbuddy/ 下每个 check-*.mjs 都出现在 run-all-checks.mjs 的 suites 里（无遗漏）；
//   B. run-all-checks.mjs 里每个套件都指向真实存在的文件（无幽灵）；
//   C. package.json 的 check:all 覆盖 run-all-checks 的每一个套件（无遗漏）；
//   D. run-all-checks.mjs 里没有重复注册的套件。
//
// 输入：.workbuddy/ 目录、.workbuddy/run-all-checks.mjs、package.json（只读）
// 输出：逐条 '✓' / 'FAIL'，末行 '>>> check-suite-registry: N PASS / M FAIL'
// 失败判定：任一断言失败 → 打印顶格 'FAIL' 行并以退出码 1 结束
// ============================================================
import { read, readJSON, exists, reporter, P } from './_check-lib.mjs';
import { readdirSync } from 'node:fs';

const r = reporter('check-suite-registry');
const runner = read('.workbuddy/run-all-checks.mjs');
const pkg = readJSON('package.json');
const checkAll = String((pkg && pkg.scripts && pkg.scripts['check:all']) || '');

// runner 里的 suites：形如 ['name', 'path'],
const suiteEntries = [...runner.matchAll(/\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g)]
  .map((m) => ({ name: m[1], path: m[2] }));
const suitePaths = suiteEntries.map((s) => s.path);
r.check(suitePaths.length >= 10, `runner 解析出 ${suitePaths.length} 个套件（>=10，防正则失效后静默通过）`);

// .workbuddy 下实际的套件文件（用 P() 绝对定位，不依赖 cwd）
const dirSuites = readdirSync(P('.workbuddy'))
  .filter((f) => /^check-.*\.mjs$/.test(f))
  .map((f) => '.workbuddy/' + f)
  .sort();

// ---- A. 目录 → runner ----
r.section('A. 目录下每个 check-*.mjs 都注册进了 runner');
r.check(dirSuites.length >= 10, `.workbuddy 下有 ${dirSuites.length} 个 check-*.mjs（>=10）`);
{
  const notRegistered = dirSuites.filter((p) => !suitePaths.includes(p));
  r.check(notRegistered.length === 0,
    `每个 .workbuddy/check-*.mjs 都在 run-all-checks 的 suites 里（漏注册：${notRegistered.join(',') || '无'}）`);
}

// ---- B. runner → 文件真实存在 ----
r.section('B. runner 的每个套件都指向真实文件');
{
  const missingFiles = suitePaths.filter((p) => !exists(p));
  r.check(missingFiles.length === 0, `runner 里每个套件文件都存在（缺失：${missingFiles.join(',') || '无'}）`);
}

// ---- C. runner → check:all ----
r.section('C. package.json 的 check:all 覆盖 runner 的每个套件');
r.check(checkAll.length > 0, 'package.json 定义了 check:all');
{
  const notInCheckAll = suitePaths.filter((p) => !checkAll.includes(p));
  r.check(notInCheckAll.length === 0,
    `check:all 覆盖 run-all-checks 的每个套件（漏：${notInCheckAll.join(',') || '无'}）`);
}

// ---- D. 无重复注册 ----
r.section('D. 无重复注册');
{
  const seen = new Set();
  const dup = suitePaths.filter((p) => (seen.has(p) ? true : (seen.add(p), false)));
  r.check(dup.length === 0, `runner 没有重复注册的套件（重复：${dup.join(',') || '无'}）`);
}

r.done();
