# PromptForge 项目审计报告

> 审计范围：项目结构 / 配置方式 / 依赖管理 / 安装部署流程，以及与同类开源 Tauri + PWA 项目的横向对比；
> 并模拟安装到不同 OS 版本与硬件环境，验证安装与运行是否会失败或出现兼容性问题。
>
> 审计方式：静态代码与配置审计 + 产物（exe/msi）二进制解析 + Node 复刻的目标环境沙盒断言。
> 所有结论均给出可复现的证据来源。

---

## 0. 结论速览

| 维度 | 结果 |
|---|---|
| 与同类项目的不一致点 | 15 项：**3 项为真实缺陷**，5 项轻微缺陷，7 项属个人风格（可接受） |
| 沙盒环境验证 | 覆盖 8 类 OS、4 种硬件架构、6 种系统区域、6 种路径环境、8 种网络/残留状态、14 种浏览器 |
| 安装/运行会失败的场景 | **4 类**：Win7/8.1、无外网设备、企业禁用 WebView2、IE 内核浏览器 |
| 必须修复（P0/P1） | **6 项** |
| 建议修复（P2） | **7 项** |
| 可忽略（P3，属风格） | **7 项** |

**一句话结论：** 这是一份"工程质量明显高于平均水平、但发布工程（release engineering）几乎为零"的项目。代码本体、依赖管理、体积控制都是同类中的优等生；真正的问题集中在**对外交付环节**——缺少 README/.gitignore/LICENSE、安装器语言与 WebView2 策略未针对真实用户分群、文档缺失导致用户拿到软件后不知道前置条件。

---

## 1. 与同类项目的不一致点（逐项判定）

判定口径：
- **个人风格** = 不违反社区惯例、不影响他人使用与协作，只是作者偏好；
- **轻微缺陷** = 不影响功能，但会在协作/发布/排障时造成困惑或返工；
- **缺陷** = 会导致实际功能损失、难以排障、或与自身声明不符。

### 1.1 项目结构

| # | 检查点 | 现状 | 同类惯例 | 判定 |
|---|---|---|---|---|
| 1 | `README.md` | **缺失** | 开源/共享项目的入口文档，必备 | **缺陷** |
| 2 | `LICENSE` 文件 | **缺失** | `package.json` 已声明 `license: ISC`，但无许可文件 | 轻微缺陷 |
| 3 | `.gitignore` | **缺失** | 必备 | **缺陷** |
| 4 | 根目录散落过程文档 | 有 `CODE_REVIEW.md`(11KB)、`TEMPLATE_TEST_REPORT.md`(25KB)、`LOCAL_MODEL_README.md`(8KB)、`PWA_INSTALL_GUIDE.md`(4KB) | 过程产物应放 `docs/` 或 `docs/audit/`；根目录只留 README/CHANGELOG/LICENSE | 轻微缺陷 |
| 5 | 根目录放二进制产物 | `Latest-Setup.exe`(3.4MB) + `Latest.msi`(5.4MB) 直接在根目录 | 发布产物应放 `release/` 或 `dist/`，根目录不进二进制（无 `.gitignore` 时会被提交） | 轻微缺陷 |
| 6 | 构建脚本组织 | `scripts/` 下 5 个自研 `.mjs`（sync-dist / write-version / bump-version / build-release / make-web-update），职责分工清晰 | 许多 Tauri 项目把这类逻辑塞进 `package.json` 单行命令或 shell 脚本 | **良好的个人风格** |
| 7 | 版本号单一来源 | `version.json` 作为唯一真源，由 `bump-version.mjs` 同步到 `package.json` / `tauri.conf.json` / `Cargo.toml` | 多数项目直接以 `package.json` 为真源，Rust 侧靠 `tauri.conf.json` 手抄 | **良好的个人风格** |

### 1.2 配置方式

