# PromptForge 提示词工坊

把一句模糊的想法，变成结构清晰、可直接使用的高质量提示词。支持**在线 API** 与**本地离线模型**两种引擎，可装成桌面应用或 PWA 使用。

支持 **7 种框架 / 29 个模板 / 11 个场景分类**，覆盖文案、代码、数据、学术、商业等文本场景，以及**图像生成、配音语音、视频生成、音乐生成**四个多模态场景。

---

## 系统要求

| 项 | 要求 |
|---|---|
| 操作系统 | **Windows 10 v1809（build 17763）及以上**；Windows 11 全版本 |
| 运行库 | **WebView2 Runtime**（Win11 与 Win10 22H2 通常已预装；旧系统安装时会联网下载） |
| 架构 | x64。ARM64 设备（Surface Pro X、骁龙笔记本）可用 x64 包通过仿真运行 |
| 浏览器（网页版） | Chrome / Edge 80+、Firefox 74+、Safari 13.1+ |

> ⚠️ **Windows 7 / 8.1 不支持。** Tauri 2 的最低要求是 Win10 1809，且 WebView2 已于 2024-01 停止支持 Win7/8.1。
>
> ⚠️ **安装过程需要联网**（用于获取 WebView2 Runtime）。内网/离线环境请先手动安装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)，或改用离线安装包。
>
> ⚠️ **网页版不支持的浏览器**：IE 11、老版 Edge，以及 360/QQ 浏览器的「兼容模式」（IE 内核）——这些环境会白屏，请切到「极速模式」或换用 Chrome / Edge。

---

## 快速开始（使用者）

### 桌面版（推荐）

1. 在项目根目录找到 **`Latest-Setup.exe`**（文件名以 L 开头，在资源管理器中排在前面）
2. 双击安装。装完后：
   - 桌面会出现 **PromptForge** 快捷方式
   - 开始菜单 → **PromptForge** 文件夹下有入口
   - 主程序默认位于 `%LOCALAPPDATA%\PromptForge\promptforge.exe`
3. 打开软件 → 侧边栏「设置」→ 填写 API 地址与 Key，或切换到「离线模式」

> 想定位主程序：设置页 →「安装位置」→ 点「打开安装目录」。
> 想卸载：设置页**最底部**的「卸载应用」（安装向导里不再提供卸载入口）。

### 网页版

用 Chrome / Edge 打开部署好的地址即可，无需安装。
点击侧边栏「下载桌面版」**直接开始下载安装包**，无需任何选择或二次确认；安装包固定为 `Latest-Setup.exe`（与 `index.html` 同目录）。
点击「安装应用」可装成 PWA（**需要 HTTPS 或 localhost**，`file://` 下浏览器不开放安装能力）。

> **`file://` 的现实与对策**
>
> 浏览器协议层面对 `file://` 页面有四道限制，且都来自「每个 `file://` 路径被视为独立 origin」这同一个根源：
>
> 1. `<a download>` 被静默忽略（下载按钮点了没反应）
> 2. `fetch('version.json')` 同源失败（检查更新拿到不到清单）
> 3. Service Worker 注册被拒（PWA 装不上）
> 4. `navigator.serviceWorker.register()` 不可用
>
> Custom URI Scheme（如 `promptforge://`）**无法绕过**这些限制 —— 它关联的是已安装的桌面程序，没解决「拿到安装包」这个鸡生蛋的问题。
>
> 解法是发布包里附带 `启动.bat` + `启动.ps1`，在 `127.0.0.1` 起一个本地静态服务。Windows 用户双击 `启动.bat`，浏览器自动打开 `http://127.0.0.1:14370/`，上面四件事全部恢复。
> 端口固定在 `14370..14390` 之间，避免重启后 `localStorage`/IndexedDB 因 origin 变化被清空。

> **双击使用：** 在发布的 `dist/` 目录下双击 `启动.bat`（Windows）或 `启动.ps1`（macOS/Linux/PowerShell 用户），即可启动本地服务。控制台窗口保持打开即可，关闭即停止服务。
> **命令行参数：** `-NoBrowser`（只起服务、不开浏览器）；`-Port 0`（自动选 14370..14390 中的可用端口，全占用则随机 40000..60000 并在窗口提示"设置会丢失"）。

---

## 快速开始（开发者）

