# PromptForge 代码审查报告

审查范围：`index.html`、`sw.js`、`css/style.css`、`js/*.js`（15 个文件）、`scripts/*.mjs`
审查维度：性能（算法/内存/重复计算）、代码质量（重复/命名/职责/可读性）、健壮性（错误处理/边界/异常输入）

> **状态说明**：首轮审查共 38 项。随后对 P0 全部、P1 全部及高性价比 P2 项完成了修复，
> 已修复项见第一部分，未处理项见第二部分并保留分析与建议。
> 修复后已通过：全量语法校验、按 `index.html` 顺序的桩环境加载、顶层重名声明检测（0 冲突）、7 项关键断言。

---

## 一、已修复（✅）

### P0-1 `callLLM` 无限递归 —— 所有 AI 调用必崩
- **位置**：`js/api.js` 与 `js/unified-llm.js`
- **问题**：两个 classic script 都在顶层声明 `async function callLLM`。`api.js` 后加载会覆盖 `window.callLLM`，而它的函数体正是 `return window.callLLM(...)` → 自调用栈溢出。已用 Node `vm.runInThisContext` 实测确认覆盖行为。
- **修复**：删除 `api.js` 中的同名包装，全项目只保留 `unified-llm.js` 一处定义；`autoSelectFramework` 直接调用统一入口。
- **收益**：生成 / 评分 / 对比 / 框架选择全部恢复可用（此前 100% 不可用）。

### P0-2 流式回调硬编码全局函数 —— 框架对比串台 + 双写
- **位置**：`js/unified-llm.js` 的 `readStream`（原 `isOpenAI` 参数从未使用）
- **问题**：内部直接调用全局 `onUpdateStreaming(full)`，忽略调用方 `onUpdate`。框架对比三路并发流全写进主输出区，三列全程空白；单次生成每个 chunk 被渲染两次。
- **修复**：改为 `readStream(res, { signal, onUpdate })`，通过参数回调返回；删除无用参数。
- **收益**：框架对比可用，流式渲染开销减半。

### P0-3 `signal` 未透传 —— 「停止生成」对在线模式完全无效
- **位置**：`js/unified-llm.js` 的 `callOnlineLLM`
- **修复**：`fetch` 传入合并后的 signal（外部 abort + 120s 超时）；`readStream` 在 abort 时 `reader.cancel()` 并把 `AbortError` 上抛，让调用方走"保留已生成部分"分支；网络中断则保留已生成内容。
- **收益**：停止按钮真正生效，消除悬挂请求与无效 token 消耗。

### P0-4 顶层 `const` 不挂 window —— 离线引擎整体失效
- **位置**：`js/unified-llm.js`（`!window.OfflineLLM`）、`js/local-model.js`
- **问题**：顶层 `const/let/class` 只进全局词法环境，不成为 window 属性 → `window.OfflineLLM` 恒为 undefined。
- **修复**：`offline-llm.js` 末尾显式 `window.OfflineLLM = OfflineLLM`；`local-model.js` 改用裸引用并在缺失时明确抛错；`unified-llm.js` 改用 `typeof OfflineLLM === 'undefined'`。
- **收益**：离线模型下载 / 加载 / 推理整条链路恢复。

### P0-5 `showToast` 未定义
- 已改为 `toast()`。

### P0-6 本地模式设置写错 key
- `js/local-model.js` 原用 `promptforge_settings`，而 storage 层读 `pf_settings` → 已统一走 `loadSettings()` / `saveSettingsToStorage()`。

### P0-7 Service Worker 清空离线模型缓存
- **位置**：`sw.js` activate
- **修复**：增加 `PROTECTED_CACHES = ['transformers-cache', 'PromptForgeModels', ...]` 白名单。
- **收益**：不再因 SW 更新丢失 1~2GB 已下载模型。

### P1-8 流式渲染 O(n²)
- **位置**：`js/app.js` `onUpdateStreaming` / `escapeHTML` / 对比列写入
- **修复**：
  1. 新增 `scheduleWrite(el, getHTML, after)` —— 用 `requestAnimationFrame` 把同一元素同一帧内的多次写入合并为一次；
  2. `escapeHTML` 改为纯字符串 `replace`（原实现每次 `createElement` 新建 DOM 节点）；
  3. 对比列复用同一套调度，最终渲染前 `cancelPendingWrite` 丢弃中间帧。
- **收益**：长输出流式渲染的 DOM 解析次数从 O(n²) 降到每帧一次，并消除临时节点分配。顺带修复一处潜在注入——原 `escapeHTML` 不转义引号，而 `renderMarkdown` 会把结果拼进 `href="..."`。

