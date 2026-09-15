// ============================================================
// check-model-metadata.mjs —— 模型清单唯一数据源
//
// 校验目标
//   1. OfflineLLM.MODEL_OPTIONS 的字段结构与取值合法（key/id/size/sizeBytes/dtype/icon…）；
//   2. resolveModel() 同时接受短键与仓库全名，非法输入返回 null；
//   3. 「唯一数据源」这条硬约定没有被破坏：
//      · 模型仓库 id、体积字符串、sizeBytes 只允许出现在 offline-llm.js；
//      · 剥掉注释后全项目不再出现历史分叉短键 smollm2；
//      · local-model.js / offline-ui.js 只派生、不另建副本；
//   4. 三处模型名必须对齐：device-detection 的推荐名 ⊆ nameToKey 键 == 卡片展示名。
//
// 输入：js/offline-llm.js（沙盒执行）+ js/*.js（静态扫描）
// 输出：逐条 '✓' / 'FAIL'，末行 '>>> check-model-metadata: N PASS / M FAIL'
// 失败判定：任一断言失败 → 打印 FAIL 行并以退出码 1 结束
//
// 为什么值得单列：历史上模型元数据有过 4 份副本，直接导致短键分叉
// （死代码用 smollm2、生效代码用 smollm）与 sizeBytes 漂移。这类问题
// 不会抛异常，只会「设置里显示的体积和实际下载的不一致」。
// ============================================================
import { makeEnv, reporter, jsFiles, read, stripComments } from './_check-lib.mjs';

const r = reporter('check-model-metadata');
const env = makeEnv();
env.run('js/offline-llm.js');

const LLM = env.eval('OfflineLLM');
const OPTS = LLM.MODEL_OPTIONS;

// ---- A. 结构 ----
r.section('A. MODEL_OPTIONS 结构');
r.check(Array.isArray(OPTS) && OPTS.length > 0, `MODEL_OPTIONS 是非空数组（${OPTS.length} 项）`);
for (const m of OPTS) {
  const t = m.key || '(无 key)';
  r.check(typeof m.key === 'string' && /^[a-z][a-z0-9]*$/.test(m.key), `${t}: key 是合法短键（小写字母数字）`);
  r.check(typeof m.id === 'string' && m.id.includes('/'), `${t}: id 是 HF 仓库全名（含 /）`);
  r.check(typeof m.name === 'string' && m.name.trim().length > 0, `${t}: name 非空`);
  r.check(typeof m.size === 'string' && /^~\s*\d+(\.\d+)?\s*(GB|MB)$/.test(m.size), `${t}: size 形如「~1.5GB」`);
  r.check(Number.isInteger(m.sizeBytes) && m.sizeBytes > 0, `${t}: sizeBytes 是正整数`);
  r.check(typeof m.dtype === 'string' && m.dtype.trim().length > 0, `${t}: dtype 非空（须与仓库实际文件一致）`);
  r.check(typeof m.desc === 'string' && m.desc.trim().length > 0, `${t}: desc 非空`);
  r.check(typeof m.icon === 'string' && m.icon.trim().length > 0, `${t}: icon 非空`);
}
r.eq(new Set(OPTS.map((m) => m.key)).size, OPTS.length, 'key 无重复');
r.eq(new Set(OPTS.map((m) => m.id)).size, OPTS.length, 'id 无重复');
r.eq(OPTS.filter((m) => m.recommended).length, 1, '恰好一个 recommended 模型');

// ---- B. 解析函数 ----
r.section('B. resolveModel 解析');
for (const m of OPTS) {
  r.check(LLM.resolveModel(m.key) === m, `resolveModel('${m.key}') 命中该条目（短键）`);
  r.check(LLM.resolveModel(m.id) === m, `resolveModel('${m.id}') 命中该条目（仓库全名）`);
}
r.check(LLM.resolveModel(null) === null, 'resolveModel(null) 返回 null');
r.check(LLM.resolveModel('') === null, 'resolveModel("") 返回 null');
r.check(LLM.resolveModel('不存在的模型') === null, 'resolveModel(未知) 返回 null');
r.eq(Object.keys(LLM.MODEL_BY_KEY).sort().join(','), OPTS.map((m) => m.key).sort().join(','), 'MODEL_BY_KEY 键集合与 MODEL_OPTIONS 一致');
r.eq(Object.keys(LLM.MODEL_BY_ID).sort().join(','), OPTS.map((m) => m.id).sort().join(','), 'MODEL_BY_ID 键集合与 MODEL_OPTIONS 一致');

