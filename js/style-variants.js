// ============================================================
// style-variants.js —— 离线提示词「样式变体」引擎
//
// 解决的问题：不配置大模型（离线规则引擎）时，所有模板产出的提示词
// 都是同一套「## 角色 / ## 背景 / ## 任务 / ## 约束 / ## 输出格式」五段式，
// 换十个模板看起来也像同一个人写的，非常死板。
//
// 方案：把同一份结构化内容，渲染成 6 种截然不同的**版式风格**。
// 风格只改变「怎么排布、用什么标记、详略程度」，绝不改变内容本身。
//
// 6 种风格：
//   standard   标准分节（现状，保留给需要严谨文档的场景）
//   minimal    极简指令（一段话，适合直接粘贴到对话框）
//   roleplay   角色扮演（第二人称对话式，适合 persona 场景）
//   stepwise   逐步引导（编号步骤，适合复杂多步任务）
//   annotated  带示例（关键处给「例如：」，降低模型跑偏概率）
//   checklist  清单式（Markdown 勾选框，适合要逐项核对的场景）
// ============================================================

const StyleVariants = (() => {
  'use strict';

  // ---- 风格元数据（供 UI 渲染切换控件）----
  const STYLES = [
    { key: 'standard',  zh: '标准分节', en: 'Standard',  zhDesc: '经典五段式，结构最清晰，适合正式交付', enDesc: 'Classic 5-section layout' },
    { key: 'minimal',   zh: '极简指令', en: 'Minimal',   zhDesc: '压缩成一段话，适合直接粘贴进对话框', enDesc: 'One compact paragraph' },
    { key: 'roleplay',  zh: '角色扮演', en: 'Roleplay',  zhDesc: '第二人称对话式，沉浸感强，适合人格化场景', enDesc: 'Second-person conversational' },
    { key: 'stepwise',  zh: '逐步引导', en: 'Stepwise',  zhDesc: '拆成编号步骤，适合流程复杂、易漏项的任务', enDesc: 'Numbered steps' },
    { key: 'annotated', zh: '带示例',   en: 'Annotated', zhDesc: '关键要求后补「例如：」，减少模型跑偏', enDesc: 'With inline examples' },
    { key: 'checklist', zh: '清单核对', en: 'Checklist', zhDesc: '每一项前加勾选框，便于逐条确认与验收', enDesc: 'Markdown checkboxes' },
  ];

  // ---- 各风格、各语言的排版文案 ----
  const T = {
    zh: {
      standard: {
        titles: { role: '## 角色', context: '## 背景与上下文', task: '## 任务', params: '## 约束与参数', format: '## 输出格式' },
        join: '\n\n',
      },
      minimal: {
        intro: '请按以下要求完成任务：',
        bridge: { role: '你的角色是', context: '背景补充：', task: '具体要做的：', params: '硬性要求：', format: '输出方式：' },
        tail: '请直接给出结果，不要复述本段要求，也不要解释你的思路。',
        sep: ' ',
      },
      roleplay: {
        open: '接下来的对话中，请你进入以下状态，并始终保持——',
        rolePrefix: '你现在的身份：',
        contextPrefix: '你已知晓的情况：',
        taskPrefix: '现在，请完成这件事：',
        paramsPrefix: '请遵守这些规矩：',
        formatPrefix: '呈现给我的方式是：',
        close: '准备好了就直接开始，不需要先跟我确认。',
      },
      stepwise: {
        open: '请严格按下面的步骤执行，不要跳步、不要提前给结论：',
        stepNames: { role: '先确认你的身份', context: '读取以下背景', task: '执行核心任务', params: '套用约束条件', format: '按规定格式输出' },
        close: '全部步骤完成后，检查一遍是否满足了所有约束再输出。',
      },
      annotated: {
        titles: { role: '## 角色', context: '## 背景与上下文', task: '## 任务', params: '## 约束与参数', format: '## 输出格式' },
        notes: {
          role: '（例如：一位带过 20 人团队的技术负责人）',
          context: '（例如：面向完全没有技术背景的客户）',
          params: '（例如：不超过 800 字；不出现任何未经验证的数据）',
          format: '（例如：先给结论，再分点说明，最后给行动建议）',
        },
      },
      checklist: {
        open: '请对照下面的清单逐项满足，完成后自行核对一遍：',
        items: { role: '角色定位', context: '背景信息', task: '核心任务', params: '约束条件', format: '输出格式' },
        close: '输出前请确认上述每一项都已落实。',
      },
    },
    en: {
      standard: {
        titles: { role: '## Role', context: '## Context', task: '## Task', params: '## Constraints & Parameters', format: '## Output Format' },
        join: '\n\n',
      },
      minimal: {
        intro: 'Complete the task below:',
        bridge: { role: 'Your role:', context: 'Context:', task: 'What to do:', params: 'Hard requirements:', format: 'Output format:' },
        tail: 'Return the result directly — do not restate these instructions or explain your reasoning.',
        sep: ' ',
      },
      roleplay: {
        open: 'For the rest of this conversation, stay in the following state and never break character:',
        rolePrefix: 'You are now:',
        contextPrefix: 'What you already know:',
        taskPrefix: 'Now do this:',
        paramsPrefix: 'Rules you must follow:',
        formatPrefix: 'Present it to me as:',
        close: 'Start as soon as you are ready — no need to confirm with me first.',
      },
      stepwise: {
        open: 'Follow these steps in order. Do not skip any step or jump to the conclusion early:',
        stepNames: { role: 'Confirm your identity', context: 'Read the background below', task: 'Execute the core task', params: 'Apply the constraints', format: 'Output in the specified format' },
        close: 'Once all steps are done, verify every constraint is satisfied before you output.',
      },
      annotated: {
        titles: { role: '## Role', context: '## Context', task: '## Task', params: '## Constraints & Parameters', format: '## Output Format' },
        notes: {
          role: ' (e.g. a tech lead who has managed 20+ people)',
          context: ' (e.g. an audience with no technical background)',
          params: ' (e.g. under 800 words; no unverified figures)',
          format: ' (e.g. conclusion first, then bullets, then next actions)',
        },
      },
      checklist: {
        open: 'Satisfy every item in this checklist, then verify it yourself before responding:',
        items: { role: 'Role', context: 'Background', task: 'Core task', params: 'Constraints', format: 'Output format' },
        close: 'Confirm each item above is satisfied before you output.',
      },
    },
  };

  // 极简风格下，多行内容要压平（否则"一段话"会退化成还是多段）
  function flatten(lines) {
    return (lines || [])
      .map((l) => String(l).replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
      .filter(Boolean)
      .join('；');
  }

  function indent(lines, pad) {
    return (lines || []).map((l) => pad + l);
  }

  /**
   * 把结构化的五段内容渲染成指定风格。
   * @param {object} sections  { role, context, task, params, format } 每项是 string[]（可能为空）
   * @param {string} styleKey  见 STYLES
   * @param {string} lang      'zh' | 'en'
   * @returns {string}
   */
  function render(sections, styleKey, lang) {
    const L = T[lang] || T.zh;
    const s = (k) => (Array.isArray(sections[k]) ? sections[k].filter(Boolean) : []);
    const style = L[styleKey] ? styleKey : 'standard';

    if (style === 'standard') {
      const c = L.standard.titles;
      const out = [];
      const push = (title, lines) => { if (lines.length) out.push(title + '\n' + lines.join('\n')); };
      push(c.role, s('role'));
      push(c.context, s('context'));
      push(c.task, s('task'));
      push(c.params, s('params'));
      push(c.format, s('format'));
      return out.join(L.standard.join);
    }

    if (style === 'minimal') {
      const c = L.minimal;
      const segs = [];
      ['role', 'context', 'task', 'params', 'format'].forEach((k) => {
        const body = flatten(s(k));
        if (body) segs.push(`${c.bridge[k]}${body}`);
      });
      if (!segs.length) return '';
      return [c.intro, ...segs, c.tail].join(c.sep);
    }

    if (style === 'roleplay') {
      const c = L.roleplay;
      const body = [];
      const block = (prefix, key) => {
        const lines = s(key);
        if (lines.length) { body.push(prefix); body.push(...indent(lines, '  ')); body.push(''); }
      };
      block(c.rolePrefix, 'role');
      block(c.contextPrefix, 'context');
      block(c.taskPrefix, 'task');
      block(c.paramsPrefix, 'params');
      block(c.formatPrefix, 'format');

      // 没有任何正文时直接返回空串：否则会只剩一句「准备好了就直接开始」，
      // 对着空内容说这句既无意义，也让「全空输入应产出空串」的约束失效。
      if (!body.length) return '';
      // 首段为空时不能留下一个悬空的破折号 —— 开场白只在该有内容时才加
      const out = [];
      // 用「你现在的身份」开头时，开场白才有意义；否则直接从具体内容起步
      if (s('role').length > 0) out.push(c.open);
      out.push(...body);
      out.push(c.close);
      return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    if (style === 'stepwise') {
      const c = L.stepwise;
      const out = [];
      let n = 0;
      const step = (key) => {
        const lines = s(key);
        if (!lines.length) return;
        n += 1;
        if (n === 1) { out.push(c.open, ''); }  // 有步骤时才加开场白，否则会只剩一句空喊
        out.push(`${n}. **${c.stepNames[key]}**`);
        out.push(...indent(lines, '   '));
        out.push('');
      };
      ['role', 'context', 'task', 'params', 'format'].forEach(step);
      if (!n) return '';
      out.push(c.close);
      return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    if (style === 'annotated') {
      const c = L.annotated;
      const titles = c.titles;
      const out = [];
      const push = (key) => {
        const lines = s(key);
        if (!lines.length) return;
        // notes 里已含完整括号（"（例如：…）"），直接拼在标题后即可
        const note = c.notes[key] || '';
        out.push(titles[key] + note + '\n' + lines.join('\n'));
      };
      ['role', 'context', 'task', 'params', 'format'].forEach(push);
      return out.join(L.standard.join);
    }

    if (style === 'checklist') {
      const c = L.checklist;
      const body = [];
      ['role', 'context', 'task', 'params', 'format'].forEach((key) => {
        const lines = s(key);
        if (!lines.length) return;
        body.push(`- [ ] **${c.items[key]}**`);
        // 正文缩进挂在勾选项下，保留层级
        lines.forEach((l) => {
          const flat = String(l).replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').trim();
          if (flat) body.push(`      - ${flat}`);
        });
        body.push('');
      });
      if (!body.length) return '';
      return [c.open, '', ...body, c.close].join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    return '';
  }

  // 返回副本：不仅要换数组，元素也要拷贝 —— 只 slice() 的话元素仍是共享引用，
  // 调用方 `getStyles()[0].zh = x` 会就地污染全局元数据，影响所有使用方。
  function getStyles() { return STYLES.map((s) => ({ ...s })); }

  function isKnownStyle(key) { return STYLES.some((x) => x.key === key); }

  return { STYLES, getStyles, isKnownStyle, render };
})();

// 顶层 const 不会自动挂到 window，显式导出（与 optimizer.js 的做法保持一致）
if (typeof window !== 'undefined') window.StyleVariants = StyleVariants;
