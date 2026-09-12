// 稳健版的 tauri build 包装器。
//
// 为什么需要它：直接跑 `tauri build`（或 `tauri build --no-bundle`）在部分环境下会
// 卡在 "Looking up installed tauri packages..." 之后长时间无输出，进程仍在但 cargo/rustc
// 全部不存在——即 CLI 到 cargo 的衔接偶发挂死。这里拆成两步、分别带超时与存活检测：
//
//   1) cargo build --release   产出主程序（可独立验证是否真的在编译）
//   2) tauri bundle            只做 NSIS / MSI 打包（秒级）
//
// 好处：任何一步挂死都能被超时拦住，且能明确区分「编译慢」与「进程死了」。
// 用法：node scripts/tauri-build.mjs [--no-bundle]
import { spawnSync, spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, statSync, readdirSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcTauri = resolve(root, 'src-tauri');
const noBundle = process.argv.includes('--no-bundle');
const CARGO_TIMEOUT_MS = 30 * 60 * 1000; // 首次编译含 aws-lc-sys/cmake，给足 30 分钟

function hr(title) {
  console.log('\n[tauri-build] ' + title);
}

// ---- 步骤 1：cargo build --release ----
hr('步骤 1/2：cargo build --release');
const t0 = Date.now();
const cargo = spawnSync('cargo', ['build', '--release'], {
  cwd: srcTauri,
  encoding: 'utf8',
  shell: true,
  timeout: CARGO_TIMEOUT_MS,
});
const cargoSec = ((Date.now() - t0) / 1000).toFixed(1);

if (cargo.error && cargo.error.code === 'ETIMEDOUT') {
  console.error(`[tauri-build] 中止：cargo build 超过 ${CARGO_TIMEOUT_MS / 60000} 分钟仍未结束。`);
  process.exit(1);
}
if (cargo.status !== 0) {
  console.error('[tauri-build] 中止：cargo build 失败。');
  const out = ((cargo.stdout || '') + (cargo.stderr || ''))
    .split('\n')
    .filter((l) => !/shell-runtime-bash-env|dirname: command not found/.test(l))
    .slice(-40)
    .join('\n');
  if (out.trim()) console.error(out);
  process.exit(cargo.status || 1);
}

const mainExe = resolve(srcTauri, 'target/release/promptforge.exe');
if (!existsSync(mainExe)) {
  console.error('[tauri-build] 中止：cargo 返回成功但找不到 ' + mainExe);
  process.exit(1);
}
hr(`cargo 完成（${cargoSec}s），主程序 ${(statSync(mainExe).size / 1048576).toFixed(1)} MB`);

if (noBundle) {
  hr('已指定 --no-bundle，跳过打包。');
  process.exit(0);
}

// ---- 步骤 2：tauri bundle ----
// 用 spawn + 定时存活检测替代 spawnSync：CLI 偶发挂死时能主动杀掉而不是干等。
hr('步骤 2/2：tauri bundle（NSIS + MSI）');
const cli = resolve(root, 'node_modules/@tauri-apps/cli/tauri.js');
if (!existsSync(cli)) {
  console.error('[tauri-build] 中止：找不到 ' + cli + '，请先 npm install');
  process.exit(1);
}

const bundleT0 = Date.now();
const child = spawn(process.execPath, [cli, 'bundle'], { cwd: root });
let lastActivity = Date.now();
let tail = '';
child.stdout.on('data', (b) => { process.stdout.write(b); tail += b; lastActivity = Date.now(); });
child.stderr.on('data', (b) => {
  const s = b.toString();
  // 过滤环境的无关噪音（git-bash 缺 dirname）
  if (!/shell-runtime-bash-env|dirname: command not found/.test(s)) {
    process.stderr.write(s);
    tail += s;
  }
  lastActivity = Date.now();
});

// 每 30 秒检查一次：超过 5 分钟没有任何输出即视为挂死
const IDLE_LIMIT_MS = 5 * 60 * 1000;
const watchdog = setInterval(() => {
  const idle = Date.now() - lastActivity;
  if (idle > IDLE_LIMIT_MS) {
    console.error(
      `\n[tauri-build] 中止：tauri bundle 已 ${(idle / 1000).toFixed(0)} 秒无任何输出，判定为挂死。`
    );
    console.error('[tauri-build] 主程序已编译完成，可重跑 `node scripts/tauri-build.mjs` 或直接 `node scripts/build-release.mjs`。');
    child.kill();
    clearInterval(watchdog);
    process.exit(1);
  }
}, 30 * 1000);

child.on('exit', (code) => {
  clearInterval(watchdog);
  const sec = ((Date.now() - bundleT0) / 1000).toFixed(1);
  if (code !== 0) {
    console.error(`\n[tauri-build] 中止：tauri bundle 退出码 ${code}（${sec}s）`);
    process.exit(code || 1);
  }
  // 确认真的产出了两个包
  const nsis = resolve(srcTauri, 'target/release/bundle/nsis');
  const msi = resolve(srcTauri, 'target/release/bundle/msi');
  const nsisOk = existsSync(nsis) && readdirSync(nsis).some((f) => f.endsWith('.exe'));
  const msiOk = existsSync(msi) && readdirSync(msi).some((f) => f.endsWith('.msi'));
  hr(`bundle 完成（${sec}s）`);
  if (!nsisOk || !msiOk) {
    console.error(`[tauri-build] 中止：缺少产物（NSIS=${nsisOk} MSI=${msiOk}）`);
    process.exit(1);
  }
  console.log('[tauri-build] NSIS / MSI 均已产出。');
  process.exit(0);
});

child.on('error', (e) => {
  clearInterval(watchdog);
  console.error('[tauri-build] 中止：无法启动 tauri CLI — ' + e.message);
  process.exit(1);
});
