// ============================================================
// check-update-chain.mjs —— 更新链路（不再静默退化 / 多来源清单 / 自描述部署根 / 一键下载）
//
// 校验目标（静态审计 Rust 后端 + 前端 + 构建脚本 + CI 工作流）
//   A. Rust：check_update 不再把「清单不完整」谎报成「没有更新」；
//      清单字段解析齐全；本地清单有多个来源；
//      且更新检查与离线模型**没有耦合**（离线模型不得出现在 lib.rs）。
//   B. 前端：resolveUpdateBaseUrl 保留多层兜底；index.html 自描述部署根。
//   C. 清单与构建：updateUrl 透传、windows/web 桥接（dist/ 与 dist-app/ 都要）。
//   D. CI：deploy.yml 的先决顺序与地址注入方式（P0-1 / P1-3 回归护栏）。
//
// 输入：src-tauri/src/lib.rs、index.html、js/app.js、version.json、scripts/*.mjs、
//       .github/workflows/deploy.yml（全部只读）
// 输出：逐条 '✓' / 'FAIL'，末行 '>>> check-update-chain: N PASS / M FAIL'
// 失败判定：任一断言失败 → 打印 FAIL 行并以退出码 1 结束
//
// 为什么值得单列：历史上「发布了新版，旧客户端永远显示最新版本」反复出现，
// 根因是三层静默退化叠加。把这些不变量固化成断言，比事后排查便宜得多。
// ============================================================
import { read, exists, readJSON, reporter, P } from './_check-lib.mjs';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const r = reporter('check-update-chain');

// 从 Rust 源码中截取某个顶层 fn 的函数体（到下一个顶层 fn 为止）
function rustFn(src, name) {
  const head = new RegExp(`\\n(?:pub\\s+)?(?:async\\s+)?fn\\s+${name}\\b`);
  const m = head.exec(src);
  if (!m) return null;
  const next = /\n(?:pub\s+)?(?:async\s+)?fn\s+\w+/g;
  next.lastIndex = m.index + 1;
  const n = next.exec(src);
  return src.slice(m.index, n ? n.index : src.length);
}

// 去掉整行注释。注释里会举例说明「过去的错误写法」，直接扫源码会误判。
// 只删「行首（可含空白）即注释符」的行，不会误伤字符串里出现的 // 或 #。
function stripLineComments(src, mark) {
  const re = mark === '#' ? /^\s*#/ : /^\s*\/\//;
  return src.split('\n').filter((l) => !re.test(l)).join('\n');
}

// ---- A. Rust 后端 ----
r.section('A. Rust 后端（src-tauri/src/lib.rs）');
const rs = read('src-tauri/src/lib.rs');

r.check(/fn http_client\b/.test(rs), '存在 http_client（独立的 reqwest 客户端）');
r.check(/async fn fetch_remote_manifest\b/.test(rs), '存在 fetch_remote_manifest');
r.check(/version\.json/.test(rustFn(rs, 'fetch_remote_manifest') || ''), 'fetch_remote_manifest 请求 {base}/version.json');

// 注意 manifest_from_value 只负责它管的那几个键；
// updateUrl / minAppVersion 是**前端字段**（Rust 侧完全不读，见 lib.rs 中 0 次出现）。
const manifestKeys = ['version', 'webVersion', 'notes', 'size', 'windows', 'app', 'web', 'service', 'internalLatest'];
const mfv = rustFn(rs, 'manifest_from_value') || '';
r.check(mfv.length > 0, '存在 manifest_from_value');
const missingKeys = manifestKeys.filter((k) => !mfv.includes(`"${k}"`));
r.check(missingKeys.length === 0, `manifest_from_value 解析它负责的全部字段（缺：${missingKeys.join(',') || '无'}）`);
r.check(mfv.includes('as_file'), 'manifest_from_value 支持字段的两种写法（字符串 / {file,size} 对象）');
// webVersion 是**可选**字段：旧清单没有它，缺失时必须保持 None，不能报错让整条检查失败
r.check(/\.get\("webVersion"\)[\s\S]{0,80}?as_str\(\)/.test(mfv),
  'manifest_from_value 以可选方式读取 webVersion（缺失时保持 None，不报错）');

