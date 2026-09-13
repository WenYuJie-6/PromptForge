# 代码审查报告（2026-09-13）

审查范围：2026-09-12 晚间提交 `bd399da`（GitHub Pages 部署工作流 + 「安装应用」菜单移除 + 「下载桌面版」改绝对 https）。
审查方式：逐文件实读 + 沙盒实证（含临时移走 `dist-app/` 复现编译失败、复刻 CI 注入脚本、核对清单字段）。

---

## 一、阻断级问题（必修，否则 CI 必红）

### P0-1　CI 首次构建必然失败：`cargo build` 依赖 `dist-app/`，而它不在版本控制里

**证据链（已实证）**
1. `git check-ignore -v dist-app/` → `.gitignore:9:dist-app/`，且 `git ls-files dist-app` = **0 个文件**。
2. 临时移走 `dist-app/` 后跑 `cargo check` → **exit 101**：
   ```
   src\lib.rs:20:17: error: proc macro panicked
   error: could not compile `promptforge` (lib)
   ```
3. `scripts/tauri-build.mjs` 第 1 步直接调 `cargo build --release`（`spawnSync`），
   **不会触发** `beforeBuildCommand`（那是 `tauri` CLI 的行为，`cargo` 不认）。
4. `tauri.conf.json` 的 `frontendDist = ../dist-app`，`build.rs` 的 `tauri_build::build()`
   在**编译期**就要读该目录。

**结论**：CI runner 全新 checkout 后没有 `dist-app/` → `node scripts/tauri-build.mjs` 第 1 步即崩。
工作流第 4 步就是它，所以**第一次跑 CI 必定失败**。

**修法（任选，推荐 A）**
- **A. 在 CI 里显式先跑一次 sync**：把 `tauri-build.mjs` 之前插入一步
  ```yaml
  - name: Prepare frontend (dist-app)
    run: npm run sync:dist
  ```
  这样 `dist-app/` 与 `dist/version.json` 都就位，`cargo build` 才可能成功。
  注意此时 `release/version.json` 尚不存在，`write-version` 会降级为「无 windows 字段」——这是
  P0-2 要处理的事，两者需一起修。
- **B. 改 `tauri-build.mjs`**：在 `cargo build` 前自行调一次 `sync-dist.mjs`。
  不推荐——会让这个"纯构建包装器"多一层职责，且本地开发者跑它时会意外清空 `dist-app/`。

**附带**：即便修好顺序，`dist/` 在 CI 里是从零生成，`check:dist.mjs` 的「release/ 无旧版本安装包」
等断言在首次运行时可能命中空目录。当前工作流**根本没调 `check:dist`**（见 P1-3），所以不阻断，
但也意味着**没有任何预检**。

---

### P0-2　安装包里内嵌的清单永远缺 `windows` 字段，更新能力存在单点依赖

**时序（已按脚本逻辑推演）**
| 步骤 | 动作 | `dist-app/version.json` 内容 |
|---|---|---|
| ① | `cargo build` | 不跑 `beforeBuildCommand` |
| ② | `tauri bundle` | 跑 `beforeBuildCommand` → `sync:dist`：写 `{version, notes, updateUrl}`，**无 windows** |
| ③ | `build-release.mjs` | 产出 `release/version.json`（**含 windows**）+ 安装包 |
| ④ | `npm run sync:dist` | 重写 `dist/version.json`（**含 windows**）；`dist-app/` 那份仍是**无 windows** |

②那份被 `frontendDist` 打进安装包 → **客户端从自己安装目录读到的清单永远没有 `windows`/`web`**。

**后果**：客户端要拿到安装包，只能靠第 4/6 层兜底中的 `updateUrl` 联网。CI 里 `updateUrl` 已注入，
所以**联网时可行**；但一旦断网 / `updateUrl` 失效 / 用户手填了错误地址，客户端就退化为
「已是最新版本」——正是本项目反复出现的那类故障的翻版。