| # | 检查点 | 现状 | 同类惯例 | 判定 |
|---|---|---|---|---|
| 8 | `tauri.conf.json` 完整性 | 仅 984 B，配置了 `bundle.targets:"all"`、`csp:null`、`assetProtocol.scope:["**"]` | 同类项目通常配置 `csp` 白名单、`windows.title/size`、`plugins.updater` | 个人风格（但见 §3 安全项） |
| 9 | 模块体系 | 全部 17 个脚本以经典 `<script src>` 顺序加载，无打包器 | 现代项目普遍用 Vite/Rollup + ES Module | 个人风格（代价见 §3 P2-3） |
| 10 | 代码规范工具 | `.editorconfig` / ESLint / Prettier **全无** | 前端项目至少配 `.editorconfig` | 轻微缺陷 |
| 11 | `package.json` 元信息 | `author:""`、`license:"ISC"`(默认值)、无 `private:true`、无 `type` 字段 | 应填真实作者、加 `private:true` 防误发布 | 轻微缺陷 |
| 12 | `Cargo.toml` 元信息 | `authors=["you"]`、`license=""`、`repository=""` 为脚手架残留 | 应填实际值 | 轻微缺陷 |
| 13 | 本地开发脚本 | `beforeDevCommand` 与 `beforeBuildCommand` 同为 `npm run sync:dist`，即**没有 dev server** | 同类项目 dev 模式走 Vite HMR | 个人风格（改前端的反馈循环 = 手动重跑） |
| 14 | CI/CD | **无** `.github/workflows` | 同类 Tauri 项目普遍有 release workflow | 个人风格（本项目单人本地构建） |
| 15 | 服务端配置内联 | `service.json` 含 `key` 字段，注释说明"前端配置里的 key 对任何访客可见" | 应仅存受限代理令牌；此处已有警示，处理得当 | **良好的个人风格** |

### 1.3 依赖管理

| # | 检查点 | 现状 | 判定 |
|---|---|---|---|
| 16 | npm 依赖 | 仅 1 个 devDependency（`@tauri-apps/cli`），8 个平台可选包 | **优秀** |
| 17 | Rust 生产依赖 | 7 个：`serde` / `serde_json` / `log` / `tiny_http` / `base64` / `reqwest` / `tauri`+`tauri-plugin-log` | **优秀** |
| 18 | 锁文件 | `package-lock.json` + `Cargo.lock` 均存在 | **优秀** |
| 19 | 传递依赖规模 | `Cargo.lock` 482 个包，其中 40 个 Windows 系 crate（体积换来的跨平台能力），可接受 | 正常 |
| 20 | `reqwest` 特性裁剪 | `default-features=false, features=["json","default-tls"]`，Windows 下走 `schannel`，规避 `aws-lc-sys` 的 C 工具链依赖 | **优秀的个人判断**（含注释说明） |
| 21 | Rust 版本约束 | `rust-version = "1.77.2"` | **优秀**（同类项目常缺失） |

> 注意：`Cargo.lock` 中同时存在 `aws-lc-rs`/`aws-lc-sys`/`rustls`，说明这些是别的依赖间接引入的，虽然最终未启用，但首次编译耗时（实测约 11 分钟）主要来自这里。

### 1.4 安装部署流程

| # | 检查点 | 现状 | 判定 |
|---|---|---|---|
| 22 | 安装器语言 | NSIS `languages:["SimpChinese"]` + `displayLanguageSelector:false` → 英文/日文/土耳其语/葡语系统上**强制显示中文向导** | 轻微缺陷 |
| 23 | MSI 与 NSIS 语言不一致 | NSIS 纯中文，MSI 名为 `*_en-US.msi`（纯英文） | 轻微缺陷 |
| 24 | WebView2 获取方式 | 未声明 `webviewInstallMode` → 用默认 `downloadBootstrapper`（需外网） | **缺陷（限离线场景）** |
| 25 | 安装模式 | `installMode:"currentUser"` → 装到 `%LOCALAPPDATA%`，不触发 UAC | **正确的选择** |
| 26 | 架构覆盖 | 仅产出 x64；ARM64 / ia32 无 | 轻微缺陷 |
| 27 | 产物命名 | 同一份安装包在 `release/`、`bundle/`、`dist/` 出现 3 次，且有 `Latest-Setup.exe` 别名 | 个人风格（为覆盖"找不到 exe"的诉求） |
| 28 | 卸载入口 | 已按要求从安装向导移除，移至设置页底部 | **符合要求** |
| 29 | 卸载器定位逻辑 | 候选列表含 `unins000.exe`（Inno Setup 命名）与 `Uninstall.exe` | 轻微缺陷（见 §3 P2-1） |
| 30 | 卸载残留处理 | 未暴露"删除应用数据"开关 | 轻微缺陷（离线模型缓存可达 GB 级） |

---

## 2. 沙盒环境验证结果

### 2.1 操作系统（8 类）

