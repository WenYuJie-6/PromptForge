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
import { read, exists, readJSON, reporter } from './_check-lib.mjs';

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
const manifestKeys = ['version', 'notes', 'size', 'windows', 'app', 'web', 'service', 'internalLatest'];
const mfv = rustFn(rs, 'manifest_from_value') || '';
r.check(mfv.length > 0, '存在 manifest_from_value');
const missingKeys = manifestKeys.filter((k) => !mfv.includes(`"${k}"`));
r.check(missingKeys.length === 0, `manifest_from_value 解析它负责的全部字段（缺：${missingKeys.join(',') || '无'}）`);
r.check(mfv.includes('as_file'), 'manifest_from_value 支持字段的两种写法（字符串 / {file,size} 对象）');

const cu = stripLineComments(rustFn(rs, 'check_update') || '', '//');
r.check(cu.length > 0, '存在 check_update');
r.check((cu.match(/Err\(/g) || []).length >= 3, 'check_update 至少三处返回带原因的 Err');
r.check(/安装包字段/.test(cu) && /热更新包字段/.test(cu),
  '「程序本体/前端落后但清单缺字段」时给出具体原因（不再谎报「最新版本」）');
// 回归护栏：Ok(None) 只允许出现在「确实已是最新」这一条分支里
r.eq((cu.match(/Ok\(None\)/g) || []).length, 1, 'check_update 中只有 1 处 return Ok(None)');
// 结构断言：「取不到文件字段」的两个分支都必须以 return Err( 收尾，而不是落到 Ok(None)
{
  const fieldMissingBranches = cu.match(/None\s*=>\s*\{[\s\S]{0,220}?return Err\(/g) || [];
  r.check(fieldMissingBranches.length >= 2,
    `缺字段的 None 分支都以 Err 收尾（命中 ${fieldMissingBranches.length} 处，要求 ≥2）`);
}

const du = rustFn(rs, 'download_update') || '';
r.check(du.length > 0, '存在 download_update');
r.check(/format!\(/.test(du) && /\{/.test(du), 'download_update 按 {base}/{file} 拼接下载地址');

for (const fn of ['read_local_manifest', 'read_portable_manifest', 'read_webapp_manifest', 'read_best_local_manifest']) {
  r.check(new RegExp(`fn ${fn}\\b`).test(rs), `本地清单来源存在：${fn}`);
}
r.check(/read_best_local_manifest[\s\S]{0,600}?version/.test(rs), 'read_best_local_manifest 按版本号挑选最佳清单');

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

const br = read('scripts/build-release.mjs');
r.check(/RELEASE_UPDATE_URL/.test(br), 'build-release 支持 RELEASE_UPDATE_URL 覆盖');
r.check(/updateUrl/.test(br) && /manifest/.test(br), 'build-release 把 updateUrl 透传进清单');
r.check(/windows/.test(br) && /web/.test(br), 'build-release 清单含 windows / web 字段');

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
r.check(/if \(!appManifest\.web\)\s*appManifest\.web\s*=\s*\{\s*file:\s*`web-update-\$\{V\}\.json`\s*\};/.test(sd),
  'sync-dist 有「约定名兜底」语句：web = web-update-<v>.json');
// 两个脚本的命名约定必须一致，否则客户端按 A 名字找、实际产出是 B 名字
r.check(/const PRODUCT = 'PromptForge'/.test(br) && /\$\{PRODUCT\}-\$\{version\}-Setup\.exe/.test(br),
  'build-release 使用同一 windows 命名约定（PRODUCT-<v>-Setup.exe）');
r.check(/`web-update-\$\{version\}\.json`/.test(br), 'build-release 使用同一 web 包命名约定');

const wv = read('scripts/write-version.mjs');
r.check(/payload\.windows/.test(wv), 'write-version 把 windows 写入 dist/version.json');
r.check(/DIST_STRICT/.test(wv), 'write-version 支持 DIST_STRICT 严格模式');

r.check(exists('scripts/verify-update-chain.mjs'), '存在 verify-update-chain.mjs（端到端复刻判定）');
const vc = read('scripts/verify-update-chain.mjs');
r.check(/mkdirSync/.test(vc), 'verify-update-chain 写 .workbuddy 前先建目录（CI 上该目录不存在）');

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

// P1-3 回归护栏：仓库名来源与大小写
r.check(/GITHUB_REPOSITORY/.test(wf), 'CI 用 GITHUB_REPOSITORY 推导仓库名（workflow_dispatch 下也可靠）');
r.check(!/github\.event\.repository\.name/.test(wf), '不再使用 github.event.repository.name（该字段可能为空）');
r.check(!/tr\s+'\[:upper:\]'/.test(wf), '不对仓库名做转小写（GitHub Pages 路径按仓库名原名解析）');
r.check(/upload-pages-artifact/.test(wf) && /path:\s*dist/.test(wf), 'CI 上传 dist/ 作为 Pages 产物');
r.check(/fix-ps-encoding\.mjs/.test(wf), 'CI 构建前修正启动器脚本编码（PS5.1 BOM 陷阱）');

r.done();