### P1-9 本地推理每 token 重解整个序列
- **位置**：`js/offline-llm.js` `generate()`
- **修复**：记录 prompt 长度作为起点，只解码新增 token 并增量拼接（`decodeTail`）；拿不到 `.data`（部分 WebGPU 场景）时自动降级为整段解码；删除未使用的 `startCallback`。
- **收益**：解码量由 O(n²) 降为 O(n)；同时废弃了原来 `lastIndexOf('assistant')` 的脆弱截断，改为按 prompt 长度精确切分，正文里出现 "assistant" 不再导致结果被截。

### P1-10 缓存检测全量枚举 + Promise 当布尔用
- **位置**：`js/offline-llm.js` `isModelCached` / `deleteModelCache`、`js/local-model.js`
- **修复**：`transformers-cache` 的 `keys()` 结果做内存索引（`cacheIndexPromise` + `invalidateModelCacheIndex()`）；`renderLocalModelCards` / `selectModel` 改为 `await`；`modelCacheKey()` 对 modelId 做防御式解析。
- **收益**：修正"未下载模型也显示已下载"的状态错误；去掉每次 3 次的全量枚举。

### P1-11 更新轮询永不停止
- **修复**：`setInterval` 回调在 `document.hidden` 或离线时直接 return。

### P1-12 `loadModel` 无并发去重
- **修复**：`loadingTasks` Map 缓存 in-flight Promise，连点不再重复下载 GB 级模型。
- **附带修复**：`loadModel` 中原先调用 `generator.dispose()`（`generator` 是 `{tokenizer, model}` 普通对象，没有该方法）→ 抛错被吞、切换模型时旧模型从不释放。已改为 `generator.model.dispose()`。

### P2 已修（15 项）

| 项 | 位置 | 修复 |
|---|---|---|
| 跳过计数不同步 | `app.js` | `skipCount` 常量改为 `getSkipCount()` 即时读取，"跳过 3 次降灵敏度"在同一会话内生效 |
| `showOutput` 未校验 framework | `app.js` | `FRAMEWORKS[fw]` 兜底 + 转义，脏数据不再白屏 |
| `renderHistory` 字段裸用 | `app.js` | idea/output/framework/date 逐条兜底并转义 |
| `viewHistory` 无兜底 | `app.js` | 非法 framework 回落 costar，缺失时提示而非静默返回 |
| 历史 id 冲突 | `app.js` | 改为单调递增 `nextHistoryId()`（保持数字类型，不破坏内联 `onclick="viewHistory(${h.id})"`） |
| `onEngineChange` 重复定义 | `app.js` / `offline-ui.js` | 统一由 `app.js` 实现并调用 `renderModelCards` / `renderDeviceInfo` |
| `renderModelCards` 重复定义 | `local-model.js` / `offline-ui.js` | local-model 版改名 `renderLocalModelCards`；offline-ui 版（`.offline-model-card`，与 CSS 对应）成为唯一生效版本 |
| `getDeviceTypeName` 重复定义 | `device-detection.js` / `offline-ui.js` | 删除 device-detection 中的重复版本及死代码 `formatDeviceInfo`、`getDevicePerformanceLevel`（后者读的 `window.deviceInfo` 从未赋值，恒返回 unknown） |
| PWA 重复初始化 | `pwa.js` / `app.js` | `init()` 增加幂等标志，移除 `pwa.js` 自带的 DOMContentLoaded 监听 |
| PWA 支持性误判 | `pwa.js` | 去掉非标准的 `'BeforeInstallPromptEvent' in window` 判断，只检查 Service Worker |
| SW 绝对路径 | `sw.js` | 清单改为相对路径并补全 `model-manager.js`；`addAll` 改为逐条 `add` + `allSettled`（单个 404 不再导致整体安装失败）；fetch 拦截改用解析后的 pathname 集合 |
| `encodeShare` O(n²) | `app.js` | 分块 `String.fromCharCode.apply`（每块 32KB） |
| 云同步竞态 | `sync.js` | 增加 `syncInFlight` 并发锁，重复触发复用同一结果 |
| 云同步无超时 | `sync.js` | `supabaseFetch` 统一 20s 超时 |
| 动态 import 重复回退 | `offline-llm.js` | `importTransformers` 结果缓存，失败时清空以便重试 |

---

## 二、未处理（⬜，按影响排序）

> 以下条目在后续迭代中已部分解决，逐条标注状态：
> **✅ 已解决** / **🔶 部分解决** / **⬜ 仍待处理**。

### 二·零 本轮（2026-09）修复的两个用户报告故障

