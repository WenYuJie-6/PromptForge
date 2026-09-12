// ============================================================
// frameworks.js —— 框架模板与预设数据（CO-STAR / CREATE / BROKE 定义、模板库、API 服务商预设）
// ============================================================

// DATA: Framework Definitions
// ============================================================
//
// buildPrompt(idea, structuredData) 的第二个参数允许两种形态：
//   - string：已经是排好版的「字段: 回答」文本（app.js 走的就是这条路径）
//   - object：{ 字段名: 回答 }，本文件会自行格式化成同样的文本
// 早期实现直接把参数插进模板字符串，传对象时会变成 "[object Object]"，
// 用户的全部结构化回答被静默丢弃。统一在这里做一次归一化，杜绝该类问题。
function normalizeStructuredData(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data.trim();
  if (Array.isArray(data)) {
    return data.filter(Boolean).map((x) => normalizeStructuredData(x)).filter(Boolean).join('\n');
  }
  if (typeof data === 'object') {
    const lines = Object.keys(data)
      .map((k) => [k, data[k]])
      // 跳过空值，避免输出一堆「字段: 」空行
      .filter(([, v]) => v != null && String(v).trim() !== '')
      .map(([k, v]) => `${k}: ${String(v).trim()}`);
    return lines.join('\n');
  }
  return String(data);
}

// 把「已收集的信息」段落统一生成一次，避免 7 个框架各写一遍（也避免漏改）
function structuredBlock(data) {
  const text = normalizeStructuredData(data);
  if (!text) return '';
  return `\n已收集的信息：\n${text}\n\n请充分利用以上信息，对于未覆盖的部分进行合理补全。\n`;
}