| 系统 | 结果 | 说明 |
|---|---|---|
| Windows 11 21H2/22H2/23H2/24H2 | 可安装 | WebView2 强制预装，引导器秒过 |
| Windows 10 21H2/22H2 | 可安装 | 随 Edge 预装 |
| Windows 10 1903/1909 | 可安装 | 同上 |
| Windows 10 1809 LTSB/LTSC | 可安装（需联网） | 无 Edge，靠引导器下载 |
| Windows Server 2016/2019/2022 | 可安装（需联网） | 默认无 Edge，必须联网 |
| **Windows 7 SP1** | **会失败** | WebView2 自 2024-01 起停止支持 Win7/8.1；Tauri 2 官方最低要求 Win10 1809 |
| **Windows 8.1** | **会失败** | 同上 |
| Windows 10 早期预览版 / 未打补丁的 1809 以下 | 会失败 | 低于 build 17763 |

> 说明：PE 头里 `MajorOperatingSystemVersion = 6.0`，这只是链接器的保守默认值，**不代表支持 Vista**；实际门槛由 WebView2 与 Tauri 2 决定。

### 2.2 WebView2（关键风险点）

当前配置 = `downloadBootstrapper`（官方 schema 默认值）。逐个场景：

| 场景 | 结果 |
|---|---|
| Win11 / Win10 22H2（有 Edge） | 可安装 |
| Win10 1809 LTSC / Server（无 Edge） | 可安装（需外网） |
| **内网 / 完全离线设备** | **会失败**：卡在 WebView2 下载步骤，无离线兜底 |
| **需认证代理的设备（企业 PAC）** | **有风险**：引导器走系统代理，认证型代理会静默失败 |
| **企业组策略移除/禁用 WebView2** | **会失败**：引导器装不上，且无自定义提示文案 |

官方提供的 5 种模式对比：

| 模式 | 体积增量 | 是否需外网 | 适用 |
|---|---|---|---|
| `skip` | 0 | — | 确定目标机已有 WebView2 |
| `downloadBootstrapper`（**当前**） | ~0 | **需要** | 面向消费级互联网用户 |
| `embedBootstrapper` | +1.8MB | 需要 | 略优（引导器不落盘） |
| `offlineInstaller` | +127MB | **不需要** | 内网/离线分发 |
| `fixedRuntime` | +180MB | 不需要 | 需锁定运行时版本 |

### 2.3 硬件架构

| 项 | 结果 |
|---|---|
| x64 | 有包，正常 |
| **ARM64（Surface Pro X、骁龙本）** | **无原生包**。x64 包经 PRISM 仿真可运行，但 WebView2 在 ARM64 上是原生进程、宿主是仿真进程，部分 WRY 版本会出现白屏/崩溃 |
| ia32（32 位 Windows） | 无包。Win10 32 位仍有存量，用户会直接报"此应用无法在你的电脑上运行" |
| 安装包体积 | 3.4MB（NSIS）/ 5.4MB（MSI）——与同规模 Tauri 应用（3–6MB）一致 |
| 主程序体积 | 12.5MB——正常，无 Electron 级别开销 |
| 低内存设备 | 无风险（对比 Electron 动辄 150MB+ 内存） |

### 2.4 系统区域与编码

| 项 | 结果 |
|---|---|
| PowerShell 调用 | `.args(["-NoProfile","-NonInteractive","-Command",&ps])` → **已正确处理**，不会被用户 profile 污染 |
| `cmd.exe` 调用 | `.args(["/C",&full])` → **以变量传参，非字符串拼接**，路径中的 `&` `^` `%` 不会被 cmd 展开 |
| `OsStr::to_str().unwrap()` | 未发现（仅有 `to_string_lossy()`，安全） |
| 中文用户名路径 | 实测读写正常 |
| 空格路径（`D:\New Folder`） | 实测读写正常 |
| `&` 符号路径 | 实测读写正常 |
| 括号+空格（`Program Files (x86)`） | 实测读写正常 |
| 超 MAX_PATH（>260） | 主程序 PE manifest 含 `longPathAware=true`（由 Tauri/NSIS 模板注入），可工作在长路径模式 |
| 英文/日文/土耳其语/葡语系统 | 安装向导仍显示简体中文（见 §1.4 #22） |

### 2.5 网络与更新源

| 场景 | 结果 |
|---|---|
| 在线（有外网） | 正常 |
| **离线** | "检查更新"降级为读取本地 manifest，功能不崩但发现不了新版本 |
| **更新源 404** | 已有 `testUpdateSource()` 与错误透出，处理良好 |
| 更新源超时 | 已设 15s / 600s 分级超时，合理 |
| **`updateUrl` 为空（当前发布配置）** | **无发布服务器时，"检查更新"在任何真实用户机器上都只能读到本地上次下载的版本** |
| 认证代理 / PAC | 无代理感知代码，企业环境可能失败 |