**修法**：把 `build-release.mjs` 挪到 `tauri bundle` **之前**不可行（安装包要等 bundle），
真正干净的做法是**让 `dist-app/version.json` 也带 `windows`**：
在 `sync-dist.mjs` 写 `distApp/version.json` 时，若 `release/version.json` 已存在且版本一致，
一并桥接 `windows`/`web`（复用 `write-version.mjs` 的 `present()` 逻辑）；
或在工作流最后一步把 `dist/version.json` 复制成 `dist-app/version.json` 后**重新 bundle 一次**（成本高，不推荐）。
**建议**：在 `sync-dist.mjs` 的 `appManifest` 组装处补桥接，并在 `verify-update-chain.mjs`
里加一条断言「`dist-app/version.json` 在 release/ 存在时必须带 windows」。

---

## 二、高优先级问题

### P1-1　**9 个校验脚本整体丢失，`check:all` 实际已空转**

**实测**：`package.json` 的 `check:all` 引用了 10 个 `.workbuddy/*.mjs`，其中 **9 个不存在**：

| 引用 | 状态 |
|---|---|
| `check-frameworks.mjs` | 缺失 |
| `check-styles.mjs` | 缺失 |
| `check-ui-wiring.mjs` | 缺失 |
| `check-download-ux.mjs` | 缺失 |
| `check-update-chain.mjs` | 缺失 |
| `check-model-metadata.mjs` | 缺失 |
| `check-model-derivation.mjs` | 缺失 |
| `check-settings-cache.mjs` | 缺失 |
| `check-xss-and-styles.mjs` | 缺失 |
| `run-all-checks.mjs` | 存在（空壳） |

全盘搜索（排除 node_modules/.git）**零命中**；回收站**无备份**。即 `npm run check:all` 会在第一个
缺失脚本处 `MODULE_NOT_FOUND` 退出，**19 个套件的防护网实际归零**。

**根因**：`.gitignore` 第 18 行 `.workbuddy/` 把整个目录排除。该目录同时容纳：
- 校验脚本（**应进版本控制**）
- `memory/`（本地工作日志，**应排除**）
- `verify-update-chain.txt` 等临时输出（**应排除**）

一条粗粒度规则把两类文件一起忽略了，于是脚本既没进 git、也没被任何备份覆盖，删除后无从追溯。

**修法**
1. 把 `.workbuddy/` 规则改为白名单式：
   ```gitignore
   .workbuddy/*
   !.workbuddy/*.mjs
   !.workbuddy/*.ps1
   !.workbuddy/*.js
   ```
   （或干脆把校验脚本迁到 `scripts/checks/`，与 `.workbuddy/` 这个"工具私有目录"解耦——**推荐**。）
2. 重写这 9 个脚本（内容可从 `.workbuddy/memory/` 各轮日志里恢复断言清单：
   `check-frameworks` 62 项、`check-styles`/`check-ui-wiring`/`check-download-ux` 28 项、
   `check-update-chain` 26 项、`check-model-metadata` 17 项、`check-model-derivation` 8 项、
   `check-settings-cache` 15 项、`check-xss-and-styles` 13 项）。
3. **立刻把脚本纳入版本控制并提交**，这是防止再次静默丢失的唯一手段。

---

### P1-2　CI 完全不跑校验，回归无法被拦截

工作流只有 `checkout → 注入 URL → npm install → 构建 → 发布`，**没有 `check:dist`、没有 `verify:update`、
没有任何 lint/测试**。所以：P0-1 这类"本地能过、CI 必挂"的问题只能在 CI 红了之后才发现；
前端改动即便引入 XSS/作用域 bug，也无人拦。

**修法**：在 `npm install` 之后、`tauri-build.mjs` 之前插入
```yaml
- name: Preflight checks
  run: |
    node scripts/check-dist.mjs
    node scripts/fix-ps-encoding.mjs --check assets-templates/启动.ps1 assets-templates/启动.bat
```
并在部署前加 `node scripts/verify-update-chain.mjs`（修好 P1-1 后可再加 `check:all:runner`）。
注意 `verify-update-chain.mjs` 会往 `.workbuddy/` 写 txt（第 232 行），CI 上该目录不存在 →
**需先在脚本里 `mkdirSync` 兜底**，否则 CI 报错。这一条要一并改。

---