```bash
# 环境：Node 18+、Rust 1.77.2+、Windows 上还需 MSVC 构建工具
npm install

# 前端资源同步到 dist/ 与 dist-app/（每次改动 js/ css/ index.html 后都要跑）
npm run sync:dist

# 开发模式
npm run tauri:dev

# 打包（含版本一致性预检 + 前端同步，自动写入 dist/version.json）
npm run tauri:build

# 完整发布：预检 → 构建 → 归档到 release/ → 同步 dist/ → 验证更新链路
npm run release

# 仅重新归档（复用已有的 bundle 产物，不重新编译 Rust）
npm run release:pack

# 只跑全部校验（版本一致性 + 前端 + 下载交互 + 更新链路）
npm run check:all
```

> **第一次跑 `npm run release` 会编译 Rust，约 10–12 分钟**（主要在 `aws-lc-sys` / cmake），
> 之后增量构建约 1 秒。中途不要重复触发，两次并发构建会互相抢 `target/` 锁。

### 改完代码一定要重新打包

**只改 `js/` `css/` `index.html` 而不重新构建，安装包与清单会停在旧版本**，客户端「检查更新」就会一直显示"最新版本"，网页端也会下到旧安装包——这是过去反复出现的问题。发版固定走一条命令：

```bash
npm run bump 0.2.1      # 1. 统一版本号
npm run release         # 2. 预检 + 构建 + 归档 + 同步 + 验证，一步到位
```

`npm run release` 串起了五个环节，任一环节失败都会中止：

| 步骤 | 脚本 | 作用 |
| --- | --- | --- |
| 预检 | `scripts/check-dist.mjs` | 版本号一致 + 分发物不陈旧 + 清单引用不 404 + `dist-app/` 干净 + **前端与源码同步（比 mtime）** + 安装包体积合理 |
| 构建 | `scripts/tauri-build.mjs` | 先 `cargo build --release`，再 `tauri bundle`，产出 NSIS / MSI |
| 归档 | `scripts/build-release.mjs` | 收拢到 `release/`，生成带 `windows` 的更新清单，清理旧包 |
| 同步 | `scripts/sync-dist.mjs` + `write-version.mjs` | 安装包与清单进 `dist/`，供网页端下载与客户端联网更新 |
| 验证 | `scripts/verify-update-chain.mjs` | 复刻客户端判定逻辑，确认旧版本上真的能看到更新提示 |

> **为什么构建要单独包一层 `tauri-build.mjs`**：直接跑 `tauri build` 在部分环境下会卡在
> `Looking up installed tauri packages...` 之后长时间无输出，进程还在但 `cargo`/`rustc` 全都不在——
> 即 CLI 到 cargo 的衔接偶发挂死。包装器把两步拆开，各自带超时与"无输出即判死"的看门狗，
> 并明确区分「编译慢」和「进程死了」；任何一步挂死都会立即失败退出，而不是无限期干等。
> 拆开后正常耗时：增量编译 ~2 秒，打包 ~16 秒。

也可以单独跑：

```bash
npm run check:dist      # 只做版本一致性预检
npm run check:all       # 全部校验（版本 + 前端 + 下载交互 + 更新链路）
npm run verify:update   # 只验证更新链路
```

### 两个输出目录，职责不能混（体积正确性的关键）

| 目录 | 内容 | 用途 |
| --- | --- | --- |
| `dist-app/` | **只有源码**（index.html / js / css / fonts / 图标 / `version.json`） | `tauri.conf.json` 的 `frontendDist` 指向它，被打进安装包 |
| `dist/` | 源码 + 安装包 + `web-update-*.json` | 对外部署；网页端「下载桌面版」的下载目标 |

> `dist-app/version.json` 是**装好的客户端自带的那份更新清单**，随安装包进入用户的安装目录。
> 客户端更新源解析的第 5 层就用它（见下文「让客户端能自动更新」），
> 这样即使发布者没填 `updateUrl`、用户也没放本地清单，客户端依然有可用的比对依据。

**为什么必须分开**：`frontendDist` 若指向 `dist/`，而 `dist/` 里放着安装包，
安装包就会把**自己**（以及另一个安装包、整个热更新包）打包进自身。实测同一份代码：

| `frontendDist` | 结果 |
| --- | --- |
| `../dist`（目录内含上一版自包含产物） | 安装包 **28.6 MB**（自嵌入），且**每发一版都会再胖一圈** |
| `../dist-app`（干净前端） | 安装包 **3.4 MB**，主程序 `promptforge.exe` **12.6 MB** |

体积随版本递增正是自嵌入的典型症状——正常发版安装包大小应该基本持平。

`check-dist.mjs` 会断言 `dist-app/` 不含 `.exe`/`.msi`，并检查安装包体积
**不大于未压缩主程序**（NSIS 用 LZMA，正常应明显更小；大于即说明打进了自包含产物）。