// ---- C. 体积一致性 ----
r.section('C. size 与 sizeBytes 一致');
for (const m of OPTS) {
  const num = parseFloat(m.size.replace(/[^\d.]/g, ''));
  const unit = /GB/i.test(m.size) ? 1e9 : 1e6;
  const approx = num * unit;
  const diff = Math.abs(approx - m.sizeBytes) / m.sizeBytes;
  r.check(diff <= 0.2, `${m.key}: size(${m.size}) 与 sizeBytes(${m.sizeBytes}) 偏差 ${(diff * 100).toFixed(0)}% ≤ 20%`);
}

// ---- D. 唯一数据源（静态扫描）----
r.section('D. 唯一数据源未被破坏');
const SOURCE = 'js/offline-llm.js';
const ids = OPTS.map((m) => m.id);
const sizes = OPTS.map((m) => m.size);
const others = jsFiles().filter((f) => f !== SOURCE);

const dupIds = others.filter((f) => ids.some((id) => read(f).includes(id)));
r.check(dupIds.length === 0, `模型仓库 id 只出现在 offline-llm.js（重复于：${dupIds.join(',') || '无'}）`);
const dupSizes = others.filter((f) => sizes.some((s) => read(f).includes(s)));
r.check(dupSizes.length === 0, `体积字符串只出现在 offline-llm.js（重复于：${dupSizes.join(',') || '无'}）`);
const dupBytes = others.filter((f) => read(f).includes('sizeBytes'));
r.check(dupBytes.length === 0, `sizeBytes 只出现在 offline-llm.js（重复于：${dupBytes.join(',') || '无'}）`);

// 剥注释后再找历史分叉短键（注释里提到 smollm2 是允许的，那是历史说明）
const forkedKey = jsFiles().filter((f) => stripComments(read(f)).includes('smollm2'));
r.check(forkedKey.length === 0, `代码中（忽略注释）不再出现分叉短键 smollm2（命中：${forkedKey.join(',') || '无'}）`);

// 派生而非复制
const lm = read('js/local-model.js');
r.check(lm.includes('MODEL_OPTIONS') && /Object\.fromEntries/.test(lm), 'local-model.js 从 MODEL_OPTIONS 派生 modelInfo（而非手写副本）');
r.check(/modelCards[\s\S]{0,400}MODEL_OPTIONS/.test(lm) || /MODEL_OPTIONS[\s\S]{0,400}modelCards/.test(lm), 'local-model.js 的 modelCards 也由 MODEL_OPTIONS 派生');

// 死代码不应复活
const dead = jsFiles().filter((f) => read(f).includes('model-manager'));
r.check(dead.length === 0, `无文件引用已删除的 model-manager（命中：${dead.join(',') || '无'}）`);

// ---- E. 三处模型名对齐 ----
r.section('E. 模型名对齐（卡片 / 推荐 / 映射）');
const cardNames = OPTS.map((m) => m.name.replace('（推荐）', ''));
const ui = read('js/offline-ui.js');
const mapBlock = (ui.match(/const\s+nameToKey\s*=\s*\{([\s\S]*?)\}/) || [, ''])[1];
const pairs = [...mapBlock.matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g)].map((m) => ({ name: m[1], key: m[2] }));
r.check(pairs.length > 0, `解析出 nameToKey 映射 ${pairs.length} 条`);
r.check(pairs.every((p) => LLM.resolveModel(p.key)), `nameToKey 的每个值都能被 resolveModel 解析（坏值：${pairs.filter((p) => !LLM.resolveModel(p.key)).map((p) => p.key).join(',') || '无'}）`);
r.eq(pairs.map((p) => p.name).sort().join('|'), [...cardNames].sort().join('|'), 'nameToKey 的键集合 === 模型卡片展示名集合');

