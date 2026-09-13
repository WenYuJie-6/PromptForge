// ============================================================
// check-frameworks.mjs —— 框架 / 模板定义完整性
//
// 校验目标
//   1. frameworks.js 的 7 个框架（含 4 个多模态）定义齐全、字段结构正确；
//   2. buildPrompt(idea, structuredData) 对 字符串 / 对象 / 数组 / null 四种入参
//      都不崩、不产出 '[object Object]'、不丢内容；
//   3. 模板库无重复 id/name、无「...」占位符、framework 引用有效、分类自洽；
//   4. API 预设结构正确。
//
// 输入：js/frameworks.js（只读，在沙盒中执行）
// 输出：逐条 '✓' / 'FAIL'，末行 '>>> check-frameworks: N PASS / M FAIL'
// 失败判定：任一断言失败 → 打印 FAIL 行并以退出码 1 结束
//
// 为什么值得单列一个套件：历史上模板预填过「主题是...」这类占位符（10/14 个），
// 用户点开不改直接生成，等于把半成品丢给模型；也出现过 buildPrompt 收到对象后
// 变成 '[object Object]' 把用户回答整体吞掉。这两类回归都由本套件拦截。
// ============================================================
import { makeEnv, reporter } from './_check-lib.mjs';

const r = reporter('check-frameworks');
const env = makeEnv();
env.run('js/frameworks.js');

const X = env.eval('({ FRAMEWORKS, TEMPLATES, CATEGORIES, API_PRESETS, FRAMEWORK_DIMENSIONS })');
const { FRAMEWORKS, TEMPLATES, CATEGORIES, API_PRESETS, FRAMEWORK_DIMENSIONS } = X;

const CLASSIC = ['costar', 'create', 'broke'];
const MULTIMODAL = ['image', 'voice', 'video', 'music'];
const ALL = [...CLASSIC, ...MULTIMODAL];

// ---- A. 框架定义 ----
r.section('A. 框架定义');
r.eq(Object.keys(FRAMEWORKS).length, 7, '框架数量为 7');
r.check(ALL.every((k) => k in FRAMEWORKS), '7 个预期框架键全部存在：' + ALL.join(' / '));

for (const key of ALL) {
  const f = FRAMEWORKS[key];
  if (!f) { r.fail(`框架 ${key} 缺失`); continue; }
  r.check(typeof f.name === 'string' && f.name.trim().length > 0, `${key}: name 非空`);
  r.check(typeof f.desc === 'string' && f.desc.trim().length > 0, `${key}: desc 非空`);
  r.check(Array.isArray(f.fields) && f.fields.length > 0, `${key}: fields 是非空数组`);
  r.check(Array.isArray(f.fields) && f.fields.every((s) => typeof s === 'string' && s.trim()), `${key}: fields 每项为非空字符串`);
  r.check(typeof f.buildPrompt === 'function', `${key}: buildPrompt 是函数`);
}
r.check(CLASSIC.every((k) => !FRAMEWORKS[k].modality), '经典框架无 modality 字段');
r.check(MULTIMODAL.every((k) => FRAMEWORKS[k].modality === k), '多模态框架 modality 与键一致');

