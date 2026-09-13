// ============================================================
// check-styles.mjs —— 6 种版式输出特征
//
// 校验目标
//   StyleVariants.render(sections, styleKey, lang) 对 6 种版式 × 2 种语言
//   都能产出「特征可辨识」且「内容不丢」的文本：
//     standard  五段式小标题      minimal   压成一段话（无标题、无空行）
//     roleplay  第二人称对话式    stepwise  编号步骤
//     annotated 关键处带「例如：」 checklist Markdown 勾选框
//   以及边界：空输入 → ''，未知版式 → 回退 standard，未知语言 → 回退中文。
//
// 输入：js/style-variants.js（只读，在沙盒中执行）
// 输出：逐条 '✓' / 'FAIL'，末行 '>>> check-styles: N PASS / M FAIL'
// 失败判定：任一断言失败 → 打印 FAIL 行并以退出码 1 结束
//
// 为什么值得单列：版式引擎是「离线也能产出不同结构」的核心卖点，
// 一旦某个分支退化成空串或漏掉某一段，用户看到的就是「换了版式没变化」
// 或「内容凭空少了 — 段」。这里对 6 种版式逐一断言特征与内容完整性。
// ============================================================
import { makeEnv, reporter } from './_check-lib.mjs';

const r = reporter('check-styles');
const env = makeEnv();
env.run('js/style-variants.js');

const SV = env.eval('StyleVariants');
const KEYS = ['standard', 'minimal', 'roleplay', 'stepwise', 'annotated', 'checklist'];

// 五种段落，每段给一个唯一 token，便于断言「内容没丢」
const SEC = {
  role: ['ROLE_TK'],
  context: ['CTX_TK'],
  task: ['TASK_TK'],
  params: ['PARAM_TK'],
  format: ['FMT_TK'],
};
const TOKENS = ['ROLE_TK', 'CTX_TK', 'TASK_TK', 'PARAM_TK', 'FMT_TK'];

// ---- A. 元数据 ----
r.section('A. 版式元数据');
r.eq(SV.STYLES.length, 6, '共 6 种版式');
r.check(KEYS.every((k) => SV.STYLES.some((s) => s.key === k)), '6 个版式键齐全：' + KEYS.join(' / '));
r.check(SV.STYLES.every((s) => ['key', 'zh', 'en', 'zhDesc', 'enDesc'].every((f) => typeof s[f] === 'string' && s[f].trim())),
  '每种版式的 key/zh/en/zhDesc/enDesc 均为非空字符串');
{
  const a = SV.getStyles();
  const b = SV.getStyles();
  a[0].zh = '被改坏了';
  r.check(SV.getStyles()[0].zh !== '被改坏了', 'getStyles() 返回副本（外部修改不影响内部）');
  r.check(b.length === 6, 'getStyles() 返回 6 项');
}
r.check(KEYS.every((k) => SV.isKnownStyle(k)), 'isKnownStyle 对 6 个键均返回 true');
r.check(!SV.isKnownStyle('bogus') && !SV.isKnownStyle('') && !SV.isKnownStyle(null), 'isKnownStyle 对非法键返回 false');

// ---- B. 内容完整性 + 语言支持 ----
r.section('B. 内容完整性（6 版式 × 2 语言）');
for (const lang of ['zh', 'en']) {
  for (const k of KEYS) {
    const out = SV.render(SEC, k, lang);
    const missing = TOKENS.filter((t) => !out.includes(t));
    r.check(out.length > 0, `${k}/${lang}: 产出非空`);
    r.check(missing.length === 0, `${k}/${lang}: 5 段内容全部保留${missing.length ? '（缺 ' + missing.join(',') + '）' : ''}`);
  }
}
r.check(SV.render(SEC, 'standard', 'zh') !== SV.render(SEC, 'standard', 'en'), '中英文产出不同');