### 更新清单的字段约定

`release/version.json` 与 `dist/version.json` 都要满足客户端 `Manifest` 结构体的读取规则，否则「检查更新」会静默退化成"最新版本"：

| 字段 | 必须 | 说明 |
| --- | --- | --- |
| `version` | ✅ | 清单版本号，客户端与 `package_info().version` 比较 |
| `windows` / `app` | 建议 | 完整安装包，值为 `"文件名"` 或 `{file, size}`。**缺了它，程序本体落后时也不会提示更新** |
| `web` | 建议 | 前端热更新包，只有界面落后时走它（不退出软件） |
| `notes` | — | 更新说明，显示在更新弹窗里 |
| `service` | — | 内置在线服务配置，随清单下发，改地址不用发新版客户端 |
| `internalLatest` | — | 可选：内置分发源地址，用户没配更新源时兜底 |

`scripts/write-version.mjs` 会从 `release/version.json` 桥接这些字段到 `dist/`，并校验被引用的文件真实存在。

### 脚本加载顺序（改前端必读）

项目**不用打包器**，全部走经典 `<script src>`，依赖靠加载顺序保证：

1. `js/style-variants.js` **必须**在 `js/optimizer.js` 之前——`optimizer.js` 运行时会读全局 `StyleVariants`（缺失时回落到内置的五段式 `legacyRender`，不会报错但会丢掉版式多样性）
2. `js/optimizer.js` 必须在 `js/optimize-ui.js` 之前——后者依赖 `PromptOptimizer`
3. 新增 `js/` 文件时，除了在 `index.html` 里加标签，还要同步加进 **`sw.js` 的 `STATIC_CACHE_URLS`**，否则离线时该文件 404

顶层 `const` / `let` 不会自动挂到 `window` 上，需要跨文件访问的模块要自己写 `window.X = X`（见 `style-variants.js` 末尾）。

### 版本号维护

**`version.json`（根目录）是唯一事实源。** 不要手改其他文件里的版本号。

```bash
npm run bump 0.2.0    # 自动同步到 package.json / tauri.conf.json / Cargo.toml
```

`scripts/check-dist.mjs` 会在构建前校验四处版本号一致、`release/` 里没有旧版本安装包、清单引用的文件都存在，任一不符直接中止——防止用旧产物发布。

### 目录结构

```
├── index.html            # 单页入口（经典 script 顺序加载，无打包器）
├── js/                   # 共 17 个文件，加载顺序见 index.html
│   ├── frameworks.js     # 7 个框架定义（含 4 个多模态）+ 29 个模板 + API 预设
│   ├── storage.js        # localStorage 读写（loadSettings 带内存缓存）
│   ├── builtin-service.js# 内置在线服务（装好即用）
│   ├── unified-llm.js    # 统一调用层：自动分发 在线 / 离线
│   ├── offline-llm.js    # 本地推理（transformers.js）+ 模型清单唯一数据源
│   ├── device-detection.js # 设备能力探测与模型推荐
│   ├── offline-ui.js     # 离线模型界面（状态写入统一走 textContent）
│   ├── local-model.js    # 本地模型生命周期（元数据由 offline-llm 派生）
│   ├── style-variants.js # 离线版式变体引擎（6 种风格，纯逻辑，无 DOM）
│   ├── optimizer.js      # 提示词优化引擎（纯逻辑，无 DOM）
│   ├── optimize-ui.js    # 优化视图（含版式切换器）
│   ├── personalize.js    # 个性化设置
│   ├── pwa.js            # PWA 安装 / 卸载
│   ├── sync.js           # 云同步（WebDAV / 自建）
│   ├── export.js         # 导出 JSON / Markdown / PDF
│   ├── api.js            # 在线 API 调用
│   └── app.js            # 主流程与视图切换
├── css/style.css
├── src-tauri/            # Rust 后端（内嵌静态服务器 + 更新检测）
│   ├── src/lib.rs        # 11 个 #[tauri::command]
│   └── tauri.conf.json   # frontendDist 指向 dist-app（干净前端）
├── scripts/              # 构建、发布与验证脚本
│   ├── tauri-build.mjs   # 稳健版构建包装（cargo + bundle，带超时与看门狗）
│   ├── check-dist.mjs    # 构建前预检（版本一致性 / 前端新鲜度 / 体积）
│   ├── build-release.mjs # 归档到 release/ 并生成更新清单
│   ├── sync-dist.mjs     # 分发到 dist/ 与 dist-app/
│   ├── write-version.mjs # 桥接清单字段到 dist/version.json
│   └── verify-update-chain.mjs  # 复刻客户端判定逻辑做端到端校验
├── .workbuddy/           # 开发期校验脚本（不参与打包）
│   ├── _check-lib.mjs              # 共享库：vm 沙盒（极简 DOM）+ 断言 + 统一输出
│   ├── run-all-checks.mjs          # 统一跑全部套件（失败判定：退出码 或 行首 FAIL）
│   ├── check-frameworks.mjs        # 框架 / 模板定义完整性
│   ├── check-styles.mjs            # 6 种版式输出特征
│   ├── check-ui-wiring.mjs         # index.html 控件 id 与 JS 引用对应
│   ├── check-download-ux.mjs       # 下载安装包交互（多种部署环境真跑）
│   ├── check-update-chain.mjs      # 更新链路 + CI 顺序/注入的回归护栏
│   ├── check-model-metadata.mjs    # 模型清单唯一数据源
│   ├── check-model-derivation.mjs  # 沙盒真跑 17 个脚本，验证派生一致
│   ├── check-settings-cache.mjs    # 设置缓存命中 / 失效 / 副本隔离
│   └── check-xss-and-styles.mjs    # XSS 注入面 + 样式幂等注入
├── service.json          # 内置在线服务配置（enabled 后新装用户免配置）
├── version.json          # 版本单一事实源
├── dist-app/             # 打进安装包的干净前端（已 gitignore）
└── release/              # 发布产物（已 gitignore）
```

