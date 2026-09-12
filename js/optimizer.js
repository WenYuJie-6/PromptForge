// ============================================================
// optimizer.js —— 提示词优化引擎（纯逻辑，不触碰 DOM；UI 见 optimize-ui.js）
//   1. 语言检测：中 / 英 / 中英混合，新增内容语言跟随输入主导语言
//   2. 五维诊断：明确任务 · 上下文背景 · 角色与语气 · 参数与约束 · 结构化输出
//   3. 本地规则优化：句子级重排 + 缺失维度补全，不依赖任何 API
//   4. 行级 diff（LCS）：用于原文 / 优化版逐行对比
//   5. AI 深度优化请求体构造（复用统一入口 callLLM）
// ============================================================

const PromptOptimizer = (() => {
  'use strict';

  // ---- 语言检测 ----------------------------------------------------------
  const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/g;
  const LATIN_WORD_RE = /[A-Za-z][A-Za-z'-]*/g;

  function detectLanguage(text) {
    const s = String(text == null ? '' : text);
    const zhChars = (s.match(CJK_RE) || []).length;
    const enWords = (s.match(LATIN_WORD_RE) || []).length;
    // 一个中文词约 2 字，折算成"词"后再与英文词数比较，避免等量文本偏向中文
    const zhScore = zhChars / 2;
    const total = zhScore + enWords;
    if (!total) {
      return { primary: 'zh', zhChars: 0, enWords: 0, zhRatio: 0, mixed: false, empty: true };
    }
    const zhRatio = zhScore / total;
    return {
      primary: zhRatio >= 0.5 ? 'zh' : 'en',
      zhChars,
      enWords,
      zhRatio,
      mixed: zhChars > 0 && enWords > 0 && zhRatio > 0.2 && zhRatio < 0.8,
      empty: false,
    };
  }

  // ---- 五维诊断 ----------------------------------------------------------
  // 顺序即"句子归属优先级"：越具体的维度越靠前，避免"请…"这类通用词抢走所有句子
  const DIM_DEFS = [
    {
      key: 'role', zh: '角色与语气', en: 'Role & Tone',
      zhRe: /(你是|您是|扮演|充当|作为一|作为该|身份是|角色|专家|资深|老师|教练|顾问|编辑|分析师|工程师|设计师|语气|口吻|文风|风格|调性|人设|口语化|书面化|接地气|幽默|诙谐|亲切|温暖|活泼|严谨|正式)/,
      enRe: /\b(you are|act as|serve as|take on the role|role|persona|expert|senior|veteran|consultant|editor|analyst|engineer|designer|tone|style|voice|manner|conversational|casual|formal|humorous|friendly|warm)\b/i,
    },
    {
      key: 'format', zh: '结构化输出', en: 'Structured Output',
      zhRe: /(输出格式|输出结构|输出为|格式|结构|形式输出|形式给出|按以下|如下格式|分点|分条|分步骤|逐条|列表|清单|表格|大纲|模板|标题|小节|分段|层级|json|markdown|yaml|xml|csv)/i,
      enRe: /\b(format|structure|structured|output as|bullet|numbered|list|checklist|table|outline|template|sections?|headings?|markdown|json|yaml|xml|csv|step[- ]by[- ]step)\b/i,
    },
    {
      key: 'params', zh: '参数与约束', en: 'Parameters & Constraints',
      zhRe: /(字数|篇幅|长度|条数|数量|个数|不超过|不多于|不少于|大于|小于|至少|最多|控制在|限制|约束|禁止|不得|不要|避免|必须|只能|仅限|以内|左右|前后|范围内|优先级|权重|注意事项|简短|简洁|精炼|简短些)/,
      enRe: /\b(no more than|not more than|at most|at least|less than|more than|within|exactly|limit(ed)?|constraint|restrict|avoid|forbid|must|should not|don't|do not|only|short|brief|concise|succinct|words|characters|items|lines|sentences|points|steps|max(imum)?|min(imum)?)\b/i,
    },
    {
      key: 'context', zh: '上下文背景', en: 'Context & Background',
      zhRe: /(背景|上下文|场景|行业|领域|赛道|平台|渠道|产品|品牌|公司|团队|项目|受众|用户群|人群|目标用户|读者|客户|面向|现状|前提|已知|资料|数据|以下是|如下资料|附件|参考资料)/,
      enRe: /\b(context|background|scenario|industry|domain|field|platform|channel|product|brand|company|team|project|audience|readers?|customers?|users?|target|situation|given|here is|below is|attached)\b/i,
    },
    {
      key: 'task', zh: '明确任务', en: 'Clear Task',
      zhRe: /(请|帮我|麻烦|希望|需要你|要求|负责|完成|生成|产出|撰写|写作|写|总结|概括|分析|解读|翻译|润色|改写|重写|设计|规划|制定|优化|评估|评测|解释|说明|介绍|对比|比较|推荐|建议|列出|罗列|检查|审查|修复|解决|实现|开发|编写)/,
      enRe: /\b(please|help|write|generate|create|produce|draft|summari[sz]e|analy[sz]e|interpret|translate|polish|rewrite|rephrase|design|plan|optimi[sz]e|evaluate|assess|explain|describe|introduce|compare|recommend|suggest|list|check|review|audit|fix|debug|solve|implement|develop|build)\b/i,
    },
  ];

  // 数字 + 量词（"500字" / "3 bullet points"）：params 维度的强信号
  const NUM_UNIT_RE = /\d+\s*(字|词|条|个|行|句|点|步|项|页|分|秒|words?|characters?|items?|lines?|sentences?|points?|steps?|bullets?)/i;
  // Markdown 结构标记：已具备分节能力，视为 format 命中
  const STRUCT_RE = /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s)/;

  function matchesDim(def, text, langInfo) {
    const primary = langInfo.primary === 'zh' ? def.zhRe : def.enRe;
    const alt = langInfo.primary === 'zh' ? def.enRe : def.zhRe;
    // 中英混合输入两种词表都参与判定，否则混合提示词会被严重漏判
    return primary.test(text) || (langInfo.mixed && alt.test(text));
  }

  function analyze(text) {
    const src = String(text == null ? '' : text);
    const lang = detectLanguage(src);
    const dims = DIM_DEFS.map((def) => ({
      key: def.key,
      label: lang.primary === 'zh' ? def.zh : def.en,
      hit: matchesDim(def, src, lang),
    }));
    const byKey = (k) => dims.find((d) => d.key === k);
    if (STRUCT_RE.test(src) && byKey('format')) byKey('format').hit = true;
    if (NUM_UNIT_RE.test(src) && byKey('params')) byKey('params').hit = true;

    const hitCount = dims.filter((d) => d.hit).length;
    return {
      lang,
      dims,
      hitCount,
      missing: dims.filter((d) => !d.hit).map((d) => d.key),
      score: Math.round((hitCount / dims.length) * 10),
      length: src.trim().length,
    };
  }

  // 「你是一位…」「作为资深…」「扮演…」这类**显式身份指派**，优先级高于其他一切信号。
  // 否则「你是一位营养师，给健身人群写一份食谱」会被 task 维度里的「写」字整句抢走，
  // 角色信息就丢了 —— 这正是角色扮演版式拿不到身份、开场白变成空壳的原因。
  // 不用后行断言（旧版 Safari 不支持，会直接导致脚本解析失败）。
  const ROLE_ASSIGN_RE = /^(你|您|从现在开始你|接下来你)\s*(是|现在是一?位?|将扮演|要扮演)|^(请)?(扮演|充当|担任)\s*|^作为(一?[位名])?[^，,。；;]{1,24}[，,。；;]|^以[^，,。；;]{1,20}(身份|角色|视角|立场)/;

  // ---- 文本切分（按行 → 长行再按句读）----
  function splitUnits(text) {
    const units = [];
    String(text).split('\n').forEach((raw) => {
      const line = raw.trim();
      if (!line) return;
      // 列表项 / 标题 / 引用整体保留，不再切分
      if (/^([-*+]\s|\d+[.)]\s|#{1,6}\s|>\s)/.test(line)) {
        units.push(line);
        return;
      }
      // 行首是指派式角色描述（"你是一位营养师，给…"）时，
      // 即便整行很短也要把角色从句切出来，否则角色会跟着任务一起被吞掉
      if (ROLE_ASSIGN_RE.test(line)) {
        const m = line.match(/^([^，,。；;]{2,30})[，,。；;]\s*(.+)$/);
        if (m) { units.push(m[1].trim()); units.push(m[2].trim()); return; }
      }
      // 短行整体保留
      if (line.length <= 40) { units.push(line); return; }
      // 不用后行断言（旧版 Safari 不支持，会直接导致脚本解析失败）
      const pieces = line.match(/[^。！？；.!?;]+[。！？；.!?;]?/g);
      if (pieces && pieces.length) pieces.forEach((p) => { const t = p.trim(); if (t) units.push(t); });
      else units.push(line);
    });
    return units;
  }

  function classify(unit, langInfo, isFirst) {
    // 显式身份指派：无论在第几句，都归「角色」
    if (ROLE_ASSIGN_RE.test(unit.trim())) return 'role';
    // 第一句通常是主请求：只要它含动作指令就归到「任务」，
    // 否则会被 product / audience / 字数 一类的关键词抢走，导致任务区空掉
    if (isFirst) {
      const taskDef = DIM_DEFS.find((d) => d.key === 'task');
      if (matchesDim(taskDef, unit, langInfo)) return 'task';
    }
    for (const def of DIM_DEFS) {
      if (matchesDim(def, unit, langInfo)) return def.key;
    }
    return null;
  }

  function normalize(text) {
    return String(text == null ? '' : text)
      .replace(/\r\n?/g, '\n')
      .split('\n').map((l) => l.replace(/\s+$/, '')).join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ---- 本地补全文案（缺失维度时的默认内容）----
  const TEXT = {
    zh: {
      roleTitle: '## 角色',
      roleDefault: '你是一位在该领域拥有十年以上实战经验的资深专家，输出需专业、准确、可直接落地。',
      contextTitle: '## 背景与上下文',
      contextPlaceholder: '- （待补充）目标受众是谁？内容将用于哪个平台或场景？有哪些必须遵守的前提或已有资料？',
      taskTitle: '## 任务',
      taskClarify: '请完成以下任务（原文未使用明确的动作指令，如不符请改成「撰写 / 分析 / 改写」等具体动词）：',
      paramsTitle: '## 约束与参数',
      paramsDefault: [
        '- 篇幅：未特别说明时控制在 300–600 字；需要更长请在此明确',
        '- 语言：与用户输入保持一致；专业术语首次出现时附简短解释',
        '- 事实：不得编造数据、案例或引用；不确定的内容标注「待确认」',
      ],
      formatTitle: '## 输出格式',
      formatDefault: [
        '请按以下结构输出：',
        '1. **结论先行**：用 1–2 句给出核心答案或判断',
        '2. **要点展开**：分点说明理由或步骤，每点不超过 3 行',
        '3. **行动建议**：给出可立即执行的下一步',
        '- 使用 Markdown；涉及对比或数据时用表格呈现',
      ],
    },
    en: {
      roleTitle: '## Role',
      roleDefault: 'You are a senior expert with 10+ years of hands-on experience in this domain. Be precise, professional, and actionable.',
      contextTitle: '## Context',
      contextPlaceholder: '- (TODO) Who is the target audience? Which platform or scenario is this for? Any constraints or source material to respect?',
      taskTitle: '## Task',
      taskClarify: 'Complete the following task (the original text has no explicit verb — replace with a concrete one such as write / analyze / rewrite if needed):',
      paramsTitle: '## Constraints & Parameters',
      paramsDefault: [
        '- Length: unless stated otherwise keep it within 300-600 words; say so if you need more',
        '- Language: mirror the language of the user input; gloss jargon on first use',
        '- Facts: never invent data, cases or citations; mark uncertain items as "TBD"',
      ],
      formatTitle: '## Output Format',
      formatDefault: [
        'Structure your answer as follows:',
        '1. **Bottom line**: the core answer in 1-2 sentences',
        '2. **Key points**: bullet the reasoning or steps, 3 lines max each',
        '3. **Next actions**: concrete steps that can be executed immediately',
        '- Use Markdown; use a table when comparing options or presenting numbers',
      ],
    },
  };

  const CHANGE_TEXT = {
    zh: {
      addRole: '补充「角色与语气」：原文未指定 AI 应扮演的身份，已加入默认专家角色',
      addContext: '标记「上下文背景」：缺少受众 / 场景说明，已插入待补充项（这类信息只有你掌握，AI 无法凭空推断）',
      addParams: '补充「参数与约束」：加入篇幅、语言与事实性边界',
      addFormat: '补充「结构化输出」：规定「结论先行 → 要点展开 → 行动建议」三段式',
      addTask: '提示「明确任务」：原文缺少动作指令，已标注需要补具体动词',
      keep: (label, n) => `归整「${label}」：原文中 ${n} 处相关内容已集中到独立小节（用词与原意未改动）`,
      summary: (a, b, c) => `原文 ${a} 字 → 优化版 ${b} 字，共 ${c} 个小节`,
      noMissing: '五个维度均已覆盖，本次仅做结构归整，未改动你的原始表述',
    },
    en: {
      addRole: 'Added "Role & Tone": the original prompt never assigns an identity, so a default expert role was added',
      addContext: 'Flagged "Context & Background": audience / scenario is missing, a TODO item was inserted (only you have this information)',
      addParams: 'Added "Parameters & Constraints": length, language and factuality boundaries',
      addFormat: 'Added "Structured Output": a bottom-line → key-points → next-actions layout',
      addTask: 'Flagged "Clear Task": no action verb found, marked for a concrete verb',
      keep: (label, n) => `Reorganized "${label}": ${n} related line(s) from the original were grouped into a dedicated section (wording unchanged)`,
      summary: (a, b, c) => `${a} chars → ${b} chars, ${c} sections`,
      noMissing: 'All five dimensions are already covered — only structural cleanup was applied, wording untouched',
    },
  };

  // ---- 本地规则优化 ------------------------------------------------------
  function optimizeLocal(rawText, options = {}) {
    const src = normalize(rawText);
    if (!src) {
      // 空输入没有渲染任何东西，style 用空串而不是 'standard'，避免 UI 打出一个假标签
      return { optimized: '', changes: [], report: null, reportAfter: null, scoreBefore: 0, scoreAfter: 0, lang: 'zh', style: '' };
    }

    const report = analyze(src);
    const lang = (options.lang && options.lang !== 'auto') ? options.lang : report.lang.primary;
    // 版式风格：默认按内容特征自动挑一个，用户显式指定则用用户的
    const style = pickStyle(options.style, src, report);
    const T = TEXT[lang] || TEXT.zh;
    const C = CHANGE_TEXT[lang] || CHANGE_TEXT.zh;
    const dimOf = (k) => report.dims.find((d) => d.key === k) || { hit: false };

    const units = splitUnits(src);
    const buckets = { role: [], context: [], params: [], format: [], task: [] };

    if (units.length <= 1) {
      // 单句输入不做拆分，整段作为任务保留，避免在短提示词上做无意义的"归类"。
      // 唯一例外：整句就是一次身份指派（"你是 Python 专家"），
      // 这时归到角色才对，否则角色扮演版式拿不到身份、还会把它误读成任务。
      const only = units[0] || '';
      if (only && ROLE_ASSIGN_RE.test(only) && !DIM_DEFS.find((d) => d.key === 'task' && matchesDim(d, only, report.lang))) {
        buckets.role = units.slice();
      } else {
        buckets.task = units.slice();
      }
    } else {
      units.forEach((u, idx) => {
        const heading = u.match(/^#{1,6}\s+(.+)$/);
        const probe = heading ? heading[1] : u; // 标题行只拿标题文本判定
        buckets[classify(probe, report.lang, idx === 0) || 'task'].push(u);
      });
      // 极端情况：全部被归到别的桶，主任务会丢 —— 把最长的一句拿回任务区
      if (!buckets.task.length) {
        let bestKey = '', bestIdx = -1, bestLen = -1;
        ['role', 'context', 'params', 'format'].forEach((k) => {
          buckets[k].forEach((u, i) => { if (u.length > bestLen) { bestLen = u.length; bestKey = k; bestIdx = i; } });
        });
        if (bestIdx >= 0) buckets.task.push(buckets[bestKey].splice(bestIdx, 1)[0]);
      }
    }

    const changes = [];

    // 角色
    const roleLines = buckets.role.slice();
    if (!dimOf('role').hit) { roleLines.unshift(T.roleDefault); changes.push(C.addRole); }
    else if (roleLines.length) changes.push(C.keep(dimOf('role').label, roleLines.length));

    // 上下文
    const ctxLines = buckets.context.slice();
    if (!dimOf('context').hit) { ctxLines.unshift(T.contextPlaceholder); changes.push(C.addContext); }
    else if (ctxLines.length) changes.push(C.keep(dimOf('context').label, ctxLines.length));

    // 任务
    const taskLines = buckets.task.slice();
    if (!dimOf('task').hit && taskLines.length) { taskLines.unshift(T.taskClarify); changes.push(C.addTask); }

    // 参数与约束
    const paramLines = buckets.params.slice();
    if (!dimOf('params').hit) { paramLines.unshift(...T.paramsDefault); changes.push(C.addParams); }
    else if (paramLines.length) changes.push(C.keep(dimOf('params').label, paramLines.length));

    // 输出格式
    const fmtLines = buckets.format.slice();
    if (!dimOf('format').hit) { fmtLines.unshift(...T.formatDefault); changes.push(C.addFormat); }
    else if (fmtLines.length) changes.push(C.keep(dimOf('format').label, fmtLines.length));

    const sections = {
      role: roleLines,
      context: ctxLines,
      task: taskLines,
      params: paramLines,
      format: fmtLines,
    };

    // 渲染成选定版式；StyleVariants 未加载时回落到标准五段式（保证向后兼容）
    const optimized = (typeof StyleVariants !== 'undefined' && StyleVariants.render)
      ? StyleVariants.render(sections, style, lang)
      : legacyRender(sections, T, lang);

    const reportAfter = analyze(optimized);

    if (!changes.length) changes.push(C.noMissing);
    changes.unshift(C.summary(report.length, optimized.length, countBlocks(sections)));

    return {
      optimized,
      changes,
      report,
      reportAfter,
      scoreBefore: report.score,
      scoreAfter: reportAfter.score,
      lang,
      style,
    };
  }

  // 标准五段式兜底（StyleVariants 缺失时使用，逻辑与改造前完全一致）
  function legacyRender(sections, T, lang) {
    const out = [];
    const emit = (title, lines) => { if (lines && lines.length) out.push(title + '\n' + lines.join('\n')); };
    emit(T.roleTitle, sections.role);
    emit(T.contextTitle, sections.context);
    emit(T.taskTitle, sections.task);
    emit(T.paramsTitle, sections.params);
    emit(T.formatTitle, sections.format);
    const between = lang === 'en' ? '\n\n' : '\n\n';
    return out.join(between);
  }

  function countBlocks(sections) {
    return ['role', 'context', 'task', 'params', 'format']
      .filter((k) => Array.isArray(sections[k]) && sections[k].length).length;
  }

  // ---- 自动挑选版式 -------------------------------------------------------
  // 目标：不配置大模型时，不同特点的输入自然落到不同版式上，
  // 而不是所有输入都吐同一套五段式。
  //
  // 排序原则：**先看用户显式表达的意图（要不要分步、有没有给列表、有没有指定角色），
  // 再看篇幅**。早期版本把「长度 < 40 → 极简」放在最前面，结果「第一步…然后…最后」
  // 这种明确要求分步的短输入也被压成一段话，正好搞反了；这里把结构信号提到长度之前。
  function pickStyle(requested, src, report) {
    if (requested && requested !== 'auto' && typeof StyleVariants !== 'undefined' && StyleVariants.isKnownStyle(requested)) {
      return requested;
    }
    if (requested && requested !== 'auto') return 'standard';

    const text = src.trim();
    const len = text.length;
    const missing = report.missing.length;
    const lines = text.split('\n').filter((l) => l.trim());
    // 列表形态：以 - * + 或 1. 1) 开头的行，或「分号/顿号密集的短行堆叠」
    const listLines = lines.filter((l) => /^\s*([-*+]\s|\d+[.)]\s|[-*+]\s)/.test(l)).length;
    const hasList = listLines >= 2 || (lines.length >= 3 && listLines >= 1);
    const hasRole = !!report.dims.find((d) => d.key === 'role' && d.hit);
    const stepWords = /(步骤|流程|第一步|第二步|先.{0,8}再|之后|然后|接着|最后|依次|顺序|step\s*\d|first|then|next|finally)/i.test(text);
    // 明确的验收/核对口吻
    const auditWords = /(逐项|逐条|核对|检查清单|验收|务必确认|每一条|checklist)/i.test(text);

    // —— 结构信号优先（与篇幅无关）——
    // 1) 用户说了「按步骤 / 先…再…」：就该给逐步引导，短也一样
    if (stepWords) return 'stepwise';
    // 2) 用户已经在用列表列参数：清单式最好核对
    if (hasList) return auditWords || len > 120 ? 'checklist' : 'annotated';
    // 3) 用户指定了角色身份：角色扮演最贴合
    if (hasRole && len >= 12) return 'roleplay';
    // 4) 明确要求逐项核对
    if (auditWords) return 'checklist';

    // —— 再看篇幅与信息密度 ——
    // 「极简」只在真的没什么可说时才用：很短 **且** 维度几乎全缺。
    // 只看长度会让一批「一句话但信息量足」的输入也被压平，整体又会变得千篇一律，
    // 所以这一带还要看请求的**性质**：对比/解释类适合分步讲清，改写/生成类适合带示例。
    const isCompare = /(对比|比较|区别|差异|优劣|优缺点|vs\b|versus)/i.test(text);
    const isExplain = /(解释|说明|介绍|是什么|为什么|原理|概念|科普)/.test(text);
    const isTransform = /(润色|改写|重写|翻译|改写成|转成|整理|格式化|提取)/.test(text);

    if (len < 14 && missing >= 4 && !isCompare && !isExplain) return 'minimal';
    // 极短但已经有若干维度命中：带示例能给模型更多抓手
    if (len < 30) {
      if (missing >= 4 && !isCompare && !isExplain && !isTransform) return 'minimal';
      if (isTransform) return 'annotated';
      if (isCompare || isExplain) return 'stepwise';
      return 'annotated';
    }
    // 短句但缺得不多：说明用户已经说清了重点，渐进式引导反而更顺
    if (len < 55) return missing >= 3 ? 'annotated' : 'stepwise';
    // 中等长度且缺维度多：带示例降低跑偏概率
    if (missing >= 3) return 'annotated';
    // 长文且结构完整：清单式便于逐项对照
    if (len > 300 && missing <= 1) return 'checklist';
    // 偏长的：逐步引导读起来比大段文字清楚
    if (len > 180) return 'stepwise';
    // 其余：带示例比光秃秃的五段式更有引导性
    return 'annotated';
  }

  // ---- AI 深度优化请求体 -------------------------------------------------
  const LLM_TEXT = {
    zh: {
      system: '你是世界顶尖的提示词工程师。你的唯一任务是把用户给出的提示词重写得更清晰、更完整、更可控。你只输出优化后的提示词本身。',
      principles: [
        '优化原则（缺失的才补，已有的只做强化，绝不改变用户原意）：',
        '1. 明确任务：用祈使句写清"要做什么"和"交付什么"，消除歧义',
        '2. 补充上下文：交代背景、场景、受众与前提，让模型无需猜测',
        '3. 设定参数与约束：给出篇幅、数量、语言、禁用项、事实性等可量化边界',
        '4. 结构化输出：规定输出的组织方式（分节 / 列表 / 表格 / JSON 等）与顺序',
        '5. 角色与语气：必要时指定模型应扮演的身份与表达调性',
      ].join('\n'),
      missing: (list) => `本次检测缺失或不足的维度：${list}。请重点补全这些部分；用户已提供的信息不要重复编造，确实无法推断时用「（待补充：…）」占位。`,
      langLine: '输出语言：必须与原始提示词的主要语言保持一致。若原文中英混合，保留原有混合写法，新增部分使用主要语言。',
      rules: [
        '输出要求：',
        '- 只输出优化后的提示词，禁止任何前言、解释、评分或 Markdown 代码围栏',
        '- 保留原始提示词中的专有名词、示例数据与格式要求',
        '- 不要新增原文没有的事实性信息',
      ].join('\n'),
    },
    en: {
      system: 'You are a world-class prompt engineer. Your only job is to rewrite the user prompt so it is clearer, more complete and more controllable. You output the optimized prompt and nothing else.',
      principles: [
        'Optimization principles (add only what is missing, strengthen what exists, never change the intent):',
        '1. Clear task: use imperatives that state exactly what to do and what to deliver',
        '2. Context: supply background, scenario, audience and premises so the model never has to guess',
        '3. Parameters & constraints: length, count, language, prohibitions, factuality — make them measurable',
        '4. Structured output: specify the organization (sections / bullets / table / JSON) and their order',
        '5. Role & tone: assign an identity and a voice when it helps',
      ].join('\n'),
      missing: (list) => `Dimensions detected as missing or weak: ${list}. Focus on completing them; never invent what the user did not provide — use "(TODO: ...)" instead.`,
      langLine: 'Output language: it must match the dominant language of the original prompt. If the original mixes Chinese and English, keep that mix and write new parts in the dominant language.',
      rules: [
        'Output rules:',
        '- Output only the optimized prompt — no preamble, explanation, scoring or Markdown code fence',
        '- Preserve proper nouns, example data and formatting requirements from the original',
        '- Do not add factual information that is not in the original',
      ].join('\n'),
    },
  };

  function buildLLMRequest(rawText, options = {}) {
    const src = normalize(rawText);
    const report = analyze(src);
    const lang = (options.lang && options.lang !== 'auto') ? options.lang : report.lang.primary;
    const L = LLM_TEXT[lang] || LLM_TEXT.zh;
    const missing = report.dims.filter((d) => !d.hit).map((d) => d.label);
    const missingLine = missing.length
      ? L.missing(missing.join('、'))
      : (lang === 'zh' ? '本次检测未发现明显缺失维度，请专注提升清晰度与可执行性。' : 'No dimension is obviously missing; focus on clarity and executability.');

    const messages = [
      { role: 'system', content: L.system },
      {
        role: 'user',
        content: [
          L.principles,
          missingLine,
          L.langLine,
          '原始提示词 / Original prompt:\n"""\n' + src + '\n"""',
          L.rules,
        ].join('\n\n'),
      },
    ];
    return { messages, lang, report };
  }

  // 模型偶尔会包代码围栏或加"优化后的提示词："前缀，统一剥掉
  function stripCodeFence(text) {
    let s = String(text == null ? '' : text).trim();
    const fenced = s.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
    if (fenced) s = fenced[1];
    s = s.replace(/^(优化(后)?的?提示词|优化结果|Optimiz(ed|ed)\s+prompt|Optimized)\s*[:：]\s*/i, '');
    return s.trim();
  }

  // ---- 行级 diff（LCS） --------------------------------------------------
  function diffLines(before, after) {
    const A = String(before == null ? '' : before).split('\n');
    const B = String(after == null ? '' : after).split('\n');
    const n = A.length, m = B.length;
    // O(n*m)：超过约 700×700 就放弃，退化为整段替换，避免长文本卡死主线程
    if ((n + 1) * (m + 1) > 500000) return null;

    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = A[i] === B[j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
      }
    }

    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push({ type: 'same', text: A[i] }); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) { ops.push({ type: 'del', text: A[i] }); i++; }
      else { ops.push({ type: 'add', text: B[j] }); j++; }
    }
    while (i < n) ops.push({ type: 'del', text: A[i++] });
    while (j < m) ops.push({ type: 'add', text: B[j++] });
    return ops;
  }

  return {
    version: '1.1.0',
    DIMENSIONS: DIM_DEFS.map((d) => ({ key: d.key, zh: d.zh, en: d.en })),
    detectLanguage,
    analyze,
    optimizeLocal,
    pickStyle,
    buildLLMRequest,
    stripCodeFence,
    diffLines,
  };
})();

// 顶层 const 不会自动挂到 window，导出一次供其他脚本（及调试）使用
if (typeof window !== 'undefined') window.PromptOptimizer = PromptOptimizer;
