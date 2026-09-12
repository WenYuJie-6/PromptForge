// ============================================================
// api.js —— 大模型 API 调用（统一调用层 + 框架自动选择、JSON 解析）
// ============================================================

const ANALYSIS_SYSTEM_PROMPT = `你是 JSON 输出器。你只能返回合法的 JSON 字符串，禁止返回以下内容：
- 代码块标记（\`\`\`）
- 解释性文字
- 注释
- 任何非 JSON 格式的文本
输出必须以 { 开头，以 } 结尾。`;

// LLM API Call —— 统一入口在 unified-llm.js（在线/离线自动选择）。
// 注意：此处不再定义 callLLM，避免覆盖统一入口造成自调用死循环。
// ============================================================
async function autoSelectFramework(signal = null) {
  const s = loadSettings();
  const langHint = s.lang === 'en' ? 'Respond in English.' : '用中文回复。';

  const prompt = `你是一个提示词框架选择专家。根据用户的初步想法，从以下三个框架中选择最合适的一个。

框架说明：
- CO-STAR（Context, Objective, Style, Tone, Audience, Response）
  最佳场景：需要明确上下文、受众画像、写作风格和语气的场景
  典型用途：营销文案、社交媒体内容、邮件、品牌写作
  核心优势：通过分离上下文、目标、风格、语气、受众和格式，确保输出精准匹配需求

- CREATE（Character, Request, Examples, Adjustments, Type, Extras）
  最佳场景：需要为 AI 设定角色身份、提供示例参考的场景
  典型用途：代码开发、教学辅导、创意写作、技术文档
  核心优势：通过角色扮演和示例引导，让 AI 深度理解任务语境

- BROKE（Background, Role, Objective, Key Results, Evolve）
  最佳场景：需要背景说明、可衡量目标和迭代方向的场景
  典型用途：商业分析、项目规划、系统设计、研究报告
  核心优势：通过设定可衡量的关键结果，确保输出具备可评估的质量标准

返回严格 JSON（不要包含其他文字）：
{
  "framework": "CO-STAR" 或 "CREATE" 或 "BROKE",
  "reason": "选择理由，一句话说明为什么这个框架最适合"
}

${langHint}
用户的想法：${state.userIdea}`;

  try {
    const raw = await callLLM([{ role:'user', content:prompt }], { signal });
    const result = safeParseAnalysis(raw);

    if (result.framework) {
      const fw = result.framework.toUpperCase().replace(/[^A-Z-]/g, '');
      const mapped = fw.includes('CO-STAR') ? 'costar'
                   : fw.includes('CREATE') ? 'create'
                   : fw.includes('BROKE')  ? 'broke'
                   : 'costar';
      state._autoReason = result.reason || '';
      return mapped;
    }
  } catch {}

  state._autoReason = '';
  return 'costar';
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch {}
  try {
    const m = text.match(/\{[\s\S]*?\}/);
    if (m) return JSON.parse(m[0]);
  } catch {}
  return null;
}

function safeParseAnalysis(raw) {
  // 第一层：直接解析
  try { return JSON.parse(raw); } catch {}

  // 第二层：提取代码块中的 JSON
  try {
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) return JSON.parse(m[1].trim());
  } catch {}

  // 第三层：贪婪匹配最外层花括号（注意是贪婪 * 而非非贪婪 *?）
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch {}

  // 兜底：降级为直接生成，跳过追问
  console.warn('LLM 返回内容无法解析为 JSON，降级为直接生成:', raw.slice(0, 200));
  return { complete: true, _fallback: true };
}

// ============================================================