### 功能一览

#### 提示词框架

| 框架 | 适用场景 | 产出 |
|---|---|---|
| **CO-STAR** | 通用结构化写作 | 背景 / 目标 / 风格 / 语气 / 受众 / 输出 |
| **CREATE** | 内容创作 | 角色 / 需求 / 示例 / 调整 / 类型 / 期望 |
| **BROKE** | 复杂问题拆解 | 背景 / 角色 / 目标 / 关键结果 / 演进 |
| **image** | 图像生成 | 主体 / 构图 / 镜头 / 光线 / 风格 / 画质 |
| **voice** | 配音 / 语音合成 | 文本 / 音色 / 语速 / 情绪 / 停顿 / 格式 |
| **video** | 视频生成 | 分镜 / 运镜 / 时长 / 转场 / 节奏 / 风格 |
| **music** | 音乐生成 | 风格 / 乐器 / BPM / 调性 / 结构 / 情绪 |

> 多模态框架产出的是**给生成模型用的提示词**，不直接调用任何生成 API。
> 框架内会保留该领域的惯用术语（镜头语言、音色词、BPM 等），风格与技术关键词按惯例保留英文，便于直接粘贴到 Midjourney / Suno / Runway 等工具。

#### 离线样式变体

不配置任何大模型时，本地规则引擎也能产出**6 种截然不同的版式**，不再千篇一律：

| 风格 | 排布方式 | 适合 |
|---|---|---|
| **标准分节** | `## 角色 / ## 背景 / ## 任务 / ## 约束 / ## 输出格式` | 正式交付、需要归档 |
| **极简指令** | 压缩成一段话，无标题 | 直接粘贴进对话框 |
| **角色扮演** | 第二人称对话式，「你现在的身份：…」 | persona、人格化场景 |
| **逐步引导** | 编号步骤 `1. **执行核心任务**` | 流程复杂、易漏项 |
| **带示例** | 关键要求后补「（例如：…）」 | 降低模型跑偏概率 |
| **清单核对** | Markdown 勾选框 `- [ ]` | 逐条确认与验收 |

**「自动挑选」** 会按输入特征选版式——先看用户显式表达的意图（有没有说「按步骤」、有没有给列表、有没有指定角色），再看篇幅与信息密度。同一段输入换风格会得到明显不同的排版，可在结果区顶部的胶囊按钮上直接切换对比。

版式只改变**怎么排布、用什么标记、详略程度**，不改变内容本身；关键信息在所有风格下都会保留。

#### 提示词优化

「提示词优化」视图支持两种引擎：

- **本地规则**：不联网、不消耗 token，五维体检（角色 / 上下文 / 任务 / 参数 / 输出格式）+ 自动补全 + 版式切换
- **AI 深度优化**：调用配置的模型重写，支持流式输出与随时中断

两种引擎都提供并排对比与逐行差异视图，可复制、替换原文（支持还原）、送去继续加工、保存到历史。

### 内置在线服务

若想让用户**装完就能用、无需自备 API Key**：

