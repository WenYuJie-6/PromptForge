// ============================================================
// check-model-derivation.mjs —— 沙盒真跑，验证派生一致
//
// 校验目标
//   1. 把 js/ 下 17 个脚本按 index.html 的顺序在沙盒里真实执行一遍
//      （等价于浏览器加载整站）：任何语法错、加载期异常、跨文件引用断裂都会在这里暴露；
//   2. local-model.js 从唯一数据源派生出的 modelCards / modelInfo 与
//      OfflineLLM.MODEL_OPTIONS 逐字段一致（短键、仓库名、展示名、推荐位、图标）。
//
// 输入：js/ 全部 17 个脚本（只读，在沙盒中按序执行）
// 输出：逐条 '✓' / 'FAIL'，末行 '>>> check-model-derivation: N PASS / M FAIL'
// 失败判定：任一断言失败（含加载抛错）→ 打印 FAIL 行并以退出码 1 结束
//
// 为什么需要它：本项目没有打包器、没有 import，靠 <script> 顺序与隐式全局变量耦合。
// 「静态看起来没问题、一加载就炸」（拼写错、引用未定义变量、顺序颠倒）只有真跑才拦得住。
// ============================================================
import { makeEnv, reporter, ALL_SCRIPTS } from './_check-lib.mjs';

const r = reporter('check-model-derivation');
const env = makeEnv();

// ---- A. 全量加载（真跑）----
r.section('A. 全量加载 17 个脚本');
let loaded = 0;
let loadError = null;
for (const f of ALL_SCRIPTS) {
  try { env.run(f); loaded++; } catch (e) { loadError = `${f}: ${e.message}`; break; }
}
r.eq(ALL_SCRIPTS.length, 17, '脚本清单共 17 个（与 index.html 一致）');
r.check(!loadError, `17 个脚本全部加载成功（${loaded}/${ALL_SCRIPTS.length}）${loadError ? ' — ' + loadError : ''}`);

// 加载期不能有未捕获异常，即使逐个文件都成功，也再确认关键全局齐全
const probes = {
  TEMPLATES: 'object',
  StyleVariants: 'object',
  OfflineLLM: 'object',
  DeviceDetector: 'object',
  PWAInstaller: 'object',
  PromptOptimizer: 'object',   // optimizer.js 的名字是 PromptOptimizer
  localModelManager: 'object',
  loadSettings: 'function',
  downloadDesktopInstaller: 'function',
  resolveUpdateBaseUrl: 'function',
};
for (const [name, type] of Object.entries(probes)) {
  const got = env.eval(`typeof ${name}`);
  r.check(got === type, `全局 ${name} 可用（typeof = ${got}）`);
}

// ---- B. 派生一致性 ----
r.section('B. 派生结果与唯一数据源一致');
const data = env.eval('({ opts: OfflineLLM.MODEL_OPTIONS, cards: modelCards, mgr: localModelManager, info: (typeof localModelManager!=="undefined"&&localModelManager)?localModelManager.modelInfo:null })');
const { opts, cards, mgr, info } = data;

r.check(Array.isArray(cards), 'modelCards 是数组');
r.eq(cards.length, opts.length, 'modelCards 数量与 MODEL_OPTIONS 一致');
r.check(cards.every((c, i) => c.id === opts[i].key), 'modelCards[i].id === MODEL_OPTIONS[i].key（顺序与短键一致）');
r.check(cards.every((c, i) => c.name === opts[i].name.replace('（推荐）', '')), 'modelCards[i].name 去掉了「（推荐）」后缀');
r.check(cards.every((c, i) => c.recommended === !!opts[i].recommended), 'modelCards[i].recommended 与数据源一致');
r.check(cards.every((c, i) => c.icon === (opts[i].icon || '🧩')), 'modelCards[i].icon 与数据源一致');
r.check(cards.every((c, i) => c.size === opts[i].size && c.desc === opts[i].desc), 'modelCards[i] 的 size/desc 与数据源一致');
r.eq(cards.filter((c) => c.recommended).length, 1, 'modelCards 中恰好一个推荐位');

r.check(!!mgr, 'localModelManager 实例创建成功（未被浏览器特性检测挡下）');
r.check(!!info, 'localModelManager.modelInfo 存在');
if (info) {
  r.eq(Object.keys(info).sort().join(','), opts.map((m) => m.key).sort().join(','), 'modelInfo 键集合 === MODEL_OPTIONS 短键集合');
  r.check(opts.every((m) => info[m.key] && info[m.key].id === m.id), 'modelInfo[k].id === MODEL_OPTIONS[k].id');
  r.check(opts.every((m) => info[m.key] && info[m.key].name === m.name && info[m.key].size === m.size), 'modelInfo[k] 的 name/size 与数据源一致');
  r.check(Object.keys(info).every((k) => !('sizeBytes' in info[k])), 'modelInfo 未携带 sizeBytes（体积细节不复制进 UI 层）');
}
r.check(env.window.localModelManager === mgr, 'window.localModelManager 指向同一实例');
r.info('说明：本套件是「整站冒烟」——任何脚本的加载期异常都会让 A 段失败。');

r.done();