### 2.6 安装残留与权限

| 场景 | 结果 |
|---|---|
| 干净设备 | 正常 |
| 有旧版存在 | NSIS 走 `RestorePreviousInstallLocation`，会沿用旧路径；`allowDowngrades:false` 阻止降级 |
| 旧版 + `uninstall.exe` 被删 | 代码回落失败，但仍指引用户去"设置→应用和功能"，可接受 |
| 多用户设备 | `currentUser` 模式各自安装到自己的 `%LOCALAPPDATA%`，不冲突 |
| 受限账户（无管理员） | 可安装，不触发 UAC |
| 只读安装目录 | NSIS 会报错，属预期行为 |
| 卸载后重新安装 | `%LOCALAPPDATA%\PromptForge` 残留（含热更新目录、离线模型缓存） |

### 2.7 浏览器兼容（前端网页版）

以 `index.html` 实际加载的 17 个脚本计算：

| 特性 | Safari 版本要求 | 类型 | 出现次数 |
|---|---|---|---|
| `navigator.storage`（**有 `&&` 短路守卫**） | 17 | 运行时（安全） | 3 |
| 可选链 `?.` | 13.1 | **语法级** | 28 |
| `Promise.allSettled` | 13 | 运行时 | 1 |
| `AbortController` | 11.1 | 运行时 | 7 |

- **语法级最高门槛：Safari 13.1**（不兼容会导致整个 js 文件解析失败 → 白屏）
- **运行时最高门槛：Safari 13**（不兼容只会局部报错）
- `navigator.storage`（Safari 17）因有守卫，**不会**抬高门槛

分环境结论：

| 环境 | 结果 | 说明 |
|---|---|---|
| Chrome 80+ / Edge（Chromium） | 可用 | 完全兼容 |
| Chrome 79 及以下 | 白屏 | `?.` / `??` 需 Chrome 80 |
| Firefox 74+ | 可用 | |
| Firefox 68 ESR | 白屏 | `?.` 需 FF74 |
| Safari 15+ / iOS 15+ | 可用 | |
| Safari 13.1–14.1 | 基本可用 | 14.0 缺类私有字段支持，会白屏 |
| Safari 13.0 及以下 | 白屏 | |
| **IE 11 / 老 Edge** | **白屏** | 无 `<script nomodule>`、无 `<noscript>` 兜底，用户只看到白屏 |
| **360 / QQ 浏览器"兼容模式"（IE 内核）** | **白屏** | 国内用户高频踩坑点 |
| Android 微信/QQ 内置浏览器 | 视内核版本 | 老旧 X5 内核（Chrome 66 系）不支持 `?.` → 白屏 |
| `file://` 直接打开 | 部分可用 | 无 SW、无 PWA 安装、`fetch` 受限 |

**CSS 侧**：`gap`(40次)、`inset`(2次)、`backdrop-filter`(4次) 在旧浏览器中只会样式降级，不致命。

### 2.8 页面级健壮性（附加验证）

| 项 | 结果 |
|---|---|
| 顶层声明总数 | 198 个（跨 17 个文件） |
| **跨文件顶层重名** | **0 处** —— 经典 script 架构下无静默覆盖，控制得很好 |
| 内联事件处理器 | 82 个，调用 58 个不同函数 |
| 内联处理器指向 `const`/`let` 声明 | **0 处** —— 无"内联 onclick 找不到符号"风险 |
| `sw.js` 预缓存清单 vs 磁盘 | 23 条全部存在，无 404 |
| `dist/` 与源码一致性 | `dist/index.html` 与根 `index.html` 内容完全一致 ✅ |
| `dist/js/` 与根 `js/` | 各 18 个文件，完全一致 ✅ |

---

## 3. 汇总：需修复的问题（按严重程度排序）

### P0 — 必须修复，直接影响用户