**F-1 更新推送失效：旧客户端"检查更新"永远显示"最新版本"** —— ✅ 已解决

- **根因（三层叠加，都在"静默退化"上）**：
  1. `check_update` 在「程序本体落后但清单缺 `windows`/`app` 字段」时 `return Ok(None)`，
     前端把 `null` 渲染成"已是最新版本" —— **把"清单不完整"谎报成"没有更新"**。
  2. 更新源只有两条路：用户手填 `updateUrl`，或把清单放进
     `%LOCALAPPDATA%\PromptForge\Updates`。而根 `version.json` 的 `updateUrl` 为空字符串，
     `release/version.json` 连该字段都没有 —— **默认状态下客户端没有任何可用更新源**。
  3. `dist-app/`（打进安装包的干净前端）里没有 `version.json`，
     装好的客户端无法从自身安装目录读到任何清单。
- **修复**：
  - Rust 侧不再静默退化：缺字段时返回带原因的 `Err`，用户看到"清单缺哪个字段、清单上是哪个版本"。
  - 本地清单来源从 1 处扩到 3 处（主程序目录 / 前端资源目录 / 更新文件夹），
    并对多来源取**版本号最高**的一份（`read_best_local_manifest`）。
  - `sync-dist.mjs` 往 `dist-app/` 写入 `version.json` —— 客户端自带出生清单。
  - `index.html` 注入 `PF_DEPLOY_BASE`（运行时由 `location` 推导），
    前端 `resolveUpdateBaseUrl` 形成 6 层兜底，**不再依赖人工填写**。
  - `build-release.mjs` 把根 `version.json` 的 `updateUrl` 透传进发布清单，
    并支持 `RELEASE_UPDATE_URL` 覆盖。
  - `update_state` 新增 `local_manifest_version` / `manifest_origin`，
    前端提示从"未配置"升级为"来自哪份清单、清单上是哪个版本"。
- **验证**：新增 `.workbuddy/check-update-chain.mjs`（26 项断言）+ `verify-update-chain.mjs` 场景 4/4.5/7。

**F-2 网页端下载流程过于复杂** —— ✅ 已解决

- **根因**：旧实现是「HEAD 探测 → 按探测结果弹窗 → 用户选 exe/msi → 再点一次」。
  探测在 `file://` 与部分静态托管下必然抛异常，代码只好引入"未知"第三态，
  第三态又要靠弹窗安抚 —— 于是**每次下载都至少经过一个弹窗**，
  且"点了没反应"（`<a download>` 被 file:// 静默忽略）成为高频投诉。
- **修复**：改为**点击即下载** —— 立刻 `<a download>` 触发，无任何前置询问；
  探测移到下载动作之后，且只有明确 404 才提示。固定用 `Latest-Setup.exe`，
  取消 exe/msi 二选一（对普通用户是纯负担，两者都能装）。
- **无法绕过的唯一例外**：`file://` —— 浏览器协议层面禁止网页触发下载。
  此时明确说明原因并给出手动路径，同时告知"部署到 Web 服务器即可一键下载"。
- **验证**：`check-download-ux.mjs` 重写为 4 场景（HTTP 一键 / 404 提示 / file:// 说明 / 桌面端拒绝）
  + `check-update-chain.mjs` B 组 13 项断言。

**F-3 `file://` 下的下载/SW/PWA 同源限制** —— ✅ 已解决

- **根因**：浏览器把每一个 `file://` 路径视为独立 origin。
  这一个根因同时导致四个症状——
  `<a download>` 被静默忽略、`fetch('version.json')` 同源失败、
  Service Worker 注册被拒、`navigator.registerProtocolHandler` 不可用。
  用户问"能注册 Custom URI Scheme 解决吗"，答案是**不能**：
  scheme 关联的是**已安装**的桌面程序（`tauri-plugin-deep-link` 的方向），
  解决不了"先拿到安装包"这个鸡生蛋问题。
- **修复**：发布包附 `启动.bat` + `启动.ps1`（仅 `dist/`，不进 `dist-app/`，
  避免 Tauri 安装包自我膨胀），在 `127.0.0.1` 起 `HttpListener` 静态服务，
  浏览器打开 `http://127.0.0.1:14370/` 即恢复全部能力。
  - 端口固定 `14370..14390`（保 `localStorage`/IndexedDB origin 不变），
    全占用才退到 `40000..60000` 随机端口并显式提示"设置会丢失"。
  - 127.0.0.1 单接口绑定、`GetFullPath` + 前缀检查防路径穿越、
    `.exe`/`.msi` 必带 `Content-Disposition: attachment`。
  - 自带 `_selftest-launcher.ps1` 22 项断言（MIME 9 + 穿越 6 + 实机 8），`check:all` 链入。