### P1-3　CI 地址注入有两处脆弱点

`.github/workflows/deploy.yml` 第 56-61 行：
```yaml
shell: bash
run: |
  repo_lc=$(echo "${{ github.event.repository.name }}" | tr '[:upper:]' '[:lower:]')
  url="https://${{ github.repository_owner }}.github.io/${repo_lc}/"
  node -e '...' "$url"
```

**风险 1**：`github.event.repository.name` 在 `push` 下存在，但 **`workflow_dispatch` 下可能为空**
（`event` 载荷不同），`repo_lc` 会变成空串 → URL 变成 `https://user.github.io//`，**静默写入错误地址**。
**修法**：改用 `${{ github.event.repository.name || github.repository }}`，
或直接 `$GITHUB_REPOSITORY` 环境变量取 `owner/repo` 再切分，更可靠。

**风险 2**：`node -e '...' "$url"` 在 Windows runner 的 Git Bash 下，`-e` 后的脚本含双引号 +
`$url` 含 `://`，引号转义链脆弱（我已实测过一次因转义问题直接 SyntaxError）。
**修法**：把注入逻辑抽成 `scripts/inject-pages-url.mjs`，CI 里只写
`node scripts/inject-pages-url.mjs "$url"`，彻底消除引号地狱。

**风险 3（次要）**：`tauri.conf.json` 的 `productName`/`identifier` 若含大写而仓库名转小写，
Pages 路径大小写敏感会导致 404。当前 `github.io/<repo_lc>/` 已做了 lower-case 处理，
但**部署产物真实路径由仓库名决定**——若仓库名本身含大写，这里会与 Pages 实际路径不一致。
建议直接**用仓库名原名**（GitHub Pages 对 `owner.github.io/repo/` 的大小写按仓库名原样）。
→ 即 `repo_lc` 这一步"转小写"可能是**多余的、且会引入 bug 的**，建议去掉，直接用原名。

---

## 三、中低优先级问题

### P2-1　`js/pwa.js` 残留死代码：`checkInstallAvailability()`

第 315-317 行仍调 `showInstallButton()`，会动态创建一个浮动「安装到桌面」按钮 append 到 `document.body`
——正是昨晚想关掉的那个浮窗。**幸运的是** `checkInstallAvailability` 虽有导出（第 410 行），
但**全项目无任何外部调用点**，所以实际不会触发，是**死代码**而非功能 bug。
**建议**：连同 `showInstallButton()` / `hideInstallButton()` / `installButton` 状态一起清理，
或至少加注释标明"已废弃，保留供 PWA 二次集成"。

### P2-2　`js/app.js` 第 1619 行注释过时

> `安装包固定为 Latest-Setup.exe（与 index.html 同目录），由 sync-dist 同步进 dist/。`

昨晚已改为「用部署基址拼绝对 https」，注释未同步。**建议**改为：
> 安装包固定为 `Latest-Setup.exe`，下载地址 = `更新源/部署基址 + /Latest-Setup.exe`。

### P2-3　`downloadDesktopInstaller` 的 base 兜底顺序可优化（低风险）

```js
let base = getUpdateBaseUrl() || window.PF_DEPLOY_BASE || '';
if (!base) base = await resolveUpdateBaseUrl();
```
- `getUpdateBaseUrl()` 是**同步**读设置，快；`PF_DEPLOY_BASE` 同步；只有最后一步 `await` 联网读清单。
  这个顺序是对的（先快后慢）。
- 但 `resolveUpdateBaseUrl()` 内部会 `fetch('version.json')`，**在 `file://` 下必然抛异常被吞**。
  由于 `file://` 分支在下方提前 `return`，这段 `await` 在 `file://` 下**仍会先执行**（因为它在 `if (location.protocol === 'file:')` 之前）。
  → 白白浪费一次失败的 fetch（几十毫秒，被 catch 吞掉，无功能影响，但**语义上不该在 file:// 下联网**）。
  **建议**：把 `if (location.protocol === 'file:')` 判断提到最前（早于 base 计算），
  或给 base 计算加 `location.protocol !== 'file:'` 短路。