// 设备检测产出的推荐名必须都能被映射（否则「自动选择推荐模型」静默失效）
const dd = read('js/device-detection.js');
const recNames = new Set([...dd.matchAll(/recommendation\.model\s*=\s*['"]([^'"]+)['"]/g)].map((m) => m[1]));
r.check(recNames.size > 0, `device-detection 产出 ${recNames.size} 个推荐模型名`);
const unmapped = [...recNames].filter((n) => !pairs.some((p) => p.name === n));
r.check(unmapped.length === 0, `每个推荐名都有 nameToKey 映射（缺失：${unmapped.join(',') || '无'}）`);

// ---- F. 设备自适应推荐：端到端标到卡片上（新增护栏）----
// §C/§E 只保证「推荐名 ↔ 短键 ↔ 卡片展示名」的数据对齐；本段保证这条链路真的作用到 UI
// （设备算出推荐 → nameToKey 映射 → resolveModel → 卡片标出「本机推荐」），
// 防止「检测了设备、算出推荐、然后把结果丢掉」这类静默失效回归。
r.section('F. 设备推荐标出卡片（端到端）');
const recDi = (model) => ({
  memory: 8, cpuCores: 8, gpuSupport: true, gpu: 'WebGPU',
  screen: { width: 1440, height: 900 },
  recommendation: { model, deviceType: 'desktop', warnings: [], suggestions: [] },
});
const REC = [
  ['Qwen2.5-1.5B', 'onnx-community/Qwen2.5-1.5B-Instruct'],
  ['Phi-3.5 Mini', 'onnx-community/Phi-3.5-mini-instruct-onnx-web'],
  ['SmolLM2-1.7B', 'HuggingFaceTB/SmolLM2-1.7B-Instruct'],
];
for (const [name, id] of REC) {
  const e = makeEnv({ globals: { DeviceDetector: { detectDevice: async () => recDi(name) } } });
  e.run('js/offline-llm.js');
  e.run('js/offline-ui.js');
  e.el('model-cards');
  e.el('device-info');
  e.eval('renderModelCards()');
  await e.eval('renderDeviceInfo()');
  const got = e.eval(`(() => {
    const box = document.getElementById('model-cards');
    const cards = box.querySelectorAll('.offline-model-card');
    return {
      total: cards.length,
      marked: cards.filter((c) => c.classList.contains('device-recommended')).map((c) => c.getAttribute('data-model-id')).join(','),
      badge: ((box.querySelector('[data-model-id="${id}"] .offline-model-device-badge')) || {}).textContent || '',
    };
  })()`);
  r.eq(got.total, 3, `${name}: 渲染出 3 张模型卡片`);
  r.eq(got.marked, id, `${name}: 恰好标出对应的那张卡片`);
  r.eq(got.badge, '本机推荐', `${name}: 标出项带「本机推荐」徽章`);
}
{
  const e = makeEnv({ globals: { DeviceDetector: { detectDevice: async () => recDi('Not-A-Model') } } });
  e.run('js/offline-llm.js');
  e.run('js/offline-ui.js');
  e.el('model-cards');
  e.el('device-info');
  e.eval('renderModelCards()');
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  let threw = false;
  try { await e.eval('renderDeviceInfo()'); } catch { threw = true; }
  console.warn = origWarn;
  r.check(!threw, '未匹配推荐名：renderDeviceInfo 不抛异常');
  r.check(warns.some((w) => w.includes('无法映射')), '未匹配推荐名：触发 console.warn');
  r.eq(e.eval(`document.getElementById('model-cards').querySelectorAll('.offline-model-card').filter((c) => c.classList.contains('device-recommended')).length`), 0, '未匹配推荐名：不误标任何卡片');
}

r.done();