- **关键陷阱**：Windows PowerShell 5.1 仅在文件**带 BOM**时按 UTF-8 解码，
  否则按系统 ANSI 代码页解码 —— 中文注释全部乱码、token 流错位，
  报出位置完全错误的假语法错误（如 line 125 `}` unexpected）。
  所有 `*.ps1` 必须 UTF-8 BOM + CRLF；`scripts/fix-ps-encoding.mjs`（纳入 `check:all`）
  校验并自动修复，`sync-dist.mjs` 在写完 `dist/` 后立刻调用一次。
- **验证**：`check:psencoding` + `check:launcher`（实机起 `HttpListener`，请求 `/index.html`、
  `/js/app.js`、`/version.json`、`/Latest-Setup.exe` 验 200、`/nope.txt` 验 404，
  并验 `Content-Disposition`/`Content-Type` 与 exe 体积）。

1. **✅ 已解决** — ~~`model-manager.js` / `model-download-worker.js` 为死代码（约 480 行）~~
   - `model-download-worker.js` 已于更早一轮删除；本轮核实 `ModelManager` 在删除 worker 后
     仍**零外部引用**（`window.ModelManager` / `MODEL_CONFIGS` / `getModelConfig` 全部无人读取，
     `downloadModel` 是 `local-model.js` 自己的方法）。`js/model-manager.js`（382 行）已删除，
     `index.html` 的 script 标签与 `sw.js` 的 `STATIC_CACHE_URLS` 条目同步移除，
     SW 缓存版本从 `v1.2.0` 升到 `v1.2.1` 以便客户端拉取新清单。
     脚本数 18 → 17，17/17 在沙盒中加载无异常。
   - 其中唯一有价值的资产（三个 `icon` 字段）已迁入下面的唯一数据源。

2. **✅ 已解决** — ~~模型元数据重复维护 4 份~~
   - 原状：`local-model.js` 的 `modelInfo` + `modelCards`、`offline-llm.js` 的 `MODEL_OPTIONS`、
     `offline-ui.js` 里还有一份硬编码 `modelMap`（第四份）。
   - 现以 **`OfflineLLM.MODEL_OPTIONS` 为唯一事实源**，补齐 `key`（稳定短键）与 `icon` 字段，
     并导出 `MODEL_BY_KEY` / `MODEL_BY_ID` / `resolveModel()`。
     - `local-model.js` 的 `modelInfo` 与 `modelCards` 均由它 map 派生
     - `offline-ui.js` 的 `modelMap` 改为薄薄的"展示名 → 短键"映射 + `resolveModel()`
   - 顺带修掉一个**真实的不一致隐患**：死代码 `model-manager.js` 用短键 `smollm2`，
     而生效代码用 `smollm` —— 若哪天有人误引死代码，短键就会对不上。
     现在短键只有一处定义。
   - 验证：`check-model-metadata.mjs` 17 项 + `check-model-derivation.mjs` 在沙盒中真跑派生结果 8 项断言。

3. **⬜ 仍待处理** — 模块边界缺失
   - 15 个 js 全是 classic script，跨文件依赖靠加载顺序隐式保证。
   - 建议：整体迁移 `<script type="module">` + 显式 export/import。收益最大但回归面也最大，
     需要真实浏览器里跑一轮完整功能。**建议单独一个迭代专门做，不要与功能改动混在一起。**

4. **🔶 部分解决** — `app.js` 单文件约 1800 行
   - 本轮未拆分。但随着死代码删除与元数据收敛，跨文件耦合已减少。
   - 拆分仍是好事，但优先级低于第 3 项（拆了之后如果又迁 module，等于重做两遍）。

5. **⬜ 仍待处理** — `frameworks.js` 三个 `buildPrompt` 高度重复
   - 可参数化为 `makeBuildPrompt(name, dims)`。纯内部重构，风险低，适合随手做。

6. **✅ 已解决** — ~~`loadSettings()` 高频重复解析~~
   - 实测 **24 个调用点**，跨 8 个文件，每次都 `JSON.parse(localStorage)`。
   - 现加入内存缓存，三条纪律：写入即失效、**返回副本**（防调用方就地改脏）、
     提供 `invalidateSettingsCache()` 供云同步等外部写入兜底。
   - 已确认全项目所有 `pf_settings` 写入都经过 `saveSettingsToStorage`，无遗漏失效路径。
   - 验证：`check-settings-cache.mjs` 15 项（含"改返回值不影响缓存"与"外部写入需显式失效"）。