### P2-4　`dist/`「下载桌面版」在 Pages 子路径下的一个隐性依赖

`PF_DEPLOY_BASE` 由 `location.origin + pathname` 推导，Pages 项目站点形如
`https://user.github.io/promptforge/`，推导结果 `https://user.github.io/promptforge`（已去尾斜杠），
拼出 `https://user.github.io/promptforge/Latest-Setup.exe` —— **正确**。
但若将来用**自定义域名**或 `<user>.github.io` **根站点**，`pathname` 为 `/`，结果 `https://user.github.io`，
依然正确。此项**无 bug，仅记录**。

### P2-5　`aws-lc-sys` 在 CI 上不需要 NASM（**修正此前认知**）

此前记忆里记着「CI 可能需要 NASM/Perl」。**本次实测推翻**：
- 本机 `where nasm/perl/cmake` **全部找不到**；
- 但 `src-tauri/target/release/build/aws-lc-sys-*/out` 下有**大量 `.o` 产出**（如 `a_bool.o`、`asn1_lib.o`）；
- 说明该版本 `aws-lc-sys` 在无 NASM 时**自动回退纯 C 实现**。

**结论**：CI 的 Windows runner **不需要额外安装 NASM**。但首次编译会**很慢**（纯 C 编译，
本机实测 10-12 分钟）——建议给 CI 加 cargo 缓存（工作流第 41-48 行**已有缓存**，good）。
唯一需留意：`actions/cache` 对 `src-tauri/target` 的缓存体积较大，首次运行会较慢。

---

## 四、发布到 GitHub 是否会影响昨晚的修改

**结论：不影响代码逻辑，但会让昨晚改动的"验证"打折扣，且当前状态下 CI 必挂。**

| 昨晚改动 | 发布到 GitHub 的影响 |
|---|---|
| 「下载桌面版」改绝对 https | **正向**：Pages 上 `PF_DEPLOY_BASE` 推导出正确绝对地址，改动**只有在发布后才真正生效**（本地 `file://` 下反而用不到） |
| 移除「安装应用」菜单 | 无关，纯前端，正常随构建发布 |
| `updateUrl` 注入 | **依赖 CI 注入成功**；若 P1-3 的空值/转义问题命中，会静默写入错误地址，导致更新失效 |
| `dist-app` 打包内容 | **P0-1/P0-2 会让"发布出来的安装包"要么构建失败、要么清单缺 windows** |

**另需注意**：`.gitignore` 排除了 `dist/`、`dist-app/`、`release/`、`Latest-*.exe`——这是对的，
但**意味着 CI 必须自己完整构建**，不存在"把本地产物推上去"的捷径。这与 P0-1 叠加：
CI 一旦缺前置产物就彻底失败。

---

## 五、修复优先级与建议动作

| 优先级 | 问题 | 动作 |
|---|---|---|
| **P0-1** | CI 缺 `dist-app/` 致 cargo 编译失败 | CI 里 `tauri-build.mjs` 前插 `npm run sync:dist` |
| **P0-2** | 安装包内清单缺 `windows` | `sync-dist.mjs` 补 `dist-app/version.json` 的 windows 桥接 |
| **P1-1** | 9 个校验脚本丢失 | 从版本控制层面白名单化 + 重写脚本 + 立即提交 |
| **P1-2** | CI 无校验 | 插入 `check-dist` / `verify-update`；给 verify 脚本加 mkdir 兜底 |
| **P1-3** | 注入 URL 脆弱 | 抽成独立脚本；`workflow_dispatch` 兜底；去掉多余的转小写 |
| **P2-1** | pwa.js 死代码 | 清理 `checkInstallAvailability`/`showInstallButton` |
| **P2-2** | app.js 注释过时 | 同步注释 |
| **P2-3** | file:// 下多余 fetch | base 计算加协议短路 |

---

## 六、后续验证与测试要点

**CI 首跑前（本地预演）**
1. 模拟全新 checkout：临时移走 `dist-app/` + `dist/` + `release/`，跑
   `node scripts/tauri-build.mjs`，**必须复现失败**（证明 P0-1 真实），修完后再跑**必须成功**。
