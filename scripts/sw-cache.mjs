// ============================================================
// scripts/sw-cache.mjs —— 让 sw.js 的缓存名跟随前端版本号（结构性 bust 缓存）
//
// 背景（真实发布缺陷）：
//   sw.js 对静态资源（STATIC_PATHS 及**所有** .js/.css）走「缓存优先」，而浏览器只在
//   sw.js **字节变化**时才重装 SW。于是「改了前端却不改 CACHE_NAME」会导致网页端 PWA
//   用户永远吃到旧缓存、拿不到新前端。既有规则只覆盖「删除 js 文件要 CACHE_NAME+1」，
//   没覆盖「修改前端」这一类 —— 人还得记得手改，迟早忘。
//
// 修复方式：把 CACHE_NAME / API_CACHE_NAME 与 webVersion 绑定，由 bump 脚本
//   （bump-version.mjs / bump-web-version.mjs）自动改写，使「改了前端却忘了 bust 缓存」
//   在**结构上**不可能发生 —— 不需要任何人再记得手工同步。
//
// 严格性：找不到目标行一律**抛错**，绝不静默跳过 ——「改不到却以为改了」正是本项目的头号坑。
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 精确匹配**赋值行**（限定 const NAME = 'promptforge-v…'; 的形状），
// 避免误改文件里其它形如 v1.2.1 的字样（如注释、日志文案）。
export const CACHE_LINE_RE = /(const CACHE_NAME\s*=\s*'promptforge-v)([^']*)(';)/;
export const API_CACHE_LINE_RE = /(const API_CACHE_NAME\s*=\s*'promptforge-api-v)([^']*)(';)/;

/**
 * 把 sw.js 里的 CACHE_NAME / API_CACHE_NAME 改写为 promptforge-v<version> /
 * promptforge-api-v<version>。
 *
 * @param {string} rootDir 仓库根目录（sw.js 所在目录）
 * @param {string} version 目标前端版本号（如 '0.2.3'），须为 x.y.z
 * @returns {{ changed: boolean, from: string, to: string, path: string }}
 * @throws 目标行匹配不到 / sw.js 不存在 / 版本号非法时抛错（拒绝静默跳过）
 */
export function syncSwCache(rootDir, version) {
  const ver = String(version == null ? '' : version).trim();
  if (!/^\d+\.\d+\.\d+$/.test(ver)) {
    throw new Error(`syncSwCache: 非法版本号 "${version}"（应为 x.y.z）`);
  }

  const swPath = resolve(rootDir, 'sw.js');
  let src;
  try {
    src = readFileSync(swPath, 'utf8');
  } catch {
    throw new Error(
      `syncSwCache: 找不到 ${swPath}，无法同步 CACHE_NAME。`
      + '（改了前端却忘了 bust 缓存是本项目已知缺陷，拒绝静默跳过）'
    );
  }

  const mCache = src.match(CACHE_LINE_RE);
  const mApi = src.match(API_CACHE_LINE_RE);
  if (!mCache || !mApi) {
    throw new Error(
      'syncSwCache: sw.js 中未匹配到 CACHE_NAME / API_CACHE_NAME 赋值行，拒绝静默跳过。'
      + '请检查 sw.js 是否被改成了其它写法。'
    );
  }

  const from = mCache[2];
  // 用替换函数而非字符串模板，避免版本号里出现 $ 时被当作替换语法（当前虽不含，但求稳）。
  const out = src
    .replace(CACHE_LINE_RE, (_m, p1, _old, p3) => p1 + ver + p3)
    .replace(API_CACHE_LINE_RE, (_m, p1, _old, p3) => p1 + ver + p3);

  if (out === src) {
    // 目标值与当前值一致 → 幂等返回，无需写盘。
    return { changed: false, from, to: ver, path: swPath };
  }
  writeFileSync(swPath, out, 'utf8');
  return { changed: true, from, to: ver, path: swPath };
}