const cu = stripLineComments(rustFn(rs, 'check_update') || '', '//');
r.check(cu.length > 0, '存在 check_update');
r.check((cu.match(/Err\(/g) || []).length >= 3, 'check_update 至少三处返回带原因的 Err');
r.check(/安装包字段/.test(cu) && /热更新包字段/.test(cu),
  '「程序本体/前端落后但清单缺字段」时给出具体原因（不再谎报「最新版本」）');
// 回归护栏：Ok(None) 只允许出现在「确实已是最新」这一条分支里
r.eq((cu.match(/Ok\(None\)/g) || []).length, 1, 'check_update 中只有 1 处 return Ok(None)');
// 结构断言：「缺字段」的两个错误分支都必须以 return Err( 收尾，而不是落到 Ok(None)。
// 重构后判定已抽进 decide_update，check_update 只负责把 DecideError 翻译成面向用户的 Err。
{
  const errBranches = cu.match(/Err\(DecideError::\w+\)\s*=>\s*\{[\s\S]{0,400}?return Err\(/g) || [];
  r.check(errBranches.length >= 2,
    `缺字段的两个 DecideError 分支都以 return Err 收尾（命中 ${errBranches.length} 处，要求 ≥2）`);
  r.check(/DecideError::MissingAppAndWeb/.test(cu) && /DecideError::MissingWebField/.test(cu),
    'check_update 区分「无安装包也无前端包」与「缺 web 字段」两种诊断');
}
// 前端版本轴（本次改造核心）：app 轴用 newest_app，前端轴用 newest_web（取自清单 webVersion）。
// 少了这条独立轴，「改一行前端也要升 app 版本 → 必须重装」的老毛病就会复发。
//
// 注意：判定逻辑已抽成纯函数 decide_update（不依赖 Tauri 运行时 / 无 IO），由 check_update 调用。
// 断言必须贴着「纯函数结构」写 —— 把 token 绑死在 check_update 内部会在重构后误报。
const rn = stripLineComments(rustFn(rs, 'resolve_newest') || '', '//');
r.check(rn.length > 0, '存在纯函数 resolve_newest（解析两条版本轴）');
r.check(/web_version[\s\S]{0,120}?unwrap_or\(app\)/.test(rn),
  'resolve_newest 里 webVersion 缺失/非法时回退 app 版本（旧清单语义）');

// decide_update 的提取会连带把「下一个 fn 前的属性行」也切进来（rustFn 到下一个 fn 的
// 起始换行为止），那行里的 `tauri::` 会误触发"依赖 Tauri"判定 —— 先剥掉 `#` 属性行再断言。
const duFn = stripLineComments(stripLineComments(rustFn(rs, 'decide_update') || '', '//'), '#');
r.check(duFn.length > 0, '存在纯函数 decide_update（更新抉择，不依赖 Tauri 运行时）');
r.check(!/tauri::|AppHandle|std::fs|reqwest/.test(duFn),
  'decide_update 不依赖 Tauri 运行时与 IO（可被单测直接覆盖）');
r.check(/newest_app\s*>\s*cur_app/.test(duFn), 'decide_update 按 newest_app > cur_app 判定 app 轴');
r.check(/newest_web\s*>\s*cur_web/.test(duFn),
  'decide_update 的 web 分支按 newest_web > cur_web 判定（前端可独立于程序更新）');

// 组装层（结构性堵死 R1b）：check_update 必须只把**整份清单**交给 decide_from_manifest，
// 且**不再**直接出现 decide_update( / resolve_newest( —— 两条版本轴只可能从清单里各读一次，
// 「把同一个版本变量传两次」这类接线错误在结构上就写不出来。
const dfm = stripLineComments(stripLineComments(rustFn(rs, 'decide_from_manifest') || '', '//'), '#');
r.check(dfm.length > 0, '存在纯函数 decide_from_manifest（解析 + 组装 + 抉择，接收整个 Manifest）');
r.check(/resolve_newest\(/.test(dfm), 'decide_from_manifest 内部调用 resolve_newest');
r.check(/decide_update\(/.test(dfm), 'decide_from_manifest 内部调用 decide_update');
r.check(/decide_from_manifest\(\s*&manifest/.test(cu), 'check_update 把整份清单 &manifest 交给 decide_from_manifest');
r.check(!/decide_update\(/.test(cu), 'check_update 不再直接调用 decide_update（接线面收进纯函数）');
r.check(!/resolve_newest\(/.test(cu), 'check_update 不再直接调用 resolve_newest（接线面收进纯函数）');

// P2：判定逻辑必须被真实单测钉死（不是靠 JS 复刻或文本 token），且 CI 会真的跑它。
r.check(/#\[cfg\(test\)\]/.test(rs) && /mod tests\b/.test(rs), 'lib.rs 含 #[cfg(test)] mod tests');
{
  const tests = rs.slice(rs.indexOf('mod tests'));
  const caseCount = (tests.match(/#\[test\]/g) || []).length;
  r.check(caseCount >= 8, `单测覆盖 ≥8 条用例（实际 ${caseCount}）`);
  r.check(/decide_from_manifest\(/.test(tests),
    '单测覆盖 decide_from_manifest（解析 + 组装链路，而不仅是 decide_update）');
  r.check(/is_better_candidate\(/.test(tests), '单测覆盖 is_better_candidate（P3 排序护栏）');
  r.check(/wiring_app_same_web_ahead_yields_web/.test(tests),
    '单测含接线用例：manifest.version==cur_app 但 webVersion 领先 → Web（对应 R1b）');
  r.check(/decide_update\(/.test(tests), '单测真值表直接调用 decide_update');
  r.check(/app_same_and_web_ahead_is_web/.test(tests),
    '单测含核心用例：app 相同 + 前端 webVersion 领先 → Web');
  r.check(/resolve_newest\("1\.2\.3",\s*Some\("abc"\)\)/.test(tests),
    '单测含「webVersion 非法 → 回退且不 panic」用例');
  r.check(/resolve_newest\("1\.2\.3",\s*None\)/.test(tests),
    '单测含「旧清单无 webVersion → 回退」用例');
}

const du = rustFn(rs, 'download_update') || '';
r.check(du.length > 0, '存在 download_update');
r.check(/format!\(/.test(du) && /\{/.test(du), 'download_update 按 {base}/{file} 拼接下载地址');

for (const fn of ['read_local_manifest', 'read_portable_manifest', 'read_webapp_manifest', 'read_best_local_manifest']) {
  r.check(new RegExp(`fn ${fn}\\b`).test(rs), `本地清单来源存在：${fn}`);
}
r.check(/read_best_local_manifest[\s\S]{0,600}?version/.test(rs), 'read_best_local_manifest 按版本号挑选最佳清单');
r.check(/fn is_better_candidate\b/.test(rs), '存在纯函数 is_better_candidate（候选/当前二元组比较）');
{
  const rbl = stripLineComments(rustFn(rs, 'read_best_local_manifest') || '', '//');
  r.check(/is_better_candidate\(/.test(rbl),
    'read_best_local_manifest 调用 is_better_candidate 判定（P3 二元组排序真护栏）');
}

// 关键解耦断言：离线模型不得掺进更新检查
r.check(!/OfflineLLM|local_model|local-model|transformers/i.test(rs),
  'lib.rs 中不含离线模型相关代码（更新检查与离线推理完全解耦）');

// ---- B. 前端 ----
r.section('B. 前端（index.html / js/app.js）');
const html = read('index.html');
r.check(/PF_DEPLOY_BASE/.test(html), 'index.html 注入 PF_DEPLOY_BASE');
r.check(html.indexOf('PF_DEPLOY_BASE') < html.indexOf('<script src='), '注入发生在业务脚本之前');

const app = read('js/app.js');
r.check(/function getUpdateBaseUrl\b/.test(app), 'app.js 有 getUpdateBaseUrl（读用户设置）');
r.check(/async function resolveUpdateBaseUrl\b/.test(app), 'app.js 有 resolveUpdateBaseUrl（多层兜底）');
const resolveBody = app.slice(app.indexOf('async function resolveUpdateBaseUrl'));
r.check(/loadSettings\(\)\.updateUrl|getUpdateBaseUrl\(\)/.test(resolveBody.slice(0, 900)), '兜底链第 1 层：用户设置的更新源');
r.check(/version\.json/.test(resolveBody.slice(0, 900)), '兜底链第 2 层：清单里的 updateUrl');
r.check(/PF_DEPLOY_BASE/.test(resolveBody.slice(0, 900)), '兜底链第 3 层：本页部署地址');

// ---- C. 清单与构建脚本 ----
r.section('C. 清单与构建脚本');
const meta = readJSON('version.json');
r.check(!!meta, 'version.json 可解析');
r.check('version' in meta, 'version.json 有 version');
r.check('updateUrl' in meta, 'version.json 有 updateUrl（允许为空，但不能缺键）');
r.check('minAppVersion' in meta, 'version.json 有 minAppVersion');
r.check('webVersion' in meta, 'version.json 有 webVersion（前端资源版本轴）');

const br = read('scripts/build-release.mjs');
r.check(/RELEASE_UPDATE_URL/.test(br), 'build-release 支持 RELEASE_UPDATE_URL 覆盖');
r.check(/updateUrl/.test(br) && /manifest/.test(br), 'build-release 把 updateUrl 透传进清单');
r.check(/windows/.test(br) && /web/.test(br), 'build-release 清单含 windows / web 字段');
// 前端版本轴：清单与热更新包都必须用 webVersion，否则热更新后前端版本轴会失效
r.check(/const webVersion = \(meta\.webVersion \|\| version\)\.trim\(\)/.test(br),
  'build-release 独立解析 webVersion（缺失回退 version）');
r.check(/const manifest = \{[\s\S]{0,120}?webVersion/.test(br), 'build-release 清单含 webVersion 字段');

const sd = read('scripts/sync-dist.mjs');
r.check(/distApp[\s\S]{0,80}version\.json|version\.json[\s\S]{0,80}distApp/.test(sd), 'sync-dist 写 dist-app/version.json');
r.check(/release\/version\.json/.test(sd), 'sync-dist 读取 release/version.json');
// 回归护栏（P0-2）：dist-app 的清单必须带 windows/web，且必须在构建**之前**就补齐
r.check(/appManifest\.windows/.test(sd) && /appManifest\.web/.test(sd),
  'sync-dist 把 windows/web 桥接进 dist-app/version.json（P0-2 修复）');
// 注意：必须精确匹配「兜底赋值语句」本身。
// `PromptForge-${V}-Setup.exe` 这个名字在 sync-dist 的 deployItems 里也存在，
// 只搜字符串会命中他处 → 断言变成恒真（负向测试实测踩过这个坑）。
r.check(/if \(!appManifest\.windows\)\s*appManifest\.windows\s*=\s*\{\s*file:\s*`PromptForge-\$\{V\}-Setup\.exe`\s*\};/.test(sd),
  'sync-dist 有「约定名兜底」语句：windows = PromptForge-<v>-Setup.exe');
r.check(/if \(!appManifest\.web\)\s*appManifest\.web\s*=\s*\{\s*file:\s*`web-update-\$\{WV\}\.json`\s*\};/.test(sd),
  'sync-dist 有「约定名兜底」语句：web = web-update-<webVersion>.json');
// 两条版本轴各按各的命名：windows 用 app 版本 V，web 用前端版本 WV
r.check(/const WV = \(metaAll\.webVersion \|\| V\)\.trim\(\)/.test(sd),
  'sync-dist 独立解析 WV = webVersion（缺失回退 V）');
r.check(/webVersion:\s*WV/.test(sd), 'sync-dist 把 webVersion 写进 dist-app/version.json');
// 两个脚本的命名约定必须一致，否则客户端按 A 名字找、实际产出是 B 名字
r.check(/const PRODUCT = 'PromptForge'/.test(br) && /\$\{PRODUCT\}-\$\{version\}-Setup\.exe/.test(br),
  'build-release 使用同一 windows 命名约定（PRODUCT-<app版本>-Setup.exe）');
r.check(/`web-update-\$\{webVersion\}\.json`/.test(br), 'build-release 用 webVersion 命名热更新包');
r.check(/JSON\.stringify\(\{\s*version:\s*webVersion,\s*files\s*\}\)/.test(br),
  'build-release 热更新包内 version 用 webVersion（否则热更新后前端版本轴失效）');

const wv = read('scripts/write-version.mjs');
r.check(/payload\.windows/.test(wv), 'write-version 把 windows 写入 dist/version.json');
r.check(/DIST_STRICT/.test(wv), 'write-version 支持 DIST_STRICT 严格模式');
r.check(/webVersion:\s*WebV/.test(wv), 'write-version 把 webVersion 透传进 dist/version.json');
r.check(/web-update-\$\{WebV\}\.json/.test(wv), 'write-version 的 web 兜底名按 webVersion 命名');

// 两条版本轴各有自己的 bump 脚本：app 轴（bump-version）与前端轴（bump-web-version）
const bv = read('scripts/bump-version.mjs');
r.check(/meta\.webVersion\s*=\s*next/.test(bv),
  'bump-version 同时把 webVersion 与 version 对齐（全量包内嵌前端即该版本）');
r.check(exists('scripts/bump-web-version.mjs'), '存在 bump-web-version.mjs（纯前端改动的版本轴）');
{
  const bwv = read('scripts/bump-web-version.mjs');
  const bwvCode = stripLineComments(bwv, '//');
  r.check(/meta\.webVersion\s*=\s*next/.test(bwvCode), 'bump-web-version 设置 version.json 的 webVersion');
  r.check(!/meta\.version\s*=/.test(bwvCode), 'bump-web-version 不改 version（app 版本不受影响）');
  r.check((bwvCode.match(/writeFileSync\(/g) || []).length === 1, 'bump-web-version 只写 version.json 一个文件');
}

r.check(exists('scripts/verify-update-chain.mjs'), '存在 verify-update-chain.mjs（端到端复刻判定）');
const vc = read('scripts/verify-update-chain.mjs');
r.check(/mkdirSync/.test(vc), 'verify-update-chain 写 .workbuddy 前先建目录（CI 上该目录不存在）');
r.check(/webVersion/.test(vc), 'verify-update-chain 复刻了 webVersion 前端版本轴');
r.check(/app 版本相同、仅 webVersion 领先/.test(vc),
  'verify-update-chain 含核心验收场景：app 相同、webVersion 领先 → web 热更新');

// ---- D. CI 工作流 ----
r.section('D. CI 工作流（.github/workflows/deploy.yml）');
const wfRaw = read('.github/workflows/deploy.yml');
// 断言只看「生效的配置」，不看注释 —— 注释里会正当地提到旧写法作为反面教材
const wf = stripLineComments(wfRaw, '#');
r.check(/inject-pages-url\.mjs/.test(wf), 'CI 用独立脚本注入 Pages 地址（避免 node -e 引号问题）');
r.check(exists('scripts/inject-pages-url.mjs'), 'inject-pages-url.mjs 存在');

// P0-1 回归护栏：sync:dist 必须早于 tauri-build，
// 否则 cargo build 在编译期读不到 dist-app/ 而 panic（proc macro panicked）。
const atSync = wf.indexOf('run: npm run sync:dist');
const atBuild = wf.indexOf('run: node scripts/tauri-build.mjs');
r.check(atSync >= 0, 'CI 显式执行 `npm run sync:dist`');
r.check(atBuild >= 0, 'CI 执行 `node scripts/tauri-build.mjs`');
r.check(atSync >= 0 && atBuild >= 0 && atSync < atBuild,
  'sync:dist 早于 tauri-build（P0-1：dist-app 是 cargo 编译期依赖）');
r.check(/verify-update-chain\.mjs/.test(wf), 'CI 末段跑 verify-update-chain');
// 「断言存在却没人执行」是与更新链路同源的缺口：CI 必须真的跑 .workbuddy/run-all-checks.mjs
// （约 680 项断言的总闸，含 check-sw-cache 等新增护栏），否则全靠开发者本机自觉。
r.check(/run:\s*node\s+\.workbuddy\/run-all-checks\.mjs/.test(wf),
  'CI 运行 .workbuddy/run-all-checks.mjs（全部套件，而非只跑 verify-update-chain）');
{
  const atAllChecks = wf.indexOf('.workbuddy/run-all-checks.mjs');
  const atBuildRelease = wf.indexOf('Build release package');
  r.check(atAllChecks >= 0 && atBuildRelease >= 0 && atAllChecks > atBuildRelease,
    'run-all-checks 位于 Build release package 之后（其内 verify-update-chain 需要 release/ 产物，过早在 CI 上假红）');
}

// P1-3 回归护栏：仓库名来源与大小写
r.check(/GITHUB_REPOSITORY/.test(wf), 'CI 用 GITHUB_REPOSITORY 推导仓库名（workflow_dispatch 下也可靠）');
r.check(!/github\.event\.repository\.name/.test(wf), '不再使用 github.event.repository.name（该字段可能为空）');
r.check(!/tr\s+'\[:upper:\]'/.test(wf), '不对仓库名做转小写（GitHub Pages 路径按仓库名原名解析）');
r.check(/upload-pages-artifact/.test(wf) && /path:\s*dist/.test(wf), 'CI 上传 dist/ 作为 Pages 产物');
r.check(/fix-ps-encoding\.mjs/.test(wf), 'CI 构建前修正启动器脚本编码（PS5.1 BOM 陷阱）');

// P2 回归护栏：CI 必须真的执行 Rust 单测，否则 decide_update 的真值表形同虚设。
// 位置还必须在 tauri-build 之前 —— 单测要在打包前就拦住判定逻辑的回归。
r.check(/cargo test/.test(wf), 'CI 执行 cargo test（真实运行 Rust 单测，而非只做文本断言）');
{
  const atRustTest = wf.indexOf('cargo test');
  r.check(atRustTest >= 0 && atBuild >= 0 && atRustTest < atBuild,
    'cargo test 早于 tauri-build（单测在编译/打包前把关）');
  r.check(/cargo test[\s\S]{0,160}?--manifest-path src-tauri\/Cargo\.toml/.test(wf)
      || /--manifest-path src-tauri\/Cargo\.toml[\s\S]{0,160}?cargo test/.test(wf),
    'CI 的 cargo test 指定 src-tauri/Cargo.toml（在正确的工作目录执行）');
}

// ---- E. bump-web-version.mjs 执行级验证 ----
// 仅做文本审计不够：必须真的把脚本跑一遍，断言「只有 version.json 的 webVersion 变了」，
// 其余字段与其它版本载体一律不动。全程在**临时副本**上操作，绝不触碰工作区。
r.section('E. bump-web-version.mjs 执行级验证（临时副本）');
{
  const wcBefore = read('version.json');
  const tmp = mkdtempSync(join(tmpdir(), 'pf-bumpweb-'));
  try {
    mkdirSync(join(tmp, 'scripts'), { recursive: true });
    copyFileSync(P('scripts/bump-web-version.mjs'), join(tmp, 'scripts/bump-web-version.mjs'));
    // 脚本现在还会把 sw.js 的 CACHE_NAME / API_CACHE_NAME 跟随 webVersion 改写
    // （结构性 bust 网页端缓存，见 scripts/sw-cache.mjs），故 fixture 必须一并提供依赖：
    // 共享助手 sw-cache.mjs 与目标文件 sw.js。仅补 fixture，未改动任何断言。
    copyFileSync(P('scripts/sw-cache.mjs'), join(tmp, 'scripts', 'sw-cache.mjs'));
    copyFileSync(P('version.json'), join(tmp, 'version.json'));
    copyFileSync(P('sw.js'), join(tmp, 'sw.js'));

    const before = JSON.parse(readFileSync(join(tmp, 'version.json'), 'utf8'));
    const target = '9.9.9';
    const run = spawnSync(process.execPath, [join(tmp, 'scripts', 'bump-web-version.mjs'), target], {
      encoding: 'utf8',
      timeout: 30000,
    });
    r.check(run.status === 0, `临时副本上脚本执行成功（exit=${run.status}）`);
    if (run.status !== 0) {
      r.info('stderr: ' + String(run.stderr || '').trim().slice(0, 400));
    }
    const after = JSON.parse(readFileSync(join(tmp, 'version.json'), 'utf8'));
    r.check(after.webVersion === target, `只有 webVersion 被设为 ${target}`);
    r.check(after.version === before.version, `version 保持不变（仍为 ${before.version}）`);
    // 逐键比对：除 webVersion 外任何字段发生变化都视为越界
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changed = [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    r.check(changed.length === 1 && changed[0] === 'webVersion',
      `仅 webVersion 一个键发生变化（实际变化：${changed.join(',') || '无'}）`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // 工作区必须原样：临时副本跑脚本绝不能波及真实 version.json
  r.check(read('version.json') === wcBefore, '工作区 version.json 未被脚本触碰（仅在临时副本上运行）');
}

r.done();