// ---- B. buildPrompt 四种入参 ----
r.section('B. buildPrompt 入参健壮性');
const IDEA = '写一篇关于城市夜跑的小红书笔记';
for (const key of ALL) {
  const out = FRAMEWORKS[key].buildPrompt(IDEA, '受众: 上班族\n风格: 轻快');
  r.check(out.length > 0, `${key}: 字符串入参产出非空`);
  r.check(out.includes(IDEA), `${key}: 字符串入参保留用户想法`);
  r.check(out.includes('受众: 上班族'), `${key}: 字符串入参保留结构化内容`);
  r.check(!out.includes('[object Object]'), `${key}: 字符串入参无 [object Object]`);
  r.check(!/\bundefined\b/.test(out), `${key}: 字符串入参无 undefined`);

  const out2 = FRAMEWORKS[key].buildPrompt(IDEA, { 受众: '上班族', 风格: '轻快' });
  r.check(out2.includes('受众: 上班族'), `${key}: 对象入参被格式化为「字段: 值」`);
  r.check(!out2.includes('[object Object]'), `${key}: 对象入参无 [object Object]`);
}
{
  const f = FRAMEWORKS.costar;
  r.check(typeof f.buildPrompt(IDEA, null) === 'string', 'null 入参不抛错');
  r.check(typeof f.buildPrompt(IDEA, undefined) === 'string', 'undefined 入参不抛错');
  const empty = f.buildPrompt(IDEA, {});
  r.check(!empty.includes('已收集的信息'), '空对象入参不产生空的「已收集的信息」块');
  const arr = f.buildPrompt(IDEA, ['第一点', '第二点']);
  r.check(arr.includes('第一点') && arr.includes('第二点'), '数组入参被压平进提示词');
  const skipped = f.buildPrompt(IDEA, { a: '', b: null, c: '有用' });
  r.check(skipped.includes('c: 有用') && !skipped.includes('a:'), '对象入参跳过空值字段');
}

// ---- C. 评估维度 ----
r.section('C. 评估维度');
r.check(ALL.every((k) => typeof FRAMEWORK_DIMENSIONS[k] === 'string' && FRAMEWORK_DIMENSIONS[k].trim()), '每个框架都有评估维度文本');
r.check(ALL.every((k) => FRAMEWORK_DIMENSIONS[k].includes(FRAMEWORKS[k].name)), '维度文本包含对应框架名');

// ---- D. 模板库 ----
r.section('D. 模板库');
r.eq(TEMPLATES.length, 29, '模板数量为 29');
const REQ = ['id', 'cat', 'name', 'desc', 'idea', 'tip', 'framework'];
r.check(TEMPLATES.every((t) => REQ.every((k) => typeof t[k] === 'string' && t[k].trim())), '每个模板 7 个字段齐全且非空');
r.check(TEMPLATES.every((t) => t.framework in FRAMEWORKS), '每个模板的 framework 都指向已定义框架');
r.eq(new Set(TEMPLATES.map((t) => t.id)).size, TEMPLATES.length, '模板 id 无重复');
r.eq(new Set(TEMPLATES.map((t) => t.name)).size, TEMPLATES.length, '模板 name 无重复');
const placeholders = TEMPLATES.filter((t) => /\.\.\.|…|待补充|XXX/.test(t.idea));
r.check(placeholders.length === 0,
  `无模板使用占位符（${placeholders.map((t) => t.id).join(',') || '无'}）`);
r.check(TEMPLATES.every((t) => t.idea.trim().length > 15), '每个模板 idea 长度 > 15（是完整示例而非半成品）');
r.check(ALL.every((k) => TEMPLATES.some((t) => t.framework === k)), '每个框架至少被 1 个模板使用');

// ---- E. 分类 ----
r.section('E. 分类');
r.eq(CATEGORIES[0], '全部', 'CATEGORIES 首项为「全部」');
const cats = new Set(TEMPLATES.map((t) => t.cat));
r.eq(CATEGORIES.length, cats.size + 1, '分类数 = 模板出现的分类数 + 1');
r.check([...cats].every((c) => CATEGORIES.includes(c)), '所有模板分类都在 CATEGORIES 中');

// ---- F. API 预设 ----
r.section('F. API 预设');
r.eq(Object.keys(API_PRESETS).length, 6, 'API 预设数量为 6');
for (const [k, v] of Object.entries(API_PRESETS)) {
  r.check(typeof v.endpoint === 'string' && /^https?:\/\//.test(v.endpoint), `${k}: endpoint 是 http(s) 地址`);
  r.check(typeof v.model === 'string' && v.model.trim().length > 0, `${k}: 有默认模型名`);
  r.check(typeof v.hint === 'string' && v.hint.trim().length > 0, `${k}: 有 hint 文案`);
}
r.check(API_PRESETS.ollama.endpoint.includes('localhost'), 'ollama 预设指向 localhost');

r.done();