const FRAMEWORKS = {
  costar: {
    name: 'CO-STAR',
    desc: '结构化提示词的经典框架',
    fields: ['Context 上下文', 'Objective 目标', 'Style 风格', 'Tone 语气', 'Audience 受众', 'Response 输出格式'],
    buildPrompt(idea, structuredData) {
      return `请基于 CO-STAR 框架，将用户的初步想法优化为一段高质量的提示词。

CO-STAR 框架要求包含以下 6 个部分：
- C (Context 上下文): 提供充足的背景信息，包括场景、行业、平台等
- O (Objective 目标): 明确具体的任务目标，用户希望 AI 完成什么
- S (Style 风格): 指定写作风格、参考对象或文体类型
- T (Tone 语气): 设定语气情感，如专业、幽默、温暖、正式等
- A (Audience 受众): 定义目标受众的画像、年龄、兴趣、知识水平
- R (Response 输出格式): 规定输出的结构、长度、格式要求

用户的初步想法：${idea}${structuredBlock(structuredData)}

要求：
1. 直接输出优化后的完整提示词（用户可以直接复制使用）
2. 不要输出框架分析过程、框架名称标注或解释说明
3. 提示词应自然流畅，不要出现 CO-STAR 等框架标签
4. 如果用户输入是中文，提示词用中文；如果是英文，提示词用英文`;
    }
  },
  create: {
    name: 'CREATE',
    desc: '角色驱动的提示词框架',
    fields: ['Character 角色', 'Request 请求', 'Examples 示例', 'Adjustments 调整', 'Type 类型', 'Extras 附加'],
    buildPrompt(idea, structuredData) {
      return `请基于 CREATE 框架，将用户的初步想法优化为一段高质量的提示词。

CREATE 框架要求包含以下 6 个部分：
- C (Character): 为 AI 分配合适的角色和身份，包含专业背景、经验水平
- R (Request): 清晰陈述任务要求，具体说明 AI 需要做什么
- E (Examples): 提供参考示例或期望范例，帮助 AI 理解目标水准
- A (Adjustments): 设定调整和优化的方向，明确质量标准
- T (Type): 指定期望的输出类型和格式（如代码、文档、对话、列表等）
- E (Extras): 补充额外的上下文、约束条件或特殊要求

用户的初步想法：${idea}${structuredBlock(structuredData)}

要求：
1. 直接输出优化后的完整提示词（用户可以直接复制使用）
2. 不要输出框架分析过程、框架名称标注或解释说明
3. 提示词应自然流畅，不要出现 CREATE 等框架标签
4. 如果用户输入是中文，提示词用中文；如果是英文，提示词用英文`;
    }
  },
  broke: {
    name: 'BROKE',
    desc: '目标导向的提示词框架',
    fields: ['Background 背景', 'Role 角色', 'Objective 目标', 'Key Results 关键成果', 'Evolve 迭代'],
    buildPrompt(idea, structuredData) {
      return `请基于 BROKE 框架，将用户的初步想法优化为一段高质量的提示词。

BROKE 框架要求包含以下 5 个部分：
- B (Background): 提供充分的背景信息和问题域描述，让 AI 理解上下文
- R (Role): 定义 AI 应扮演的角色，包括专业身份和能力范围
- O (Objective): 明确具体的任务目标，目标应可操作、可执行
- K (Key Results): 设定可衡量的关键成果指标，用于评估输出质量
- E (Evolve): 包含迭代和优化的方向，说明如何改进和调整

用户的初步想法：${idea}${structuredBlock(structuredData)}

要求：
1. 直接输出优化后的完整提示词（用户可以直接复制使用）
2. 不要输出框架分析过程、框架名称标注或解释说明
3. 提示词应自然流畅，不要出现 BROKE 等框架标签
4. 如果用户输入是中文，提示词用中文；如果是英文，提示词用英文`;
    }
  },

  // ---- 多模态框架：目标模型不是对话式 LLM，而是文生图 / TTS / 文生视频 / 文生音乐模型。
  // 这类模型的提示词有各自的"行话"（镜头语言、音色描述、BPM 等），所以单独给框架，
  // 且都要强调"输出是给生成模型吃的 prompt，不是解释"。
  image: {
    name: 'IMAGE',
    desc: '文生图 / 图生图提示词框架',
    modality: 'image',
    fields: ['Subject 主体', 'Style 风格', 'Composition 构图', 'Lighting 光照', 'Details 细节', 'Params 参数'],
    buildPrompt(idea, structuredData) {
      return `请基于 IMAGE 框架，把用户的想法优化成一段可以直接喂给文生图模型（Midjourney / Stable Diffusion / Flux / 即梦 / 可图）的提示词。

IMAGE 框架要求覆盖以下要素：
- Subject 主体：画面的核心对象，包含外形、材质、颜色、姿态、表情、数量等可视觉化的描述
- Style 风格：艺术流派、参考艺术家或媒介（如 赛博朋克 / 水彩 / 3D 渲染 / 胶片摄影 / 复古动漫）
- Composition 构图：视角与取景（特写 / 全身 / 俯视 / 广角）、主体在画面中的位置、景深
- Lighting 光照：光源类型与氛围（黄金时刻 / 伦勃朗光 / 霓虹逆光 / 柔光棚拍）
- Details 细节：背景环境、天气、纹理、氛围元素，以及需要避免的东西
- Params 参数：画幅比例、风格化程度、清晰度等（如 --ar 16:9 --stylize 250）

用户的初步想法：${idea}${structuredBlock(structuredData)}

要求：
1. 直接输出可直接粘贴使用的图像提示词，不要输出框架分析、要素清单或解释说明
2. 提示词要**具体到可被渲染**：用「磨砂玻璃质感的半透明外壳」而不是「很好看的外壳」
3. 按「主体 → 风格 → 构图 → 光照 → 细节 → 参数」的顺序自然组织成一段（或逗号分隔的分句）
4. 主体描述用中文时保持中文，但通用的风格/技术关键词（如 cinematic lighting、bokeh、--ar 16:9）可保留英文
5. 不要编造原想法中不存在的具体品牌或真人姓名`;
    }
  },

  voice: {
    name: 'VOICE',
    desc: '配音 / 语音合成脚本框架',
    modality: 'voice',
    fields: ['Script 文案', 'Voice 音色', 'Emotion 情绪', 'Pacing 节奏', 'Direction 演绎指导', 'Format 交付格式'],
    buildPrompt(idea, structuredData) {
      return `请基于 VOICE 框架，把用户的想法整理成一份可以直接交给配音员或 TTS 引擎（如 ElevenLabs / 火山语音 / Azure TTS / CosyVoice）使用的配音方案。

VOICE 框架要求包含：
- Script 文案：需要朗读的**完整成品文字**，口语化、断句清楚
- Voice 音色：性别、年龄段、音色特质（如 温暖磁性 / 清亮少女 / 沉稳播报）、语种与口音
- Emotion 情绪：整体情绪基调，以及情绪随内容的变化曲线
- Pacing 节奏：语速（字/分钟）、停顿位置、重音与强调词
- Direction 演绎指导：给演绎者可执行的提示，如「'但是' 之后停 0.5 秒」
- Format 交付格式：输出采样率、声道、时长预估、是否需要多角色分轨

用户的初步想法：${idea}${structuredBlock(structuredData)}

要求：
1. 直接输出可交付的配音方案，包含**可直接朗读的文案全文**，不要只给提纲或要点
2. 不要输出框架分析过程或框架名称标注
3. 停顿/重音用括号内联标注，例如「（停顿 0.5 秒）」「（重读）」，方便 TTS 引擎解析
4. 如果涉及多角色对话，用「角色名：台词」的格式分行书写，并分别注明音色
5. 如果用户输入是中文，输出用中文；如果是英文，输出用英文`;
    }
  },

  video: {
    name: 'VIDEO',
    desc: '文生视频 / 图生视频分镜框架',
    modality: 'video',
    fields: ['Shot 镜头', 'Subject 主体与动作', 'Camera 运镜', 'Duration 时长', 'Transition 转场', 'Audio 声音'],
    buildPrompt(idea, structuredData) {
      return `请基于 VIDEO 框架，把用户的想法优化成一份可以直接用于文生视频 / 图生视频模型（可灵 / Runway / Sora / 即梦 / Veo）的分镜提示词。

VIDEO 框架要求包含：
- Shot 镜头：景别与镜头类型（大远景 / 中景 / 特写 / 过肩镜头）
- Subject 主体与动作：画面里是谁/什么，在做什么，动作的起始与结束状态
- Camera 运镜：镜头如何运动（推 / 拉 / 摇 / 移 / 跟拍 / 环绕 / 手持晃动 / 固定机位）
- Duration 时长：每个分镜的秒数，以及整片总时长
- Transition 转场：分镜之间如何衔接（硬切 / 叠化 / 匹配剪辑 / 黑场）
- Audio 声音：环境音、背景音乐、音效、旁白（如模型支持音频同步生成）

用户的初步想法：${idea}${structuredBlock(structuredData)}

要求：
1. 按分镜输出，每个分镜标明序号、时长、景别、运镜与画面内容
2. 画面描述要写**动态过程**（"从…逐渐变成…"），而不是静态画面罗列
3. 提示词要具体到可被渲染：说明材质、光线、天气、人物动作幅度
4. 不要输出框架分析过程或框架名称标注
5. 如果用户输入是中文，输出用中文；如果是英文，输出用英文`;
    }
  },

  music: {
    name: 'MUSIC',
    desc: '文生音乐 / 配乐提示词框架',
    modality: 'music',
    fields: ['Genre 风格', 'Instrumentation 配器', 'Mood 情绪', 'Tempo 速度与节拍', 'Structure 结构', 'Production 制作质感'],
    buildPrompt(idea, structuredData) {
      return `请基于 MUSIC 框架，把用户的想法优化成一段可以直接喂给文生音乐模型（Suno / Udio / Stable Audio）的提示词。

MUSIC 框架要求包含：
- Genre 风格：音乐流派与子流派（如 城市流行 / Lo-fi Hip-hop / 史诗管弦 / 国风电子）
- Instrumentation 配器：主奏乐器、节奏组、色彩乐器
- Mood 情绪：情绪基调与能量起伏
- Tempo 速度与节拍：BPM、拍号、律动感（如 90 BPM、4/4、摇摆感）
- Structure 结构：段落编排（前奏 → 主歌 → 副歌 → 桥段 → 尾声）及各段时长
- Production 制作质感：混音风格、空间感、年代感（如 80 年代模拟磁带感 / 现代干净制作）

用户的初步想法：${idea}${structuredBlock(structuredData)}

要求：
1. 直接输出可直接粘贴使用的音乐提示词，风格标签用英文（模型对英文音乐术语识别更准），其余描述跟随用户语言
2. 如果用户需要歌词，按 [Verse] / [Chorus] / [Bridge] 的段落标记写出**完整歌词**
3. 明确给出 BPM 与调性建议
4. 不要输出框架分析过程或框架名称标注`;
    }
  }
};