2. 模拟注入：`node scripts/inject-pages-url.mjs "https://x.github.io/y/"` 后检查
   `version.json`、`dist/version.json`、`dist-app/version.json` 三份的 `updateUrl` 是否一致非空。

**CI 首跑后（冒烟）**
3. 访问 `https://<user>.github.io/<repo>/version.json`，确认含 `windows`/`web`/`updateUrl` 三字段，
   且 `windows.file` 指向的文件可 200 下载。
4. 访问 `https://<user>.github.io/<repo>/Latest-Setup.exe`，确认返回 200 且是真实安装包（非 404 页面）。
5. 下载 `启动.bat`，双击，确认 `http://127.0.0.1:14370/` 可打开且「下载桌面版」可用（验证 BOM 未丢）。

**更新链路（最关键）**
6. 装一个**旧版本**客户端（或用 `check_update` 的假当前版本），确认点「检查更新」能发现新版本
   ——这是 P0-2 修复效果的**唯一验收标准**。
7. 断网场景：确认在无 `updateUrl` 情形下，客户端至少能报出**可诊断的原因**，而非"已是最新版本"。

**回归（修完 P1-1 后）**
8. `npm run check:all:runner` 全绿；`node scripts/verify-update-chain.mjs` 24+ 项通过。
9. 前端手工冒烟：侧边栏只剩「下载桌面版」（无「安装应用」）、点下载确实触发文件下载、
   悬浮「安装到桌面」按钮**不再出现**。

---

# 二、修复与验证记录（同日完成）

## 1. P1-1：9 个校验脚本已重建

新增共享库 `.workbuddy/_check-lib.mjs`：用 `node:vm` 复刻浏览器经典脚本环境
（极简 DOM 含 `innerHTML` 解析、localStorage、定时器），并提供统一断言与输出。

| 脚本 | 校验目标 | 输入 | 断言数 |
|---|---|---|---|
| `check-frameworks.mjs` | 7 框架 / 29 模板 / 11 分类定义完整；`buildPrompt` 四种入参不崩、不丢内容 | `js/frameworks.js`（沙盒执行） | **126** |
| `check-styles.mjs` | 6 种版式 × 2 语言的特征可辨识 + 内容不丢；空输入→空串、未知版式/语言回退 | `js/style-variants.js`（沙盒执行） | **60** |
| `check-ui-wiring.mjs` | `<script>` 顺序、`sw.js` 缓存清单一致、内联事件函数有定义、`getElementById` 无幽灵引用 | `index.html` / `js/*` / `sw.js` / `manifest.json` | **38** |
| `check-download-ux.mjs` | 真跑 `downloadDesktopInstaller()`：一键直下、地址推导 4 种、404 提示、`file://` 说明、桌面版拒绝 | `js/*`（沙盒执行，拦截 `toast`/`askDialog`/`<a>`） | **31** |
| `check-update-chain.mjs` | Rust 不静默退化、清单字段齐全、多来源清单、离线模型解耦、CI 顺序与注入方式 | `lib.rs` / `index.html` / `app.js` / `version.json` / `scripts/*` / `deploy.yml` | **55** |
| `check-model-metadata.mjs` | 唯一数据源结构、短键不分叉、`resolveModel` 行为、三处模型名对齐 | `js/offline-llm.js`（沙盒）+ `js/*`（静态） | **54** |
| `check-model-derivation.mjs` | 沙盒真跑 17 个脚本（整站冒烟）+ 派生结果逐字段一致 | `js/*` 全部 | **27** |
| `check-settings-cache.mjs` | 缓存三条纪律（写入即失效 / 返回副本 / 显式失效）+ 损坏容错 + 容量截断 | `js/storage.js`（沙盒执行） | **25** |
| `check-xss-and-styles.mjs` | 载荷不进 `innerHTML`、错误路径走 `textContent`、`injectStyleOnce` 幂等（含**校验器自检**） | `js/*` + `offline-ui.js` / `pwa.js`（沙盒） | **26** |

**合计 442 项断言**，`run-all-checks.mjs` 全绿；`check:all` 末尾两环（`fix-ps-encoding --check`、
`_selftest-launcher.ps1` 真机 HttpListener 22 项）也全过。