7. **⬜ 仍待处理** — `state._autoReason` 未在 state 字面量声明
   - 由 `api.js` 动态写入，属隐式字段。低风险，补一行声明即可。

8. **✅ 已解决** — ~~`offline-ui.js` 把 `err.message` 直接拼进 `innerHTML`~~
   - 原有 **两处**：`downloadAndLoadModel` 的 catch 与 `renderDeviceInfo` 的 catch。
     这两处的 `err.message` 可能来自远端（HF 仓库报错体、网络错误），属真实注入面。
   - 现新增 `setModelStatus(text, color)` 统一走 `textContent`，并收敛了另外两处状态写入
     （`unloadOfflineModel` / `deleteOfflineModel`）保持风格一致；
     `renderDeviceInfo` 的错误分支改为先建骨架再用 `textContent` 填消息。
   - 验证：`check-xss-and-styles.mjs` 用真实载荷 `<img src=x onerror=alert(1)>` 断言其
     完整进入 `textContent` 且 `innerHTML` 为空。

9. **⬜ 仍待处理** — 分享链接无长度上限
   - 超长提示词生成的 URL 可能超出二维码接口限制。建议超长时提示改用文件导出。

10. **✅ 已解决** — ~~`pwa.js` 每次调用往 `<head>` 注入同名 `<style>`~~
    - 实测两处（toast 的 `@keyframes`、info 面板的样式），每次调用都 `createElement('style')` 无脑 append。
    - 现统一为 `injectStyleOnce(id, css)`，同 id 只注入一次。
    - 验证：`check-xss-and-styles.mjs` 场景 1 连调 3 次断言 `<head>` 中只剩 1 个元素。

11. **⬜ 仍待处理** — `sync.js` 无重试与失败退避，仅单次超时。

12. **✅ 已解决** — ~~`dist/` 是源码的字节级副本却与源码一并存在于工作区~~
    - `dist/` 与 `dist-app/` 均已加入 `.gitignore`，仅在打包时生成。

13. **⬜ 仍待处理** — `addHistory` 无去重：重复点"保存"会产生多条内容相同的记录。

14. **⬜ 仍待处理** — `importAllData` 只校验顶层结构，不校验 `history[]` 每项字段，
    也无文件大小/类型二次校验。

---

## 二·补 本轮新增的防护性检查

上述修复都配套了可重复执行的回归脚本（均在 `.workbuddy/` 下，已接入 `npm run check:all`）：

| 脚本 | 覆盖 | 断言数 |
| --- | --- | --- |
| `check-model-metadata.mjs` | 唯一数据源结构、短键不再分叉、派生化彻底 | 17 |
| `check-model-derivation.mjs` | 沙盒中真跑 17 个脚本，校验派生结果一致性 | 8 |
| `check-settings-cache.mjs` | 缓存命中/失效/副本隔离/损坏兜底 | 15 |
| `check-xss-and-styles.mjs` | 真实 XSS 载荷不解析 + 样式幂等注入 | 13 |
| `check-download-ux.mjs` | 下载流程 4 种部署环境（HTTP 一键 / 404 / file:// / 桌面端） | 21 |
| **`check-update-chain.mjs`** | **更新链路：不再静默退化、多来源清单、自描述部署根、一键下载** | **26** |
| `run-all-checks.mjs` | 统一跑全部 11 个套件（失败判定只认行首 FAIL/✗） | — |

`scripts/verify-update-chain.mjs` 另做端到端复刻校验（7 个场景，含 dist / release /
dist-app 三份清单的实机判定），并接入 `npm run release` 的最后一环。

---

## 三、修复后验证

- 全量 `js/*.js` + `sw.js` 语法校验：15/15 通过。
- 按 `index.html` 顺序在桩环境中加载全部 14 个脚本：全部无异常。
- 顶层重名声明检测：**0 冲突**（修复前存在 `onEngineChange` / `renderModelCards` / `getDeviceTypeName` 三处）。
- 关键断言 7/7 通过：`callLLM` 唯一且不自调用、`window.OfflineLLM` 可用、`escapeHTML` 转义正确、`renderModelCards` 指向 offline-ui 版本、`getDeviceTypeName` 唯一、`scheduleWrite` 存在、`getSkipCount` 存在。
- 源码已同步至 `dist/`。

> 注：本地推理的增量解码依赖 `step[0].data` 可同步读取；少数 WebGPU 后端下会自动降级为整段解码，功能不受影响，仅性能退化为原行为。此路径建议在真实设备上跑一次离线生成确认。