// DATA: Per-Framework Analysis Dimensions
// ============================================================
const FRAMEWORK_DIMENSIONS = {
  costar: `
评估维度（CO-STAR 框架）：
- Context：背景信息是否充足？
- Objective：任务目标是否具体？
- Style：写作风格是否指定？
- Tone：语气情感是否明确？
- Audience：目标受众画像是否清晰？
- Response：输出格式和结构是否确定？`,

  create: `
评估维度（CREATE 框架）：
- Character：是否需要设定 AI 角色？角色细节是否充分？
- Request：任务描述是否足够清晰？
- Examples：是否有参考示例或期望范例？
- Adjustments：质量标准和改进方向是否明确？
- Type：输出类型是否确定（如代码/文档/对话）？
- Extras：是否有额外上下文或约束条件？`,

  broke: `
评估维度（BROKE 框架）：
- Background：背景信息和问题域是否描述清楚？
- Role：AI 需要扮演的角色是否定义？
- Objective：目标是否可操作？
- Key Results：是否有可衡量的成功标准？
- Evolve：是否说明了迭代或优化的方向？`,

  image: `
评估维度（IMAGE 框架）：
- Subject：画面主体是否具体到可被渲染（外形/材质/颜色/姿态）？
- Style：艺术风格或媒介是否指定？
- Composition：视角、取景和主体位置是否明确？
- Lighting：光源类型与氛围是否描述？
- Details：背景环境、氛围元素、需要避免的东西是否交代？
- Params：画幅比例等生成参数是否给出？`,

  voice: `
评估维度（VOICE 框架）：
- Script：需要朗读的完整成品文案是否已有？
- Voice：音色（性别/年龄/特质/语种）是否指定？
- Emotion：情绪基调及变化曲线是否说明？
- Pacing：语速、停顿、重音是否标注？
- Direction：给演绎者的可执行指导是否给出？
- Format：采样率/声道/时长/多轨等交付格式是否确定？`,

  video: `
评估维度（VIDEO 框架）：
- Shot：景别与镜头类型是否明确？
- Subject：主体及其动作的起止状态是否描述？
- Camera：运镜方式（推拉摇移/跟拍/环绕）是否指定？
- Duration：单镜与总时长是否给出？
- Transition：分镜之间如何衔接是否说明？
- Audio：环境音、配乐、旁白是否交代？`,

  music: `
评估维度（MUSIC 框架）：
- Genre：音乐流派与子流派是否明确？
- Instrumentation：主奏与配器是否指定？
- Mood：情绪基调与能量起伏是否说明？
- Tempo：BPM、拍号、律动感是否给出？
- Structure：段落编排及各段时长是否规划？
- Production：混音风格与制作质感是否描述？`
};