// ---- C. 各版式特征 ----
r.section('C. 版式特征');
{
  const zh = SV.render(SEC, 'standard', 'zh');
  const en = SV.render(SEC, 'standard', 'en');
  r.check(zh.includes('## 角色') && zh.includes('## 任务'), 'standard/zh 使用「## 角色 / ## 任务」小标题');
  r.check(en.includes('## Role') && en.includes('## Task'), 'standard/en 使用英文小标题');
}
{
  const out = SV.render(SEC, 'minimal', 'zh');
  r.check(!out.includes('##'), 'minimal 无 Markdown 小标题');
  r.check(!out.includes('\n\n'), 'minimal 压成一段话（无空行分段）');
  r.check(out.includes('请按以下要求完成任务：'), 'minimal 含开场引导句');
  r.check(out.includes('请直接给出结果'), 'minimal 含结尾「不要复述」约束');
}
{
  const out = SV.render(SEC, 'roleplay', 'zh');
  r.check(out.includes('你现在的身份：'), 'roleplay 含角色前缀');
  r.check(out.includes('准备好了就直接开始'), 'roleplay 含结尾台词');
  r.check(!out.includes('\n\n\n'), 'roleplay 无三连空行（排版已收敛）');
  r.check(out.startsWith('接下来的对话中'), 'roleplay 有 role 段时以开场白起头');
}
{
  const out = SV.render(SEC, 'stepwise', 'zh');
  r.check(out.includes('1. **'), 'stepwise 使用编号步骤');
  r.check(out.includes('5. **'), 'stepwise 步骤数正确（5 段 → 5 步）');
  r.check(out.includes('请严格按下面的步骤执行'), 'stepwise 含开场引导');
  r.check(out.includes('全部步骤完成后'), 'stepwise 含收尾核对句');
}
{
  const out = SV.render(SEC, 'annotated', 'zh');
  r.check(out.includes('（例如：'), 'annotated 含「（例如：…）」提示');
  r.check(out.includes('## 角色'), 'annotated 保留小标题结构');
}
{
  const out = SV.render(SEC, 'checklist', 'zh');
  r.check(out.includes('- [ ]'), 'checklist 使用 Markdown 勾选框');
  r.check(out.includes('角色定位') && out.includes('输出格式'), 'checklist 每段都有中文条目名');
  r.check(out.includes('输出前请确认'), 'checklist 含收尾核对句');
}

// ---- D. 边界与降级 ----
r.section('D. 边界与降级');
const EMPTY = { role: [], context: [], task: [], params: [], format: [] };
r.check(KEYS.every((k) => SV.render(EMPTY, k, 'zh') === ''), '全空输入对 6 种版式均产出空串');
{
  const unknown = SV.render(SEC, 'not-a-style', 'zh');
  r.eq(unknown, SV.render(SEC, 'standard', 'zh'), '未知版式回退到 standard');
}
{
  const fallback = SV.render(SEC, 'standard', 'fr');
  r.eq(fallback, SV.render(SEC, 'standard', 'zh'), '未知语言回退到中文');
}
{
  const onlyTask = SV.render({ role: [], context: [], task: ['TASK_TK'], params: [], format: [] }, 'roleplay', 'zh');
  r.check(!onlyTask.includes('你现在的身份：'), 'roleplay 无 role 段时不输出角色前缀');
  r.check(!onlyTask.startsWith('接下来的对话中'), 'roleplay 无 role 段时不输出开场白（无悬空引导）');
  r.check(onlyTask.includes('TASK_TK'), 'roleplay 无 role 段时仍保留任务内容');
}
{
  // 极简 / 清单版式要剥掉 Markdown 标记，否则「一段话」里会残留 '##' 与 '-'
  const md = { role: ['## 标题一'], context: [], task: ['- 列表项'], params: [], format: [] };
  const min = SV.render(md, 'minimal', 'zh');
  r.check(!min.includes('## 标题一') && min.includes('标题一'), 'minimal 剥掉标题标记保留文字');
  r.check(!min.includes('- 列表项') && min.includes('列表项'), 'minimal 剥掉列表标记保留文字');
  const chk = SV.render(md, 'checklist', 'zh');
  r.check(chk.includes('标题一') && chk.includes('列表项'), 'checklist 正文保留文字内容');
}
r.info('说明：本套件只断言「版式特征 + 内容不丢」，不锁死措辞文案；改文案不会误报。');

r.done();