### 交付约定（每个脚本的文件头都写明）
- 通过 → `  ✓ <说明>`；失败 → `FAIL  <说明>`（**必须顶格**，runner 用 `/^\s*(FAIL|✗)\b/` 统计，
  `✗ ` 后接空格不匹配，故统一用 `FAIL` 前缀，让退出码与正则两道判定都生效）；
- 汇总 → `>>> <套件名>: N PASS / M FAIL`；退出码 → 有失败即 1。

### 顺带修掉的真实缺陷（由新断言发现）
- `style-variants.js` 的 `getStyles()` 只做了浅拷贝（`STYLES.slice()`），元素仍是共享引用，
  调用方 `getStyles()[0].zh = x` 会污染全局元数据 → 改为拷贝元素对象。

## 2. P0-1 验证（本机模拟全新 checkout）

| 步骤 | 命令 | 结果 |
|---|---|---|
| 移走 `dist-app/`（模拟全新 checkout） | — | `cargo build --release` → **exit 101**<br>`error: proc macro panicked`<br>`The frontendDist configuration is set to "../dist-app" but this path doesn't exist` |
| 执行 CI 的前置步骤 | `node scripts/sync-dist.mjs` | exit 0，`dist-app/` 重建 |
| 再次编译 | `cargo build --release` | **exit 0** ✅ |

**结论：P0-1 已修复。** CI 中 `sync:dist` 必须且确实早于 `tauri-build`。

## 3. P0-2 验证（并补了一处真修复）

**验证过程发现原修复不彻底**：`dist-app/` 的资源是在 **cargo 编译期**被嵌进二进制的，
安装包内嵌的清单取决于 `cargo build` **那一刻**磁盘上的 `dist-app/version.json`。
而 CI 首次构建时 `release/version.json` 还不存在 → 那一刻的清单仍是**没有 windows** 的。

**补的修复**：`sync-dist.mjs` 增加「约定名兜底」——
`release/` 清单拿不到时，按命名约定补上
`windows = PromptForge-<v>-Setup.exe`、`web = web-update-<v>.json`
（与 `build-release.mjs` 的约定一致，`check-update-chain.mjs` 有断言锁死两者不漂移）。

**验证**（`release/` 已移走，等同全新 checkout）：

```
version.json            updateUrl=''（仓库里保持为空，CI 构建时才注入）
dist-app/version.json   updateUrl='https://ci-test.github.io/promptforge/'
                        windows='PromptForge-0.2.0-Setup.exe'  web='web-update-0.2.0.json'
```

即：**编译期那份清单已经是完整的**。随后 `build-release` → `sync:dist` → `verify-update-chain` 全绿。

## 4. 护栏有效性验证（负向测试）

「断言通过」不等于「断言有用」。故意注入缺陷，确认能被拦住：

| 注入的缺陷 | 预期 | 实测 |
|---|---|---|
| 删掉 CI 里 `sync:dist` 前置步骤（还原 P0-1 坏写法） | 报错 | ✅ 2 条 FAIL 命中（P0-1 顺序护栏） |
| 删掉 `sync-dist` 的约定名兜底两行（还原 P0-2） | 报错 | ⚠️ **第一次没拦住** → 断言过弱（`PromptForge-${V}-Setup.exe` 在 `deployItems` 里也出现，正则命中他处）；改为精确匹配兜底语句后 ✅ 命中 |

第二项正是负向测试的价值所在：它把一个**恒真的假断言**变成了真断言。

## 5. 遗留

- **GitHub 鉴权**：仍阻塞（需用户提供 PAT，或本地 `gh repo create`）。CI 逻辑已在本机
  按顺序完整模拟通过，但**尚未在真实 runner 上跑过**（Windows runner 的 Rust 首次编译
  约 10–12 分钟，`aws-lc-sys` 无需 NASM，已实测确认）。
- `dist-app/version.json` 的 `windows` 兜底项不带 `size`（发布前 release/ 尚未产出）。
  可用，只是前端不显示体积；真实发布包里的 `release/version.json` 带 size。