// ============================================================
// DATA: Templates
// ============================================================
// 注意：idea 必须是**完整可用**的示例，不能留 `...` 占位符。
// 曾经 10/14 个模板预填着「主题是...」，用户点开不改直接生成，等于把半成品丢给模型。
// tip 用于提示用户把哪一部分替换成自己的内容。
const TEMPLATES = [
  { id:'xhs', cat:'自媒体', name:'小红书种草文案', desc:'生成吸引眼球的小红书笔记，适合种草、攻略、分享类内容',
    idea:'帮我写一篇小红书种草笔记，推荐一款百元内的清爽防晒霜，目标读者是大学生和通勤族，要有真实使用感',
    tip:'把「防晒霜」换成你的产品，「大学生和通勤族」换成你的目标读者', framework:'costar' },

  { id:'bili', cat:'自媒体', name:'B站视频脚本', desc:'结构完整的视频口播脚本，包含开场、内容、结尾',
    idea:'帮我写一个B站知识科普视频的脚本，主题是「为什么飞机能飞起来」，时长 5 分钟，面向初中生，要有开场钩子和结尾引导三连',
    tip:'把主题、时长和受众换成你的', framework:'create' },

  { id:'wechat', cat:'自媒体', name:'公众号深度文章', desc:'有深度的长文，适合观点输出、行业分析',
    idea:'帮我写一篇公众号深度文章，探讨 2026 年新能源车行业的趋势与隐忧，读者是汽车行业从业者，要有数据支撑和独立观点',
    tip:'把行业和读者画像换成你的', framework:'costar' },

  // 原绑定 BROKE：BROKE 的 K 是「可衡量的关键成果」，用在调试上会逼模型编造指标。
  // 调试更适合 CREATE（角色 = 资深工程师 + 复现步骤 + 期望输出）。
  { id:'debug', cat:'代码开发', name:'Bug调试助手', desc:'描述Bug现象，AI帮你分析原因并给出修复方案',
    idea:'我的 Node 18 服务偶发报 Cannot read properties of undefined，只在并发请求下复现，帮我定位可能的原因并给出排查步骤',
    tip:'把报错信息、语言/框架版本、复现条件换成你的实际情况（复现条件越具体，定位越准）', framework:'create' },

  { id:'review', cat:'代码开发', name:'代码审查', desc:'对代码片段进行全面审查，指出潜在问题',
    idea:'帮我 review 下面这段 Node 接口代码，重点看 SQL 注入风险、N+1 查询和错误处理，按严重程度排序并给出改法',
    tip:'把关注点换成你这次最在意的维度（性能 / 安全 / 可读性）', framework:'create' },

  { id:'arch', cat:'代码开发', name:'架构设计', desc:'帮你设计系统架构，输出技术方案文档',
    idea:'我需要设计一个短链服务，要求支持日均 1000 万次跳转、P99 延迟低于 50ms，请给出整体架构、存储选型和扩容方案',
    tip:'把场景和量化指标换成你的（BROKE 框架靠「关键成果」驱动，指标越具体方案越落地）', framework:'broke' },

  { id:'sql', cat:'数据分析', name:'SQL查询生成', desc:'用自然语言描述需求，生成SQL查询语句',
    idea:'帮我写一个 PostgreSQL 查询，统计 2026 年每个月的订单总额和环比增长率，结果按月份排序',
    tip:'把数据库类型和口径换成你的（MySQL / Postgres / Hive 语法差别很大，务必写明）', framework:'create' },

  { id:'report', cat:'数据分析', name:'数据报告撰写', desc:'基于数据结果生成专业的分析报告',
    idea:'根据这份季度销售数据帮我写一份分析报告，读者是公司管理层，重点说清下滑的原因和下一步建议，控制在 1200 字内',
    tip:'贴入你的真实数据，并指定读者和字数', framework:'costar' },

  { id:'interview', cat:'角色扮演', name:'模拟面试官', desc:'扮演面试官，帮你进行模拟面试训练',
    idea:'请扮演一位资深后端技术面试官，对我进行一场 30 分钟的 Java 中级岗位模拟面试，一次问一个问题并给我的回答打分',
    tip:'把岗位方向、时长和「一次一问/连续追问」换成你要的形式', framework:'create' },

  // 原绑定 BROKE：人生困惑没有「可衡量关键成果」，BROKE 会逼出「3 条可量化指标」这类生硬输出。
  { id:'mentor', cat:'角色扮演', name:'人生导师', desc:'扮演经验丰富的人生导师，给出深度建议',
    idea:'我想请你扮演一位人生导师，我在「继续留在做大厂做技术」和「去早期创业公司」之间很纠结，请先问我几个关键问题再给建议',
    tip:'把纠结的具体选项写出来（越具体，建议越有针对性）', framework:'create' },

  { id:'product', cat:'商业文案', name:'产品详情页文案', desc:'高转化率的产品介绍文案',
    idea:'帮我写一个便携榨汁杯的详情页文案，主打通勤和办公室场景，客单价 199 元，要突出痛点和差异化卖点',
    tip:'把产品、场景和客单价换成你的', framework:'costar' },

  { id:'email', cat:'商业文案', name:'营销邮件', desc:'高打开率和点击率的营销邮件',
    idea:'帮我写一封营销邮件，向 90 天未活跃的免费用户推广新上线的报表功能，主题行要抓人，正文控制在 200 字内',
    tip:'把目标人群和推广点换成你的', framework:'costar' },

  { id:'paper', cat:'学术写作', name:'论文润色', desc:'提升学术论文的语言质量和表达精准度',
    idea:'帮我润色下面这段论文摘要，方向是深度学习的医学图像分割，保持学术严谨、符合 SCI 期刊的表达习惯，不要改变原意',
    tip:'贴入你的原文，并说明目标期刊或学科领域', framework:'create' },

  { id:'literature', cat:'学术写作', name:'文献综述助手', desc:'帮你梳理研究领域的文献脉络',
    idea:'帮我整理大语言模型幻觉检测方向的研究现状，覆盖 2023-2026 年的主要方法，按技术路线分类并指出尚未解决的问题',
    tip:'把研究方向和时间范围换成你的', framework:'broke' },

  // ============ 图像生成 ============
  { id:'img-product', cat:'图像生成', name:'产品主图', desc:'电商产品图提示词，突出质感与卖点',
    idea:'帮我生成一张便携榨汁杯的电商主图提示词，磨砂白外壳配玫瑰金按键，放在浅灰色石纹台面上，旁边有切开的橙子和薄荷叶，明亮柔和的棚拍光，突出质感和高级感',
    tip:'把产品、材质和配色换成你的（材质词越具体，AI 出图越准，比如"磨砂"比"好看"有用）', framework:'image' },

  { id:'img-portrait', cat:'图像生成', name:'人像写真', desc:'人像摄影提示词，含光影与镜头语言',
    idea:'帮我生成一个复古胶片感人像提示词，一位二十多岁的东亚女性在雨天的旧书店里翻书，穿米色针织衫，暖黄色钨丝灯从侧后方打过来，浅景深，背景有虚化的书架',
    tip:'描述人物时避免指定真实姓名；想要特定气质就写"清冷/知性/元气"这类词', framework:'image' },

  { id:'img-scene', cat:'图像生成', name:'场景概念图', desc:'游戏/影视概念场景的氛围图提示词',
    idea:'帮我生成一张场景概念图提示词：一座建在悬崖上的赛博朋克城市，空中漂浮着巨大的全息鲸鱼，暴雨天气，霓虹灯牌倒映在湿漉漉的街道上，广角俯视，电影感构图',
    tip:'把地点、天气和"最抓眼的那个元素"换成你的，那个元素决定图有没有记忆点', framework:'image' },

  { id:'img-logo', cat:'图像生成', name:'Logo与图标', desc:'品牌标识类提示词，强调简洁与可识别',
    idea:'帮我生成一个咖啡烘焙品牌的 Logo 提示词，想要极简线条风格，主体是一颗咖啡豆和火焰结合的图形，单色扁平化，纯白背景，适合印在包装袋和杯子上',
    tip:'Logo 类务必强调"扁平/单色/矢量感"，否则 AI 容易生成照片质感的复杂图', framework:'image' },

  // ============ 配音 / 语音合成 ============
  { id:'voice-narration', cat:'配音语音', name:'纪录片旁白', desc:'沉稳叙述型配音脚本，含停顿与重音标注',
    idea:'帮我写一段 60 秒的自然纪录片旁白配音稿，讲一只雪豹在高原清晨巡视自己领地的过程，要沉稳磁性的男中音，语速偏慢，有画面感和庄重感',
    tip:'把题材、时长、音色换成你的；停顿和重音我已在稿子里标注，可直接给 TTS 引擎', framework:'voice' },

  { id:'voice-ads', cat:'配音语音', name:'广告口播', desc:'高转化率的带货口播稿，节奏明快',
    idea:'帮我写一段 30 秒的短视频带货口播稿，卖的是一款百元内的便携电动牙刷，受众是大学生，要口语化、节奏快、有紧迫感，结尾要有明确的行动号召',
    tip:'把产品、时长、受众换成你的；口播稿越口语越好，避免书面语', framework:'voice' },

  { id:'voice-audiobook', cat:'配音语音', name:'有声书分角色', desc:'多角色对白配音，自动分轨标注',
    idea:'帮我改编一段有声书配音稿，场景是一个老侦探在雨夜的办公室质问一个年轻嫌疑人，需要两个角色：五十多岁沙哑疲惫的男声，和二十出头紧张但强作镇定的男声，请分出对白',
    tip:'多角色务必写清每个角色的年龄和音色差异，否则听起来会分不出人', framework:'voice' },

  { id:'voice-course', cat:'配音语音', name:'课程讲解', desc:'教学类配音稿，强调清晰与引导性',
    idea:'帮我写一段 3 分钟的线上课程讲解配音稿，讲清楚"什么是复利"，受众是完全没金融基础的大学生，要求语气亲切像面对面聊天，在关键概念处留出停顿让学员思考',
    tip:'把知识点和受众基础换成你的（"零基础"和"有基础"讲法完全不同）', framework:'voice' },

  // ============ 视频生成 ============
  { id:'video-short', cat:'视频生成', name:'短视频分镜', desc:'15-60 秒短视频的完整分镜脚本',
    idea:'帮我写一个 30 秒咖啡品牌短视频的分镜脚本，从咖啡豆特写开始，到咖啡馆里顾客喝下第一口的满足表情结束，整体温暖治愈，最后 3 秒出品牌 Logo',
    tip:'把产品和你想要的"情绪走向"换成你的；分镜里我会标好每一镜的运镜和时长', framework:'video' },

  { id:'video-product', cat:'视频生成', name:'产品演示视频', desc:'展示产品功能与卖点的演示片',
    idea:'帮我写一段产品演示视频的分镜，展示一款折叠电动滑板车如何在 5 秒内折叠、能放进汽车后备箱，时长 20 秒，节奏利落，要突出"省空间"这个核心卖点',
    tip:'演示片一定要说清"要证明的那一个卖点"是什么，别贪多', framework:'video' },

  { id:'video-mv', cat:'视频生成', name:'音乐短片MV', desc:'配合音乐节拍的分镜设计',
    idea:'帮我写一段 45 秒音乐短片的分镜，风格是夏日城市夜晚的青春感，镜头跟随一个骑自行车的少年穿过霓虹街道，画面切换要卡在音乐的重拍上',
    tip:'把风格和主角动作换成你的；卡点的位置我会在分镜里标出对应的节拍段落', framework:'video' },

  { id:'video-anime', cat:'视频生成', name:'动画分镜', desc:'动漫风格短片的镜头设计',
    idea:'帮我写一段日式动画风格的分镜，场景是一个少女在夏日祭典上抬头看烟花绽放，从背影特写拉到全景，时长 15 秒，要有那种"时间慢下来"的唯美氛围',
    tip:'把场景和你想要的"名场面"换成你的；动画风务必写清是 2D 手绘还是 3D', framework:'video' },

  // ============ 音乐生成 ============
  { id:'music-bgm', cat:'音乐生成', name:'视频配乐', desc:'按视频情绪定制的背景音乐提示词',
    idea:'帮我生成一段视频背景音乐的提示词，是给一个"清晨城市苏醒"的延时摄影短片配的，想要轻快的钢琴加弦乐，逐渐层层递进到明亮的情绪，时长 90 秒',
    tip:'把画面情绪和时长换成你的；配乐要写清"情绪是怎么变化的"，静态情绪会显得平淡', framework:'music' },

  { id:'music-song', cat:'音乐生成', name:'原创歌曲', desc:'含完整歌词的歌曲生成提示词',
    idea:'帮我写一首城市流行风格的原创歌曲，主题是"毕业那天的天台"，要有完整的中文歌词，情绪从怀念到释然，节奏是轻快的中板，适合女声独唱',
    tip:'把主题、情绪和演唱者换成你的；歌词我会按 [Verse]/[Chorus] 分段写好', framework:'music' },

  { id:'music-brand', cat:'音乐生成', name:'品牌主题曲', desc:'品牌调性统一的听觉标识',
    idea:'帮我写一段 15 秒的品牌音频标识提示词，品牌是做东方茶饮的，想要用古筝和电子音色融合，传达"传统与现代交汇"的感觉，结尾要有一个干净利落的收束音',
    tip:'把品牌调性和乐器换成你的；15 秒的标识曲重点在"最后那个记忆点"', framework:'music' },
];

const CATEGORIES = ['全部', ...new Set(TEMPLATES.map(t => t.cat))];

// ============================================================
// API Presets
// ============================================================
const API_PRESETS = {
  deepseek: { endpoint:'https://api.deepseek.com/v1', model:'deepseek-chat', hint:'需要 API Key' },
  moonshot: { endpoint:'https://api.moonshot.cn/v1', model:'moonshot-v1-8k', hint:'需要 API Key' },
  qwen:     { endpoint:'https://dashscope.aliyuncs.com/compatible-mode/v1', model:'qwen-plus', hint:'需要 API Key' },
  zhipu:    { endpoint:'https://open.bigmodel.cn/api/paas/v4', model:'glm-4-flash', hint:'需要 API Key' },
  openai:   { endpoint:'https://api.openai.com/v1', model:'gpt-4o-mini', hint:'需要 API Key' },
  ollama:   { endpoint:'http://localhost:11434/v1', model:'qwen2.5:7b', hint:'需要本地运行 Ollama' },
};

// ============================================================