| # | 问题 | 证据 | 修复方案 |
|---|---|---|---|
| **P0-1** | **缺 `README.md`**：用户/协作方拿到项目不知道这是什么、怎么跑、前置条件是什么（尤其"Win10 1809+ / 需要外网装 WebView2"） | 根目录无 `README.md`（已核验 40+ 常见文件名，均不存在） | 新建 `README.md`，至少含：项目简介、运行前置（Win10 1809+、WebView2）、开发命令（`npm run tauri:dev` / `tauri:build` / `release`）、目录结构、发布流程、已知限制（ARM64/离网/旧浏览器） |
| **P0-2** | **缺 `.gitignore`**：`node_modules/`、`src-tauri/target/`（数 GB）、`dist/`、`release/`、根目录的 `Latest-Setup.exe`+`Latest.msi`（9MB 二进制）都会进版本控制 | 根目录无 `.gitignore`；仅 `src-tauri/.gitignore` 存在（只忽略 `/target/` 和 `/gen/schemas`） | 新建根 `.gitignore`：`node_modules/`、`dist/`、`release/`、`*.exe`、`*.msi`、`.workbuddy/`、`src-tauri/target/` |
| **P0-3** | **Win7 / Win8.1 用户装了会失败**：Tauri 2 最低 Win10 1809，WebView2 已停止支持 Win7/8.1。但项目未在任何对用户可见处声明 | Tauri 2 官方文档；WebView2 于 2024-01 终止 Win7/8.1 支持 | 在 README + `release/发布说明.md` + 下载页显著标注系统要求；安装器可加最低版本检查与友好提示 |
| **P0-4** | **无外网设备安装会卡死**：`webviewInstallMode` 用默认 `downloadBootstrapper`，安装过程必须联网下载 WebView2 | 安装包 3.35MB（无内嵌运行时特征）；官方 schema 确认默认值需外网 | 二选一：① 面向内网用户额外发布一个 `offlineInstaller` 版本（+127MB）；② 明确只在文档中告知"安装需联网"，并给出手动预装 WebView2 的步骤与链接 |

### P1 — 应当修复，影响特定用户群

| # | 问题 | 证据 | 修复方案 |
|---|---|---|---|
| **P1-1** | **`updateUrl` 为空 → "检查更新"在真实用户机上永远发现不了新版本** | `version.json` 的 `updateUrl: ""`、`serviceUrl: ""` | 部署一个发布服务器（任意静态托管即可），把 `updateUrl` 指向其根；或至少在 README 中写明"不配置发布源时检查更新不可用" |
| **P1-2** | **不支持的浏览器直接白屏，无任何提示** | `index.html` 无 `<noscript>`、无 `<script nomodule>`、无 UA 版本检测；门槛为 Chrome 80 / Safari 13.1 | 加 `<noscript>` 提示块；加一小段 UA 检测（或用 `??`/`?.` 的 try-catch 包裹）给出"请升级浏览器"的友好页面 |
| **P1-3** | **安装向导在非中文系统上强制显示中文** | `nsis.languages:["SimpChinese"]` + `displayLanguageSelector:false` | 改为 `["SimpChinese","English"]` + `displayLanguageSelector:true`，让英文系统自动落到英文 |
| **P1-4** | **卸载后残留数据不清理**：离线模型缓存在 `%LOCALAPPDATA%` 下可达 GB 级 | 代码中无 `DeleteAppData` 相关处理；Tauri NSIS 模板本身支持该复选框 | 启用 NSIS 的"删除应用数据"选项，或在设置页卸载前给出提示 |

### P2 — 建议修复，工程质量与可维护性

| # | 问题 | 证据 | 修复方案 |
|---|---|---|---|
| **P2-1** | **卸载器候选列表与注释均写错**：注释称"NSIS 生成的卸载程序固定叫 unins000.exe"，但 Tauri 官方 NSIS 模板实际是 `WriteUninstaller "$INSTDIR\uninstall.exe"`。3 个候选中 2 个（`unins000.exe`、`parent/unins000.exe`）永远命中不了 | 从 `cli.win32-x64-msvc.node` 中提取到模板原文 `WriteUninstaller "$INSTDIR\uninstall.exe"`；二进制中 `unins000` 出现 0 次 | 删掉两个 Inno 命名候选，改为 `dir.join("uninstall.exe")`，并修正注释。**功能本身可用**（第 2 个候选靠 Windows 大小写不敏感命中），但误导性死代码会害后来者 |
| **P2-2** | **`js/model-download-worker.js` 是死代码**，且被 `sw.js` 预缓存 | 该文件不在 `index.html` 的 17 个 `<script>` 中，也无任何动态 import；却在 `sw.js` 缓存清单里 | 要么接入（若本地模型下载 Worker 确实需要），要么删除并从 `sw.js` 清单移除。同类需一并评估 `model-manager.js` 全文 |
| **P2-3** | **`dist/js/` 与根 `js/` 完全重复**，经典 script 无打包 | 两侧各 18 个文件、内容一致；`dist/` 是复制型产物 | 属架构选择，可接受；但应确保 `.gitignore` 忽略 `dist/`，并考虑引入轻量打包（Vite）以获得 HMR 与 tree-shaking |
| **P2-4** | **未声明 `longPathAware` 的显式保障** | 主程序 manifest 由 Tauri 模板注入 `longPathAware=true`，是"幸运地正确" | 记录到 README/设计说明，避免未来换打包方式时静默丢失 |
| **P2-5** | **`package.json` / `Cargo.toml` 元信息为脚手架残留** | `author:""`、`license:"ISC"`、`authors=["you"]`、`license=""`、`repository=""` | 填真实值；`package.json` 加 `"private": true` 防误发布 |
| **P2-6** | **无代码规范工具** | `.editorconfig` / ESLint / Prettier 全无；18 个 js 文件、1 个 64KB 的 `app.js` | 至少加 `.editorconfig`；`app.js` 已 64KB，建议按职责拆分（更新、平台菜单、优化流程） |
| **P2-7** | **未提供 ARM64 / ia32 包** | `bundle/` 只有 x64 | 若目标用户含 Surface Pro X / 骁龙本，补 `--target aarch64-pc-windows-msvc`；否则在 README 标注"仅支持 x64" |