1. 自建一个受限的转发代理（**不要填主账号 Key**——前端配置对任何访客可见）
2. 编辑根目录 `service.json`：把 `enabled` 改为 `true`，填入 `endpoint` / `model` / `key`
3. 把它随构建一起发布（`sync-dist.mjs` 会同步进 `dist/`）

客户端启动时会从更新源同源位置拉取 `service.json`，本地缓存 6 小时。
用户自己填的 API 优先级高于内置服务。

### 让客户端能自动更新

整条链路只有两个东西必须放到服务器上，**放在同一个目录**即可：

```
https://你的站点/promptforge/
├── version.json                  ← 更新清单（客户端先读它）
├── PromptForge-0.2.0-Setup.exe   ← 完整安装包（清单里 windows.file 指向它）
└── web-update-0.2.0.json         ← 前端热更新包（清单里 web.file 指向它）
```

1. 跑一次 `npm run release`，产物全在 `release/` 下
2. 把 `release/` 里的文件上传到上面那个目录（`sync-dist.mjs` 已把同一份内容同步进 `dist/`，直接部署 `dist/` 也行；**不要部署 `dist-app/`**，它只是给安装包用的干净前端）
3. 在根 `version.json` 里把 `updateUrl` 填成该目录的可访问地址，重新跑 `npm run release`

> **`updateUrl` 留空也不会失效。** 客户端会按下面的顺序自动兜底，全程不需要用户干预：
>
> | 顺序 | 更新源 | 何时生效 |
> | --- | --- | --- |
> | 1 | 用户在「设置 → 软件更新源地址」填的地址 | 用户显式指定，最高优先级 |
> | 2 | 清单里的 `updateUrl` | 发布者填了公共分发地址 |
> | 3 | 清单里的 `internalLatest` | 环境变量注入的内置分发源 |
> | 4 | **本机部署地址**（`index.html` 运行时推导） | 客户端从自己所在的那份前端检测，便携部署开箱可用 |
> | 5 | **主程序目录下的 `version.json`** | 随安装包打进用户机器，`dist-app/version.json` |
> | 6 | `%LOCALAPPDATA%\PromptForge\Updates\version.json` | 离线手工投放 |
>
> 第 4、5 层是 2026-09 新增的：此前更新只剩「手填地址」和「手工放清单」两条路，
> 两者都要用户记得做点什么，于是「发布新版后旧客户端永远显示最新版本」反复出现。
> 现在客户端**自己就能描述自己的更新源**，第 4、5 层在绝大多数部署下已经够用。

两种可选注入方式：

```bash
# 方式 A：直接写进 version.json（简单，但会进 git）
#   把根目录 version.json 的 updateUrl 改成 https://你的站点/promptforge/

# 方式 B：构建时用环境变量注入（不入 git，适合换机器/换域名发布）
RELEASE_INTERNAL_LATEST=https://你的站点/promptforge/ npm run release
#   或覆盖 updateUrl（只影响本次发布，不改根 version.json）
RELEASE_UPDATE_URL=https://你的站点/promptforge/ npm run release
```

方式 B 会往清单里写一段 `internalLatest`，客户端在「用户没配更新源」时用它兜底：
用户侧的设置项仍然优先，不会被覆盖。

设置好后可在软件「设置 → 软件更新源地址」里覆盖，并点「测试连接」验证。
「帮助 → 软件更新」页会显示**当前实际生效的更新源**（用户地址 / 内置分发源 / 主程序目录 / 前端资源目录 / 本地文件夹 / 未配置）**及探测到的清单版本号**，
方便区分"真最新"和"没找到清单"。

> **不会再谎报"最新版本"了。** 过去"清单不完整"（如清单里有更高版本号却缺 `windows` 字段）
> 会静默退化成"已是最新"，用户反复点检查更新却升不上去。现在这类情况会**直接报出具体原因**
> （哪个字段缺了、清单上是哪个版本），而不是显示"最新版本"。

验证链路是否真的通了：

```bash
npm run verify:update    # 复刻客户端判定逻辑，模拟旧版本上检查更新
```

---

## 已知限制

| 限制 | 说明 |
|---|---|
| Win7 / Win8.1 | 不支持（Tauri 2 要求 Win10 1809+） |
| ARM64 设备 | 无原生包，走 x64 仿真 |
| 内网 / 离线设备 | 安装阶段需联网获取 WebView2 Runtime |
| IE 内核浏览器 | 网页版白屏 |
| 首次编译 | 约 10–12 分钟（主要在 `aws-lc-sys` / cmake）；之后增量约 1 秒 |

---

## 许可

ISC