### P3 — 可忽略（属个人风格，不影响使用）

| # | 项 | 说明 |
|---|---|---|
| P3-1 | 无 CI/CD | 单人本地构建，`build-release.mjs` 已承担发布职责 |
| P3-2 | 无 Vite/打包器 | 经典 script 顺序加载，实测 198 个顶层声明零重名，控制良好 |
| P3-3 | `version.json` 作为版本真源 | 比行业常见的"以 package.json 为真源"更严谨，且有自动同步脚本 |
| P3-4 | 无 rustfmt.toml / clippy 配置 | 用 rustfmt 默认配置即可 |
| P3-5 | 无 `type:"module"` | 用 `.mjs` 后缀规避，能正常工作 |
| P3-6 | `csp: null` | Tauri 默认关闭，因全部资源来自内嵌 HTTP 服务器（`127.0.0.1`），风险有限；但若未来加载外部资源应补 CSP |
| P3-7 | 同一安装包在 3 处出现 | 为覆盖"找不到 exe"的用户诉求而刻意为之，已在发布说明中标注位置 |

---

## 4. 明确"必须修复"清单

如果你只做 6 件事，按这个顺序：

1. **新建 `README.md`** —— 写明系统要求、前置条件、开发与发布命令（P0-1）
2. **新建 `.gitignore`** —— 隔离 `node_modules/`、`target/`、`dist/`、`release/`、`*.exe`、`*.msi`（P0-2）
3. **在 README 与发布说明中标注「Win10 1809+ / ARM64 需仿真 / 安装需联网」**（P0-3）
4. **决定 WebView2 分发策略** —— 若有内网用户，补一个 `offlineInstaller` 版本；否则明确告知需联网（P0-4）
5. **配置 `updateUrl` 指向发布服务器**，否则"检查更新"对真实用户无效（P1-1）
6. **`nsis.languages` 加 `English` 并开启语言选择器**（P1-3）

---

## 5. 附：审计证据来源

| 结论 | 证据文件 |
|---|---|
| 项目结构、配置文件存在性、依赖清单 | `.workbuddy/audit-structure.txt` |
| npm/Rust 依赖明细、`index.html` 加载顺序、内联处理器清单 | `.workbuddy/audit-deps.txt` |
| 环境矩阵、全局作用域、区域编码 | `.workbuddy/audit-sandbox.txt` |
| 死代码、预缓存一致性、结构差异判定 | `.workbuddy/audit-sandbox2.txt` |
| 真实浏览器门槛 | `.workbuddy/audit-sandbox3.txt`、`.workbuddy/audit-browser.txt` |
| PE 头、MSI 元数据、安装包体积 | `.workbuddy/audit-artifacts.txt` |
| NSIS 卸载器模板原文 | `.workbuddy/nsis-candidates.txt` |
| Tauri 官方 NSIS 语言/安装模式 schema | `.workbuddy/schema-check.txt`、`.workbuddy/pe-check.txt` |

复现方式：`node .workbuddy/audit-scan.mjs && node .workbuddy/audit-deps.mjs && node .workbuddy/audit-sandbox2.mjs && node .workbuddy/audit-sandbox3.mjs`
