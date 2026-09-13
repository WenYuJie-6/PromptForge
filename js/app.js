// ============================================================
// app.js —— 入口与主逻辑（全局状态、优化主流程、评分 / 对比 / 分享 / 历史 / 模板 / 设置 UI、事件绑定与初始化）
// ============================================================

// ============================================================
// State
// ============================================================
const state = {
  currentView: 'new',
  selectedFramework: 'auto',
  userIdea: '',
  followUpAnswers: {},
  questions: [],
  outputText: '',
  outputFramework: '',
  mdView: false,
};

// 追问阈值配置
const SENSITIVITY = { high: 1, medium: 2, low: 3 };
const SKIP_COUNT_KEY = 'pf_skip_count';
// 必须即时读取：过去这里缓存成常量，skipQuestions 只改 localStorage，
// 导致同一会话内"跳过 3 次自动降灵敏度"永远不生效。
function getSkipCount() {
  const n = parseInt(localStorage.getItem(SKIP_COUNT_KEY) || '0', 10);
  return Number.isFinite(n) ? n : 0;
}

// 进行中的请求控制器，用于"停止生成"
const activeControllers = new Set();

// ============================================================
// Core Logic
// ============================================================
async function startOptimize() {
  const idea = document.getElementById('user-idea').value.trim();
  if (!idea) { toast('请输入你的初步想法'); return; }

  state.userIdea = idea;
  const s = loadSettings();
  // 未配置 API 时，若内置在线服务可用就直接用它，做到「装好即用」
  const onlineCfg = typeof resolveOnlineConfig === 'function' ? resolveOnlineConfig(s) : null;
  if (!s.endpoint && !(onlineCfg && onlineCfg.source === 'builtin')) {
    toast('请先在设置中配置 API');
    switchView('settings');
    return;
  }

  showStep('generating');
  document.getElementById('loading-text').textContent = '正在分析想法并选择框架...';

  const controller = new AbortController();
  activeControllers.add(controller);

  try {
    // Step 1: 确定框架——用户手动选的就用用户的，否则让 AI 推荐
    let fw = state.selectedFramework;
    if (fw === 'auto') {
      fw = await autoSelectFramework(controller.signal);
    }
    state.selectedFramework = fw; // 锁定框架，generateOptimized 不再重复选
    state.outputFramework = fw;

    // Step 2: 用该框架的维度做针对性追问
    document.getElementById('loading-text').textContent = `正在用 ${FRAMEWORKS[fw].name} 框架评估完整性...`;

    const lang = s.lang || 'zh';
    const langHint = lang === 'en' ? 'Please respond in English.' : '请用中文回复。';

    const dimensionPrompt = `你是一个专业的提示词工程师。分析用户的想法是否足够具体来生成高质量的提示词。

${FRAMEWORK_DIMENSIONS[fw]}

按该框架的维度逐一评估（每个维度 true/false），识别缺失项。

返回严格 JSON（不要包含其他文字）：
{
  "complete": true/false,
  "missing": ["缺失维度名称1", "缺失维度名称2", "..."],
  "questions": ["针对缺失维度的具体追问1", "具体追问2", "具体追问3"]
}

规则：
- questions 最多 3 个，按重要性排序
- 每个问题必须具体可操作，禁止笼统提问
- 如果所有维度都已覆盖，questions 返回空数组

${langHint}
用户的想法：${idea}`;

    const analysisRaw = await callLLM([
      { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
      { role: 'user', content: dimensionPrompt }
    ], { signal: controller.signal });
    const analysis = safeParseAnalysis(analysisRaw);

    if (analysis._fallback) {
      toast('分析结果解析失败，已跳过追问直接生成');
    }

    // 追问阈值：用户灵敏度设置 + 跳过频率自适应
    const skips = getSkipCount();
    const threshold = skips >= 3
      ? SENSITIVITY.low
      : SENSITIVITY[s.sensitivity || 'medium'];

    if (!analysis._fallback
        && analysis.complete === false
        && analysis.missing
        && analysis.missing.length >= threshold) {
      state.questions = analysis.questions || [];
      showQuestions(analysis.questions || []);
      if (skips >= 3) {
        toast('（检测到你多次跳过追问，当前已自动降低灵敏度）');
      }
    } else {
      await generateOptimized();
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      showStep('input');
      toast('已停止');
    } else {
      showStep('input');
      toast('分析失败: ' + err.message);
    }
  } finally {
    activeControllers.delete(controller);
  }
}

async function submitAnswers() {
  const answers = {};
  state.questions.forEach((q, i) => {
    const el = document.getElementById(`q-${i}`);
    answers[q] = el ? el.value.trim() : '';
  });
  state.followUpAnswers = answers;
  await generateOptimized();
}

function skipQuestions() {
  const count = getSkipCount() + 1;
  localStorage.setItem(SKIP_COUNT_KEY, String(count));
  state.followUpAnswers = {};
  if (count === 3) {
    toast('已连续跳过 3 次追问，后续将自动降低追问灵敏度（可在设置中调整）');
  }
  generateOptimized();
}

async function generateOptimized() {
  showStep('generating');
  document.getElementById('loading-text').textContent = '正在套用框架优化提示词...';
  const scorePanel = document.getElementById('score-panel');
  if (scorePanel) scorePanel.classList.add('hidden');

  const controller = new AbortController();
  activeControllers.add(controller);

  try {
    // 框架已在 startOptimize 锁定，直接用
    const fw = state.selectedFramework;
    state.outputFramework = fw;
    const fwInfo = FRAMEWORKS[fw];

    // 整理追问答案
    const answersText = Object.entries(state.followUpAnswers)
      .filter(([_, v]) => v.trim())
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');

    // 有追问答案时先做结构化映射（失败不阻塞，降级用原始 answersText）
    let finalAnswers = answersText || null;
    if (answersText) {
      document.getElementById('loading-text').textContent = '正在结构化回答...';
      try {
        const mapPrompt = `你是提示词结构化助手。将用户回答映射到 ${fwInfo.name} 框架字段。

框架字段：${fwInfo.fields.join('、')}

用户回答：
${answersText}

返回 JSON（不要包含其他文字）：
{
  "mapped": { "字段名": "对应的用户回答内容" },
  "unmapped": ["无法映射的额外信息"]
}

规则：
- 只映射用户明确回答了的问题，留空的回答不要映射
- unmapped 放无法对应到任何框架字段的额外信息
- 不要编造或改写用户原意`;

        const mapRaw = await callLLM([
          { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
          { role: 'user', content: mapPrompt }
        ], { signal: controller.signal });
        const structured = safeParseAnalysis(mapRaw);
        if (!structured._fallback && structured.mapped) {
          finalAnswers = Object.entries(structured.mapped)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n');
          if (structured.unmapped?.length) {
            finalAnswers += '\n\n额外信息：\n' + structured.unmapped.join('\n');
          }
        }
      } catch (err) {
        console.warn('结构化映射失败，降级使用原始回答:', err.message);
      }
    }

    const prompt = fwInfo.buildPrompt(state.userIdea, finalAnswers);
    let firstChunk = true;
    const result = await callLLM([{ role:'user', content:prompt }], {
      stream: true,
      signal: controller.signal,
      onUpdate: (t) => {
        state.outputText = t;
        if (firstChunk) {
          firstChunk = false;
          showStreamingMeta();
          showStep('output');
        }
        onUpdateStreaming(t);
      },
    });

    state.outputText = result || state.outputText;
    showOutput(state.outputText, fw);
  } catch (err) {
    if (err.name === 'AbortError') {
      if (state.outputText) {
        showOutput(state.outputText, state.outputFramework);
        toast('已停止生成，保留已生成的部分');
      } else {
        showStep('input');
        toast('已停止生成');
      }
      return;
    }
    showStep('input');
    toast('生成失败: ' + err.message);
  } finally {
    activeControllers.delete(controller);
  }
}

function stopGeneration() {
  if (activeControllers.size === 0 && !OfflineLLM?.isBusy()) {
    toast('当前没有进行中的生成');
    return;
  }
  
  // 停止在线流式生成
  activeControllers.forEach(c => c.abort());
  activeControllers.clear();
  
  // 停止离线生成
  if (OfflineLLM?.isBusy()) {
    OfflineLLM.stopGeneration();
    toast('已停止离线生成');
  }
  
  // 更新UI状态 - 隐藏所有停止按钮
  const stopBtns = ['btn-stop', 'btn-stop-2', 'btn-stop-3'].map(id => document.getElementById(id));
  stopBtns.forEach(btn => {
    if (btn) btn.style.display = 'none';
  });
}

// Framework Compare 框架对比
// ============================================================
let compareRunning = false;
const compareOutputs = {};

function initCompare() {
  const ta = document.getElementById('cmp-idea');
  if (!ta.value.trim() && state.userIdea) ta.value = state.userIdea;
  renderCompareSkeleton();
}

function openCompare() {
  switchView('compare');
  initCompare();
}

function renderCompareSkeleton() {
  const grid = document.getElementById('compare-grid');
  if (!grid) return;
  grid.innerHTML = Object.entries(FRAMEWORKS).map(([key, fw]) => `
    <div class="compare-col">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h3>${fw.name}</h3>
        <span class="cmp-status" id="st-${key}">待生成</span>
      </div>
      <div class="output-area cmp-area" id="area-${key}"></div>
      <div style="display:flex;gap:.5rem">
        <button class="btn btn-secondary btn-sm" style="flex:1" onclick="copyColumn('${key}')">复制</button>
        <button class="btn btn-primary btn-sm" style="flex:1" onclick="adoptColumn('${key}')">采用此版</button>
      </div>
    </div>`).join('');
}

async function generateComparison() {
  const ta = document.getElementById('cmp-idea');
  const idea = ta.value.trim();
  if (!idea) { toast('请输入你的初步想法'); return; }

  const s = loadSettings();
  if (!s.endpoint) { toast('请先在设置中配置 API'); switchView('settings'); return; }
  if (compareRunning) return;

  compareRunning = true;
  const btn = document.getElementById('btn-compare');
  if (btn) btn.disabled = true;

  // 初始化每个框架的输出区
  Object.keys(FRAMEWORKS).forEach(key => {
    compareOutputs[key] = '';
    const area = document.getElementById(`area-${key}`);
    if (area) area.innerHTML = '';
    const st = document.getElementById(`st-${key}`);
    if (st) { st.textContent = '生成中...'; st.className = 'cmp-status running'; }
  });

  const answersText = Object.entries(state.followUpAnswers)
    .filter(([_, v]) => v.trim())
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  const controller = new AbortController();
  activeControllers.add(controller);

  await Promise.allSettled(Object.entries(FRAMEWORKS).map(async ([key, fw]) => {
    try {
      const prompt = fw.buildPrompt(idea, answersText || null);
      const full = await callLLM([{ role:'user', content:prompt }], {
        stream: true,
        signal: controller.signal,
        onUpdate: (t) => {
          compareOutputs[key] = t;
          const area = document.getElementById(`area-${key}`);
          scheduleWrite(area, () => escapeHTML(t) + '<span class="cursor"></span>',
            () => { area.scrollTop = area.scrollHeight; });
        },
      });
      compareOutputs[key] = full;
      const st = document.getElementById(`st-${key}`);
      if (st) { st.textContent = '完成'; st.className = 'cmp-status done'; }
      const area = document.getElementById(`area-${key}`);
      if (area) {
        cancelPendingWrite(area); // 丢弃待写入的中间帧，直接渲染最终文本
        area.innerHTML = escapeHTML(full);
      }
    } catch (err) {
      const st = document.getElementById(`st-${key}`);
      if (err.name === 'AbortError') {
        if (st) { st.textContent = '已停止'; st.className = 'cmp-status'; }
      } else {
        compareOutputs[key] = `生成失败: ${err.message}`;
        if (st) { st.textContent = '失败'; st.className = 'cmp-status failed'; }
      }
    }
  }));

  activeControllers.delete(controller);
  compareRunning = false;
  if (btn) btn.disabled = false;
  if (controller.signal.aborted) toast('已停止生成');
}

function copyColumn(k) {
  const text = compareOutputs[k];
  if (!text) { toast('该框架还未生成内容'); return; }
  navigator.clipboard.writeText(text)
    .then(() => toast(`已复制 ${FRAMEWORKS[k].name} 版本`))
    .catch(() => toast('复制失败'));
}

function adoptColumn(k) {
  const text = compareOutputs[k];
  if (!text) { toast('该框架还未生成内容'); return; }
  const idea = (document.getElementById('cmp-idea')?.value.trim()) || state.userIdea;
  state.userIdea = idea;
  state.outputText = text;
  state.outputFramework = k;
  selectFramework(k);
  document.getElementById('user-idea').value = idea;
  const scorePanel = document.getElementById('score-panel');
  if (scorePanel) scorePanel.classList.add('hidden');
  switchView('new');
  showOutput(text, k);
  toast(`已采用 ${FRAMEWORKS[k].name} 版本，可继续评分 / 分享 / 导出`);
}

// ============================================================
// Prompt Scoring 质量评分
// ============================================================
async function scoreOutput() {
  if (!state.outputText) { toast('请先生成提示词'); return; }
  const panel = document.getElementById('score-panel');
  panel.classList.remove('hidden');
  const totalEl = document.getElementById('score-total');
  totalEl.textContent = '…';
  totalEl.className = 'score-total';
  document.getElementById('score-verdict').textContent = '正在评分...';
  document.getElementById('score-dims').innerHTML = '';
  document.getElementById('score-sugs').innerHTML = '';

  try {
    const prompt = `你是一位专业的提示词评审专家。请对下面这个提示词的质量进行打分。

评分维度（每项 1-10 分）：
1. 清晰度：指令是否明确无歧义
2. 完整性：上下文、约束、输出格式是否齐全
3. 可执行性：AI 能否直接按此执行
4. 结构组织：是否层次分明、易读
5. 通用性：是否可复用于类似场景

严格只返回 JSON（不要 Markdown 代码块，不要其他文字）：
{"total":8,"verdict":"简短总评","scores":{"清晰度":8,"完整性":7,"可执行性":9,"结构组织":8,"通用性":6},"suggestions":["改进建议1","改进建议2"]}

待评分的提示词：
${state.outputText}`;

    const raw = await callLLM([{ role:'user', content:prompt }]);
    const score = parseJSON(raw);
    if (!score || typeof score.total !== 'number' || !score.scores) {
      throw new Error('评分结果解析失败');
    }
    renderScore(score);
  } catch (err) {
    const totalEl = document.getElementById('score-total');
    totalEl.textContent = '!';
    totalEl.className = 'score-total bad';
    document.getElementById('score-verdict').textContent = '评分失败: ' + err.message;
  }
}

function renderScore(s) {
  const totalEl = document.getElementById('score-total');
  totalEl.textContent = s.total;
  totalEl.className = 'score-total ' + (s.total >= 8 ? 'good' : s.total >= 6 ? 'mid' : 'bad');
  document.getElementById('score-verdict').textContent = s.verdict || '';

  const dims = document.getElementById('score-dims');
  dims.innerHTML = Object.entries(s.scores).map(([name, v]) => `
    <div class="dim-row">
      <label>${escapeHTML(String(name))}</label>
      <div class="dim-bar"><div class="dim-fill" style="width:${Math.min(100, Math.max(0, Number(v) * 10))}%"></div></div>
      <span class="dim-val">${escapeHTML(String(v))}</span>
    </div>`).join('');

  const sugs = document.getElementById('score-sugs');
  if (Array.isArray(s.suggestions) && s.suggestions.length > 0) {
    sugs.innerHTML = `<strong style="color:var(--text);font-family:var(--font-display)">改进建议</strong>
      <ul>${s.suggestions.map(x => `<li>${escapeHTML(String(x))}</li>`).join('')}</ul>`;
  } else {
    sugs.innerHTML = '';
  }
}

// ============================================================
// Share 一键分享
// ============================================================
function encodeShare(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  // 分块构建二进制字符串：逐字节 += 是 O(n²)，长提示词分享时会明显卡顿
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function decodeShare(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

// 分享链接把整段提示词 base64 后放进 URL 的 hash，内容越长链接越长。
// 长链接的现实问题：部分聊天软件/浏览器会截断；二维码接口对 data 参数有上限，
// 超了会返回一张报错图片。所以这里分级处理，而不是默默给出一个打不开的链接。
const SHARE_URL_WARN = 8000;   // 偏长，提醒可能被截断（仍然复制）
const SHARE_URL_MAX = 32000;   // 超此长度不再生成，引导改用导出
const QR_URL_MAX = 2000;       // 二维码接口能承载的上限

function shareLink() {
  if (!state.outputText) { toast('请先生成提示词'); return null; }
  const payload = encodeShare({
    v: 1,
    idea: state.userIdea,
    framework: state.outputFramework,
    output: state.outputText,
    date: new Date().toISOString(),
  });
  const url = location.href.split('#')[0] + '#s=' + payload;
  if (url.length > SHARE_URL_MAX) {
    toast('内容过长，无法生成分享链接，请改用「↓ MD / ↓ JSON」导出');
    return null;
  }
  if (url.length > SHARE_URL_WARN) {
    toast('提示词较长，分享链接已复制，但部分软件可能截断，建议改用导出');
  }
  navigator.clipboard.writeText(url)
    .then(() => toast(url.length > SHARE_URL_WARN ? '分享链接已复制（较长，注意截断）' : '分享链接已复制到剪贴板'))
    .catch(() => toast('复制失败，请手动复制：' + url));
  return url;
}

function showQR() {
  const url = shareLink();
  if (!url) return;
  // 超长内容二维码放不下，接口只会返回错误图，提前说明比让用户看到一张废图好
  if (url.length > QR_URL_MAX) {
    toast('内容过长，二维码放不下，请改用分享链接或「↓ MD / ↓ JSON」导出');
    return;
  }
  document.getElementById('qr-img').src =
    'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' + encodeURIComponent(url);
  document.getElementById('qrmodal').classList.remove('hidden');
}

function closeQR() {
  document.getElementById('qrmodal').classList.add('hidden');
  document.getElementById('qr-img').src = '';
}

function loadSharedFromHash() {
  const m = location.hash.match(/^#s=(.+)$/);
  if (!m) return;
  try {
    const d = decodeShare(m[1]);
    if (d && d.output) {
      const fw = Object.keys(FRAMEWORKS).includes(d.framework) ? d.framework : 'costar';
      state.userIdea = d.idea || '';
      state.outputText = d.output;
      state.outputFramework = fw;
      selectFramework(fw);
      document.getElementById('user-idea').value = state.userIdea;
      switchView('new');
      showOutput(d.output, fw);
      toast('已加载分享的提示词');
    }
  } catch {}
}

// ============================================================
// Streaming UI
// ============================================================
// 流式写入合并到每帧一次：原来每个 token 都触发一次全量 innerHTML 重解析，
// 输出越长代价越高（O(n²)）。同一元素同一帧内多次调用只会写入最后一次。
const _writeQueue = new Map();
let _writeRafId = 0;

function scheduleWrite(el, getHTML, after) {
  if (!el) return;
  _writeQueue.set(el, { el, getHTML, after });
  if (_writeRafId) return;
  _writeRafId = requestAnimationFrame(() => {
    _writeRafId = 0;
    const jobs = [..._writeQueue.values()];
    _writeQueue.clear();
    for (const job of jobs) {
      job.el.innerHTML = job.getHTML();
      if (job.after) job.after();
    }
  });
}

function cancelPendingWrite(el) {
  if (el) _writeQueue.delete(el);
}

function onUpdateStreaming(text) {
  const area = document.getElementById('output-area');
  scheduleWrite(area, () => escapeHTML(text) + '<span class="cursor"></span>');
}

// ============================================================
// UI Functions
// ============================================================
function showStep(step) {
  ['input','questions','generating','output'].forEach(s => {
    const el = document.getElementById(`step-${s}`);
    if (el) el.classList.toggle('hidden', s !== step);
  });
}

function showQuestions(questions) {
  showStep('questions');
  const container = document.getElementById('questions-container');
  container.innerHTML = questions.map((q, i) => `
    <div class="question-group">
      <label>${i + 1}. ${escapeHTML(q)}</label>
      <textarea id="q-${i}" rows="2" placeholder="请简要回答，或留空跳过..."></textarea>
    </div>
  `).join('') + `
    <div class="toolbar">
      <button class="btn btn-primary" onclick="submitAnswers()">生成优化提示词 →</button>
      <button class="btn btn-ghost" onclick="skipQuestions()">跳过，直接生成</button>
      <button class="btn btn-ghost" onclick="cancelAndReset()" style="color:var(--danger)">取消</button>
    </div>
  `;
}

function cancelAndReset() {
  stopGeneration();
  state.followUpAnswers = {};
  state.questions = [];
  showStep('input');
  toast('已取消');
}

function showStreamingMeta() {
  const label = document.getElementById('output-label-text');
  if (label) label.textContent = '正在生成…';
  const btn = document.getElementById('btn-stop-2');
  if (btn) btn.classList.remove('hidden');
  const meta = document.getElementById('output-meta');
  const fwName = FRAMEWORKS[state.outputFramework]?.name || '…';
  meta.innerHTML = `
    <span class="tag">框架: ${fwName}</span>
    <span class="tag">生成中…</span>
  `;
}

function showOutput(text, fw) {
  showStep('output');
  const label = document.getElementById('output-label-text');
  if (label) label.textContent = '优化完成';
  const stopBtn = document.getElementById('btn-stop-2');
  if (stopBtn) stopBtn.classList.add('hidden');
  renderOutputView();
  const area = document.getElementById('output-area');
  if (area) area.scrollTop = area.scrollHeight;

  const meta = document.getElementById('output-meta');
  // 历史/分享数据里的 framework 可能非法，做兜底避免整页渲染失败
  const fwName = frameworkName(fw);
  const safeText = text == null ? '' : String(text);
  let metaHTML = `<span class="tag">框架: ${escapeHTML(fwName)}</span><span class="tag">字数: ${safeText.length}</span>`;

  if (state._autoReason) {
    metaHTML = `<span class="tag" style="background:var(--accent-dim);color:var(--accent)">自动选择: ${escapeHTML(state._autoReason)}</span>` + metaHTML;
    state._autoReason = '';
  }

  meta.innerHTML = metaHTML;

  // 框架快速切换按钮组
  const switchDiv = document.getElementById('framework-switch');
  if (switchDiv) {
    const btn = (key, label) =>
      `<button class="fw-chip ${fw === key ? 'active' : ''}" onclick="switchFrameworkAndRegenerate('${key}')">${label}</button>`;
    switchDiv.innerHTML = `
      <span style="font-size:.78rem;color:var(--text3)">切换框架：</span>
      ${btn('costar', 'CO-STAR')}
      ${btn('create', 'CREATE')}
      ${btn('broke', 'BROKE')}
    `;
  }
}

async function switchFrameworkAndRegenerate(fw) {
  state.outputFramework = fw;
  selectFramework(fw);
  state._autoReason = '';
  await generateOptimized();
}

// ---- Markdown 轻量渲染（安全：先转义再加样式标签）----
function toggleMarkdown() {
  state.mdView = !state.mdView;
  renderOutputView();
  const btn = document.getElementById('btn-mdview');
  if (btn) btn.textContent = state.mdView ? '≡ 纯文本' : '≡ MD渲染';
}

function renderOutputView() {
  if (!state.outputText) return;
  const area = document.getElementById('output-area');
  if (!area) return;
  cancelPendingWrite(area); // 流式未刷新的中间帧作废，避免盖掉最终结果
  area.innerHTML = state.mdView ? renderMarkdown(state.outputText) : escapeHTML(state.outputText);
}

function renderMarkdown(text) {
  const esc = escapeHTML(text);
  const lines = esc.split('\n');
  let html = '';
  let inCode = false, inUl = false, inOl = false, inQuote = false;

  const closeList = () => {
    if (inUl) { html += '</ul>'; inUl = false; }
    if (inOl) { html += '</ol>'; inOl = false; }
  };
  const closeQuote = () => { if (inQuote) { html += '</blockquote>'; inQuote = false; } };

  for (let line of lines) {
    if (line.startsWith('```')) {
      closeList(); closeQuote();
      if (inCode) { html += '</code></pre>'; inCode = false; }
      else { html += '<pre><code>'; inCode = true; }
      continue;
    }
    if (inCode) { html += line + '\n'; continue; }

    const quote = line.match(/^&gt;\s?(.*)$/);
    if (quote) {
      closeList();
      if (!inQuote) { html += '<blockquote>'; inQuote = true; }
      html += inlineMd(quote[1]) + '\n';
      continue;
    }
    closeQuote();

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const n = Math.min(h[1].length, 6);
      html += `<h${n} style="margin:.6em 0 .3em;color:var(--accent);font-family:var(--font-display)">${inlineMd(h[2])}</h${n}>`;
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeList();
      html += '<hr style="border:none;border-top:1px solid var(--border);margin:.8em 0">';
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      closeQuote();
      if (ul) {
        if (!inUl) { closeList(); html += '<ul style="padding-left:1.4em;margin:.3em 0">'; inUl = true; }
        html += `<li>${inlineMd(ul[1])}</li>`;
      } else {
        if (!inOl) { closeList(); html += '<ol style="padding-left:1.4em;margin:.3em 0">'; inOl = true; }
        html += `<li>${inlineMd(ol[1])}</li>`;
      }
      continue;
    }
    closeList();

    if (!line.trim()) { html += '\n'; continue; }
    html += inlineMd(line) + '\n';
  }
  closeList(); closeQuote();
  if (inCode) html += '</code></pre>';
  return html;
}

function inlineMd(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code style="background:var(--s3);padding:.1em .35em;border-radius:4px;font-size:.85em">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, url) =>
      /^https?:\/\//i.test(url)
        ? `<a href="${url}" target="_blank" rel="noopener" style="color:var(--info)">${txt}</a>`
        : m);
}

function copyOutput() {
  navigator.clipboard.writeText(state.outputText).then(() => {
    toast('已复制到剪贴板');
  }).catch(() => {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = state.outputText;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast('已复制到剪贴板');
  });
}

// 单调递增的历史 id：Date.now() 在同毫秒内重复保存会撞 id，
// 而 id 被内联 onclick="viewHistory(${h.id})" 依赖，必须保持为数字。
let _lastHistoryId = 0;
function nextHistoryId() {
  const now = Date.now();
  _lastHistoryId = now > _lastHistoryId ? now : _lastHistoryId + 1;
  return _lastHistoryId;
}

function saveToHistory() {
  addHistory({
    id: nextHistoryId(),
    idea: state.userIdea,
    framework: state.outputFramework,
    output: state.outputText,
    date: new Date().toLocaleString('zh-CN'),
    updatedAt: Date.now(),
  });
  toast('已保存到历史记录');
  if (getSyncConfig().configured) syncNow(false); // 已配置云同步则后台自动推送
}

function regenerate() {
  state.followUpAnswers = {};
  state.outputText = '';
  generateOptimized();
}

function resetFlow() {
  state.userIdea = '';
  state.followUpAnswers = {};
  state.questions = [];
  state.outputText = '';
  state.outputFramework = '';
  document.getElementById('user-idea').value = '';
  const scorePanel = document.getElementById('score-panel');
  if (scorePanel) scorePanel.classList.add('hidden');
  showStep('input');
}

// 导航激活态与 aria-current 同步：读屏用户据此知道「当前在哪个页面」。
// 抽成独立函数的目的是让首屏也能初始化一次 —— DOMContentLoaded 不经过 switchView，
// 否则首次进入页面时导航项没有任何 aria-current（读屏不知道自己在哪个视图）。
// 必须用 function 声明：本文件顶层 const 不会成为 window 属性，内联 handler 无法访问。
function syncNavAriaCurrent(view) {
  // 用 setAttribute('aria-current', 'false') 而非 removeAttribute，语义等价且无副作用。
  document.querySelectorAll('.nav-item').forEach(n => {
    const on = n.dataset.view === view;
    n.classList.toggle('active', on);
    n.setAttribute('aria-current', on ? 'page' : 'false');
  });
  document.querySelectorAll('.mobile-nav-btn').forEach(n => {
    const on = n.dataset.view === view;
    n.classList.toggle('active', on);
    n.setAttribute('aria-current', on ? 'page' : 'false');
  });
}

function switchView(view) {
  state.currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');

  syncNavAriaCurrent(view);

  if (view === 'compare') initCompare();
  if (view === 'optimize') initOptimizeView();
  if (view === 'templates') renderTemplates();
  if (view === 'history') renderHistory();
  if (view === 'settings') loadSettingsUI();
}

// Templates
let activeCategory = '全部';
function renderTemplates() {
  // Filters
  const filterContainer = document.getElementById('template-filters');
  filterContainer.innerHTML = CATEGORIES.map(c => `
    <button class="preset-chip ${c === activeCategory ? 'active' : ''}"
            onclick="filterTemplates('${c}')">${c}</button>
  `).join('');

  // Grid
  const grid = document.getElementById('template-grid');
  const filtered = activeCategory === '全部' ? TEMPLATES : TEMPLATES.filter(t => t.cat === activeCategory);
  grid.innerHTML = filtered.map(t => `
    <div class="template-card" onclick="useTemplate('${t.id}')">
      <div class="cat">${escapeHTML(t.cat)}</div>
      <h3>${escapeHTML(t.name)}</h3>
      <p>${escapeHTML(t.desc)}</p>
    </div>
  `).join('');
}

function filterTemplates(cat) {
  activeCategory = cat;
  renderTemplates();
}

// 模板预填文本里若还留着占位符，点开直接生成就会产出半成品提示词。
// 这里做一层兜底：开发期在控制台报警，运行期把占位符剔除后再填入。
const TEMPLATE_PLACEHOLDER_RE = /(\.{3}|…|xxx+|某某|待填|TODO)/i;

function useTemplate(id) {
  const t = TEMPLATES.find(x => x.id === id);
  if (!t) return;
  switchView('new');

  let idea = t.idea || '';
  if (TEMPLATE_PLACEHOLDER_RE.test(idea)) {
    console.warn(`[模板] ${t.name} 的预填文本仍含占位符，请修改 frameworks.js：`, idea);
    idea = idea.replace(/\s*[.…]{2,}\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  const input = document.getElementById('user-idea');
  input.value = idea;
  selectFramework(t.framework);
  input.focus();
  input.setSelectionRange(idea.length, idea.length);

  // 提示用户改哪里，而不是只说"已加载"
  const tipEl = document.getElementById('template-tip');
  if (tipEl) {
    tipEl.textContent = t.tip ? `示例已填入 · ${t.tip}` : '';
    tipEl.classList.toggle('hidden', !t.tip);
  }
  toast(`已加载「${t.name}」示例，改写成你的内容即可生成`);
}

// History
function renderHistory() {
  const list = document.getElementById('history-list');
  const history = loadHistory();
  if (history.length === 0) {
    list.innerHTML = '<div class="history-empty">暂无历史记录<br><span style="font-size:.82rem">优化提示词后点击"保存"即可记录</span></div>';
    return;
  }
  list.innerHTML = history.map(h => {
    // 导入/损坏的数据可能缺字段，逐条兜底，避免一条坏数据让整个列表渲染失败
    const idea = String(h.idea == null ? '' : h.idea);
    const output = String(h.output == null ? '' : h.output);
    const fwName = frameworkName(h.framework);
    const id = Number.isFinite(Number(h.id)) ? Number(h.id) : 0;
    return `
    <div class="history-item" onclick="viewHistory(${id})">
      <div style="min-width:0">
        <h4>${escapeHTML(idea.slice(0, 60))}${idea.length > 60 ? '...' : ''}</h4>
        <p>框架: ${escapeHTML(String(fwName))} · ${output.length} 字</p>
      </div>
      <div style="display:flex;align-items:center;gap:.6rem;flex-shrink:0">
        <span class="date">${escapeHTML(String(h.date || ''))}</span>
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();deleteHistory(${id})">删除</button>
      </div>
    </div>
  `;
  }).join('');
}

function deleteHistory(id) {
  const h = loadHistory().filter(x => x.id !== id);
  localStorage.setItem('pf_history', JSON.stringify(h));
  const tombstones = [...new Set([...loadTombstones(), id])];
  saveTombstones(tombstones);
  saveSyncMeta({ ...loadSyncMeta(), tombstones: Date.now() });
  renderHistory();
  toast('已删除该条记录');
  if (getSyncConfig().configured) syncNow(false); // 墓碑会同步到其他设备
}

async function clearHistory() {
  const h = loadHistory();
  if (h.length === 0) { toast('暂无历史记录'); return; }
  // 破坏性操作统一走主题化弹窗：原生 confirm 无法本地化/主题化，风格割裂，
  // 且体现不出危险色。danger 让确认按钮显式变红。
  const ok = await askDialog({
    title: '清空全部历史记录',
    body: `确定清空全部 <b>${h.length}</b> 条历史记录吗？此操作不可恢复。`,
    confirmText: '清空',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;
  const tombIds = [...new Set([...loadTombstones(), ...h.map(x => x.id)])];
  localStorage.setItem('pf_history', '[]');
  saveTombstones(tombIds);
  saveSyncMeta({ ...loadSyncMeta(), tombstones: Date.now() });
  renderHistory();
  toast('已清空历史记录');
  if (getSyncConfig().configured) syncNow(false);
}

function viewHistory(id) {
  const history = loadHistory();
  const item = history.find(h => h.id === id);
  if (!item) { toast('未找到该条记录'); return; }
  // 兼容旧数据：framework 非法时回落到 costar，否则 showOutput / 生成流程会炸
  const fw = FRAMEWORKS[item.framework] ? item.framework : 'costar';
  switchView('new');
  state.userIdea = item.idea || '';
  state.outputText = item.output || '';
  state.outputFramework = fw;
  document.getElementById('user-idea').value = state.userIdea;
  // 展示用真实 framework（'optimize' 会显示成「提示词优化」），
  // 但 state.outputFramework 保持合法框架值，避免后续「重新生成」取不到 buildPrompt
  showOutput(state.outputText, item.framework || fw);
}

// Settings
function loadSettingsUI() {
  const s = loadSettings();
  document.getElementById('set-endpoint').value = s.endpoint || '';
  document.getElementById('set-key').value = s.key || '';
  document.getElementById('set-model').value = s.model || '';
  document.getElementById('set-lang').value = s.lang || 'zh';
  document.getElementById('set-sensitivity').value = s.sensitivity || 'medium';
  document.getElementById('set-sb-url').value = s.supabase?.url || '';
  document.getElementById('set-sb-key').value = s.supabase?.key || '';
  document.getElementById('set-sb-ns').value = s.supabase?.ns || '';
  
  // 离线引擎状态
  const engineEl = document.getElementById('set-engine');
  if (engineEl) {
    engineEl.value = s.engine || 'online';
    onEngineChange(s.engine || 'online');
  }
  
  // 引擎选择（兼容旧版本的单选按钮）
  const engineRadios = document.querySelectorAll('input[name="engine"]');
  engineRadios.forEach(radio => {
    radio.checked = radio.value === s.engine;
  });
  
  // 根据引擎类型显示/隐藏相关设置
  updateEngineUI(s.engine);
  
  // 本地模式设置（旧版控件可能不存在，做安全访问）
  const localModeEl = document.getElementById('set-local-mode');
  if (localModeEl) localModeEl.checked = s.localMode || false;
  const localModelEl = document.getElementById('set-local-model');
  if (localModelEl) localModelEl.value = s.localModel || 'qwen25';

  // 软件更新源地址：留空则仅使用客户端本地更新文件夹
  const updateUrlEl = document.getElementById('set-update-url');
  if (updateUrlEl) updateUrlEl.value = s.updateUrl || '';
  
  // 检查本地模式状态
  if (typeof window.checkLocalMode === 'function') {
    window.checkLocalMode();
  }
}

function saveSettings() {
  const s = {
    endpoint: document.getElementById('set-endpoint').value.trim(),
    key: document.getElementById('set-key').value.trim(),
    model: document.getElementById('set-model').value.trim(),
    lang: document.getElementById('set-lang').value,
    sensitivity: document.getElementById('set-sensitivity').value,
    supabase: {
      url: document.getElementById('set-sb-url').value.trim(),
      key: document.getElementById('set-sb-key').value.trim(),
      ns: document.getElementById('set-sb-ns').value.trim(),
    },
    // 引擎设置
    engine: document.getElementById('set-engine').value || 'online',
    // 本地模式设置（控件可能不存在，统一用可选链 + 兜底，避免整段保存失败）
    localMode: document.getElementById('set-local-mode')?.checked || false,
    localModel: document.getElementById('set-local-model')?.value || 'qwen25',
    // 软件更新源地址（网页端 version.json 所在目录，例如 https://example.com/promptforge/）
    updateUrl: (document.getElementById('set-update-url')?.value || '').trim(),
  };
  
  saveSettingsToStorage(s);
  saveSyncMeta({ ...loadSyncMeta(), settings: Date.now() });
  
  // 保存本地模式设置
  if (typeof window.saveLocalSettings === 'function') {
    window.saveLocalSettings();
  }
  
  const status = document.getElementById('save-status');
  status.textContent = '已保存 ✓';
  setTimeout(() => status.textContent = '', 2000);
  toast('设置已保存');
  if (getSyncConfig().configured) syncNow(false); // 后台同步设置到云端
}

function applyPreset(key) {
  const p = API_PRESETS[key];
  if (!p) return;
  
  // 设置在线引擎和相应的 API 配置
  const engineEl = document.getElementById('set-engine');
  if (engineEl) {
    engineEl.value = 'online';
    onEngineChange('online');
  }
  
  document.getElementById('set-endpoint').value = p.endpoint;
  document.getElementById('set-model').value = p.model;
  toast(`已应用 ${key} 预设 · ${p.hint}`);
}

// Framework selection
function selectFramework(fw) {
  state.selectedFramework = fw;
  document.querySelectorAll('.fw-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.fw === fw);
  });
  const nameEl = document.getElementById('fw-display-name');
  if (nameEl) {
    nameEl.textContent = fw === 'auto' ? '自动匹配' : FRAMEWORKS[fw].name;
  }
}

// 框架显示名：'optimize' 是「提示词优化」产出的非框架条目，需单独兜底
function frameworkName(fw) {
  if (fw === 'optimize') return '提示词优化';
  return FRAMEWORKS[fw]?.name || fw || '未知框架';
}

// ============================================================
// Toast（队列化 + 类型 + 自适应时长）
// 旧实现是「单一元素 + 后到覆盖先到」：连续调用时前一条还没看清就被顶掉；
// 且固定 2.5 秒、无类型区分、无 aria-live（读屏完全不播报）。
// 新实现同一时刻只显示一条，淡出后再出下一条。
// 兼容性：type 默认 'info'，全项目约 100 处「只传一个参数」的旧调用无需改动。
// ============================================================
const TOAST_TYPES = ['info', 'success', 'error', 'warning'];
const TOAST_DURATION_MIN = 2000;   // 最短展示（毫秒），避免短句一闪而过
const TOAST_DURATION_MAX = 6000;   // 最长展示，避免长句霸屏
const TOAST_FADE_MS = 320;         // 与 CSS transition(.3s) 对齐，等淡出后再出下一条

let _toastQueue = [];
let _toastShowing = false;

// 按内容长度自适应展示时长：长句给足阅读时间
function toastDuration(msg) {
  const len = String(msg == null ? '' : msg).length;
  return Math.min(TOAST_DURATION_MAX, Math.max(TOAST_DURATION_MIN, 1200 + len * 90));
}

function toast(msg, type) {
  const el = document.getElementById('toast');
  if (!el) return; // DOM 未就绪时静默返回，绝不二次抛错
  const t = TOAST_TYPES.includes(type) ? type : 'info';
  _toastQueue.push({ msg: String(msg == null ? '' : msg), type: t });
  pumpToastQueue();
}

// 出队一条并展示；淡出结束再出下一条。整条链路的定时器都挂在 el._timer 上，
// 保证连续调用不会残留多个定时器互相打架。
function pumpToastQueue() {
  const el = document.getElementById('toast');
  if (!el || _toastShowing || _toastQueue.length === 0) return;
  const item = _toastQueue.shift();
  _toastShowing = true;

  el.textContent = item.msg;
  TOAST_TYPES.forEach((t) => el.classList.remove('toast-' + t));
  el.classList.add('toast-' + item.type);
  el.classList.add('show');

  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.classList.remove('show');
    // 等淡出动画结束再出下一条，否则两条提示会叠影
    el._timer = setTimeout(() => { _toastShowing = false; pumpToastQueue(); }, TOAST_FADE_MS);
  }, toastDuration(item.msg));
}

// ============================================================
// 全局错误兜底：未捕获异常 / 未处理的 Promise 拒绝若无人接管，
// 表现就是「点了没反应」或白屏 —— 用户无法自助、团队也拿不到定位线索。
// 统一走 reportFatalError：先 console 留痕，再 toast 告知用户如何查看详情。
// 必须节流：报错风暴下无节制弹提示会把界面刷屏，甚至让提示本身成为新的报错源。
// toast 调用需包 try/catch：DOM 未就绪时不应二次抛错。
// ============================================================
const FATAL_TOAST_INTERVAL = 3000;
let _lastFatalToastAt = 0;

function reportFatalError(scope, err) {
  // 留痕优先：控制台是定位问题的唯一一手材料
  try { console.error('[' + scope + ']', err); } catch {}

  const now = Date.now();
  if (now - _lastFatalToastAt < FATAL_TOAST_INTERVAL) return; // 节流
  _lastFatalToastAt = now;

  const msg = (err && err.message) || String(err);
  try {
    toast('应用出现问题：' + msg + '（按 F12 打开控制台查看详情）', 'error');
  } catch (e) {
    // toast 自身失败时不能再抛出，否则会与全局 handler 形成递归
    try { console.error('toast 调用失败：', e); } catch {}
  }
}

window.addEventListener('error', (e) => {
  // 资源加载失败（img/script 404）也会触发 error，但没有 error 对象；
  // 这不是代码缺陷，不打扰用户。
  if (!e || (!e.error && !e.message)) return;
  reportFatalError('未捕获异常', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  reportFatalError('未处理的 Promise 拒绝', e && e.reason);
});

const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// 纯字符串转义：流式渲染每帧都会调用，原来的 createElement + innerHTML 方案
// 每次都要新建一个 DOM 节点，属于热路径上的无谓开销。
function escapeHTML(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c]);
}

// ============================================================
// PWA 离线支持
// ============================================================
function updateOfflineBadge() {
  const el = document.getElementById('offline-badge');
  if (!el) return;
  el.classList.remove('hidden');
  if (navigator.serviceWorker.controller) {
    el.textContent = '◉ 已支持离线使用';
    el.classList.add('ready');
    el.title = '页面已缓存到本地，断网也能打开（模型可配合本地 Ollama）';
  } else {
    el.textContent = '○ 首次访问后可离线';
  }
}

function registerServiceWorker() {
  // file:// 协议不支持 Service Worker，本地双击打开时自动跳过
  if (!('serviceWorker' in navigator)) return;
  if (!/^https?:$/.test(location.protocol)) return;
  // Tauri 桌面端（tauri.localhost 是所有 Tauri 应用共享的来源）跳过注册，
  // 避免旧缓存/跨应用 Service Worker 干扰导致白屏或乱码
  if (window.__TAURI_INTERNALS__ || location.hostname === 'tauri.localhost') return;
  navigator.serviceWorker.register('./sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(() => updateOfflineBadge())
    .catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', updateOfflineBadge);
}

// 通用弹窗（替代 confirm）：返回 Promise<boolean>
//
// 无障碍要点（它是全站破坏性操作的必经关卡，缺一不可）：
//   · role=dialog + aria-modal：读屏知道这是模态对话框并屏蔽背后内容
//   · aria-labelledby 指向标题：打开时先朗读标题
//   · 打开即把焦点移入弹窗（默认落到「取消」，破坏性操作尤其重要）
//   · Tab / Shift+Tab 焦点陷阱：焦点不会跑回背后的页面
//   · Esc 关闭（等价于取消）
//   · 关闭后把焦点还原到打开前的触发元素
let _dialogSeq = 0;

function askDialog(opts) {
  return new Promise((resolve) => {
    const { title, body, confirmText = '确定', cancelText = '取消', danger = false } = opts || {};
    // 记录打开前的焦点，关闭后还原（触发元素可能已被移除，需容错）
    const prevFocus = document.activeElement;
    const titleId = 'askdialog-title-' + (++_dialogSeq);

    const wrap = document.createElement('div');
    wrap.className = 'modal';
    // 用 setAttribute 而非 innerHTML 属性串：语义属性与内容分离，便于静态校验与维护
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', titleId);
    wrap.innerHTML = `
      <div class="modal-box modal-box-left">
        <h3 id="${titleId}">${escapeHTML(title || '')}</h3>
        <div class="modal-body" style="text-align:left;font-size:.9rem;line-height:1.7;color:var(--text2);margin:.6rem 0 1.2rem">${body || ''}</div>
        <div class="row" style="justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" data-a="cancel">${escapeHTML(cancelText)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-sm" data-a="ok">${escapeHTML(confirmText)}</button>
        </div>
      </div>`;

    const restoreFocus = () => {
      try { if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus(); } catch {}
    };

    const close = (v) => {
      wrap.removeEventListener('keydown', onKeydown);
      wrap.remove();
      restoreFocus();
      resolve(v);
    };

    // 弹窗内可聚焦元素（供 Tab 循环使用）
    const focusables = () => Array.prototype.slice
      .call(wrap.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter((el) => !el.disabled);

    const onKeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); return; } // Esc = 取消
      if (e.key !== 'Tab') return;
      // 焦点陷阱：在弹窗首尾之间循环，不让焦点逃到背后的页面
      const list = focusables();
      if (!list.length) { e.preventDefault(); return; }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !wrap.contains(active)) { e.preventDefault(); last.focus(); }
      } else if (active === last) {
        e.preventDefault(); first.focus();
      }
    };

    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) close(false);
      const a = e.target.closest('[data-a]');
      if (a) close(a.dataset.a === 'ok');
    });
    wrap.addEventListener('keydown', onKeydown);

    document.body.appendChild(wrap);

    // 初始焦点落在「取消」：破坏性操作用户最可能想反悔，先给安全选项。
    // 找不到取消按钮时回落到弹窗内最后一个可聚焦元素。
    try {
      const btns = wrap.querySelectorAll('button');
      let target = null;
      for (const b of btns) { if (b.getAttribute('data-a') === 'cancel') { target = b; break; } }
      if (!target && btns.length) target = btns[btns.length - 1];
      if (target) target.focus();
    } catch {}
  });
}

// PWA 安装入口：直接唤起安装，失败再给具体引导

// 移除已安装的网页应用（设置页底部入口）
async function uninstallWebApp() {
  if (isDesktopApp) { toast('桌面版请在系统「应用和功能」中卸载'); return; }
  const ok = await askDialog({
    title: '移除已安装的应用',
    body: '将注销本站的 Service Worker 并清除应用缓存，让你可以重新安装。'
      + '<br><b style="color:var(--danger)">不会删除你的历史记录与设置</b>（如需清除，请用「设置 → 数据备份与迁移」或下方的「清空全部数据」）。',
    confirmText: '确认移除',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;
  if (typeof PWAInstaller !== 'undefined') await PWAInstaller.uninstallWebApp();
  toast('已移除，刷新后可重新安装');
  setTimeout(() => location.reload(), 800);
}

// 桌面端卸载：调用系统卸载程序后退出
async function uninstallDesktopApp() {
  if (!isDesktopApp) { toast('仅桌面版支持'); return; }
  const ok = await askDialog({
    title: '卸载 PromptForge',
    body: '将打开系统卸载程序。卸载后你的历史记录与设置可能一并移除，'
      + '建议先到「设置 → 数据备份与迁移」导出一份备份。'
      + '<br><br>确认继续？',
    confirmText: '打开卸载程序',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;
  try {
    await tauriInvoke('uninstall_app');
  } catch (e) {
    toast('无法启动卸载程序：' + (e.message || e));
  }
}

// 在文件管理器中打开程序安装目录（解决"找不到主程序在哪"）
function openAppDir() {
  if (!isDesktopApp) { toast('仅桌面版支持'); return; }
  tauriInvoke('open_app_dir').catch((e) => toast('打开失败：' + (e.message || e)));
}

// 创建/重建桌面快捷方式
async function createDesktopShortcut() {
  if (!isDesktopApp) { toast('仅桌面版支持'); return; }
  try {
    const p = await tauriInvoke('create_desktop_shortcut');
    toast('桌面快捷方式已创建：' + p);
  } catch (e) {
    toast('创建失败：' + (e.message || e));
  }
}

// 设置页底部的卸载按钮：桌面端走系统卸载程序，网页端移除 PWA 安装
function uninstallCurrentTarget() {
  return isDesktopApp ? uninstallDesktopApp() : uninstallWebApp();
}

// ============================================================
// Event Listeners
// ============================================================
// 引擎 UI 更新
function updateEngineUI(engine) {
  const onlineSettings = document.getElementById('online-settings');
  const offlineSettings = document.getElementById('offline-settings');
  const engineSelect = document.getElementById('set-engine');
  
  if (engineSelect) {
    engineSelect.value = engine;
  }
  
  if (engine === 'offline') {
    if (onlineSettings) onlineSettings.style.display = 'none';
    if (offlineSettings) offlineSettings.style.display = 'block';
    showOfflineModelSection();
  } else {
    if (onlineSettings) onlineSettings.style.display = 'block';
    if (offlineSettings) offlineSettings.style.display = 'none';
    hideOfflineModelSection();
  }
}

// 引擎切换事件处理（合并了 offline-ui.js 的渲染职责，避免重复定义互相覆盖）
function onEngineChange(engine) {
  const settings = loadSettings();
  settings.engine = engine;
  saveSettingsToStorage(settings);

  updateEngineUI(engine);

  const section = document.getElementById('offline-model-section');
  if (section) section.style.display = engine === 'offline' ? 'block' : 'none';

  if (engine === 'offline') {
    // 渲染离线模型卡片与设备信息（来自 offline-ui.js）
    if (typeof renderModelCards === 'function') renderModelCards();
    if (typeof renderDeviceInfo === 'function') renderDeviceInfo();
  }

  if (typeof window.checkLocalMode === 'function') {
    window.checkLocalMode();
  }
}

// 显示离线模型部分
function showOfflineModelSection() {
  const section = document.getElementById('offline-model-section');
  if (section) {
    section.style.display = 'block';
  }
}

// 隐藏离线模型部分
function hideOfflineModelSection() {
  const section = document.getElementById('offline-model-section');
  if (section) {
    section.style.display = 'none';
  }
}

// 引擎切换事件监听
function setupEngineListeners() {
  const engineRadios = document.querySelectorAll('input[name="engine"]');
  engineRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      const engine = e.target.value;
      updateEngineUI(engine);
      
      // 保存引擎设置
      const settings = loadSettings();
      settings.engine = engine;
      saveSettingsToStorage(settings);
      
      // 如果切换到离线模式，检查本地模型状态
      if (engine === 'offline') {
        if (typeof window.checkLocalMode === 'function') {
          window.checkLocalMode();
        }
      }
    });
  });
}

// ============================================================
// 应用内自动更新：侧边栏「检查更新」红点 + 单击原地更新（不退出软件）
// ============================================================
const isDesktopApp = typeof window.__TAURI_INTERNALS__ !== 'undefined';

function tauriInvoke(cmd, args) {
  if (!window.__TAURI_INTERNALS__) return Promise.reject(new Error('仅桌面版支持'));
  return window.__TAURI_INTERNALS__.invoke(cmd, args || {});
}

// 客户端与网页端共用同一份 version.json：填了地址就联网检测，没填就退回本地更新文件夹
function getUpdateBaseUrl() {
  return String(loadSettings().updateUrl || '').trim();
}

// 用户没填更新源时的兜底顺序（每一层都不需要用户操作，这是"彻底修好"的关键）：
//   1. version.json 里的 updateUrl —— 发布者为整个部署设定的公共更新源
//   2. window.PF_DEPLOY_BASE     —— 本页自己所在服务器的根地址
//      （由 index.html 内联脚本在加载时写入；桌面端因此能直接用它自己那个
//        127.0.0.1 静态服务当作更新源，即"客户端从自己的安装目录检测更新"，
//        便携式部署与开发目录就此开箱可用，不再要求用户手填地址）
//   3. 空字符串 —— 交给 Rust 侧继续尝试内置分发源与各本地清单
let _defaultUpdateUrl;
async function resolveUpdateBaseUrl() {
  const user = getUpdateBaseUrl();
  if (user) return user;
  if (_defaultUpdateUrl === undefined) {
    let fromManifest = '';
    try {
      const res = await fetch('version.json', { cache: 'no-store' });
      const j = res.ok ? await res.json() : null;
      fromManifest = String((j && j.updateUrl) || '').trim();
    } catch {}
    const fromSelf = String(window.PF_DEPLOY_BASE || '').trim();
    _defaultUpdateUrl = fromManifest || fromSelf;
  }
  return _defaultUpdateUrl || '';
}

function setUpdateDot(show) {
  const dot = document.getElementById('update-dot');
  if (!dot) return;
  dot.classList.toggle('hidden', !show);
  dot.classList.toggle('pulse', show);
}

async function checkForUpdate(showToastMsg) {
  if (!isDesktopApp) return null;
  const statusEl = document.getElementById('upd-status');
  const notesEl = document.getElementById('upd-notes');
  const btn = document.getElementById('btn-install-update');
  try {
    const base = await resolveUpdateBaseUrl();
    const info = await tauriInvoke('check_update', { baseUrl: base });
    if (info) {
      setUpdateDot(true);
      const size = info.size ? ` · ${(info.size / 1024 / 1024).toFixed(1)} MB` : '';
      const source = info.source === 'remote' ? '远程更新源' : '本地更新文件夹';
      const kind = info.kind === 'app' ? '完整安装包' : '界面热更新（无需退出）';
      if (statusEl) {
        statusEl.textContent = `发现 v${info.version} · ${kind}${size} · 来自${source}`;
      }
      if (notesEl) notesEl.textContent = info.notes ? '更新说明：' + info.notes : '';
      if (btn) {
        btn.disabled = false;
        btn.textContent = info.downloaded ? '安装更新' : '下载并安装';
      }
      if (showToastMsg) toast(`发现新版本 v${info.version}`);
      return info;
    }
    setUpdateDot(false);
    if (statusEl) statusEl.textContent = '已是最新版本';
    if (notesEl) notesEl.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = '下载并安装'; }
    if (showToastMsg) toast('已是最新版本');
    return null;
  } catch (e) {
    setUpdateDot(false);
    const msg = (e && e.message) || String(e);
    // 失败原因直接写出来：过去静默失败，用户点了"检查更新"却毫无反应
    if (statusEl) statusEl.textContent = '检查失败：' + msg;
    if (btn) btn.disabled = true;
    if (showToastMsg) toast('检查失败：' + msg);
    return null;
  }
}

// 设置页「检测更新源」：验证填的地址是否真的能取到 version.json
async function testUpdateSource() {
  const el = document.getElementById('update-source-status');
  const input = document.getElementById('set-update-url');
  const url = (input ? input.value : '').trim();
  if (el) { el.textContent = '检测中…'; el.style.color = ''; }
  if (!isDesktopApp) { if (el) el.textContent = '仅桌面版支持'; return; }
  if (!url) {
    // 没填时依次看：内置分发源 → 本机部署地址/各本地清单 ——
    // 全都取不到就要明确告诉用户"没得更新"，而不是笼统说"已是最新"
    let internal = '';
    let selfBase = '';
    try {
      const st = await tauriInvoke('update_state');
      internal = st.internal_latest || '';
      if (!internal) {
        const origin = st.manifest_origin;
        const mv = st.local_manifest_version;
        selfBase = String(window.PF_DEPLOY_BASE || '').trim();
        const detail = mv ? `，清单 v${mv}` : '';
        if (origin && origin !== '本地更新文件夹') {
          if (el) {
            el.textContent = `未填写，将从${origin}的 version.json 检测${detail}`;
            el.style.color = '';
          }
          return;
        }
        const hasLocal = !!st.local_manifest;
        if (el) {
          el.textContent = hasLocal
            ? `未填写，将从本地更新文件夹检测（已找到 ${st.local_manifest}${detail}）`
            : (selfBase
              ? `未填写，将尝试本机部署地址 ${selfBase}，但该处没有 version.json —— 请把 version.json 一并部署`
              : '未填写，且本地找不到任何 version.json —— 现在检查更新只会显示"已是最新版本"');
          el.style.color = (hasLocal || selfBase) ? '' : 'var(--warn, #d97706)';
        }
        return;
      }
    } catch {}
    if (el) el.textContent = `未填写，将使用内置分发源 ${internal}`;
    if (!internal) return;
  }
  try {
    const info = await tauriInvoke('check_update', { baseUrl: url });
    if (el) {
      el.textContent = info ? `可用 · 发现 v${info.version}` : '可用 · 当前已是最新版本';
      el.style.color = 'var(--accent)';
    }
  } catch (e) {
    if (el) {
      el.textContent = '不可用：' + ((e && e.message) || e);
      el.style.color = 'var(--danger)';
    }
  }
}

let updating = false;
// 侧边栏「检查更新」单击：直接同步更新；web 包不退出软件
async function doAppUpdate() {
  if (!isDesktopApp) { toast('仅桌面版支持'); return; }
  if (updating) return;
  updating = true;
  const statusEl = document.getElementById('upd-status');
  const btn = document.getElementById('btn-install-update');
  try {
    const base = await resolveUpdateBaseUrl();
    const info = await checkForUpdate(false);
    if (!info) { toast('已是最新版本'); return; }
    if (info.kind === 'app') {
      const go = await askDialog({
        title: `安装 v${info.version} 更新`,
        body: '这是一个完整的程序更新：应用会先下载安装包，然后短暂退出并由安装器自动完成升级，'
          + '升级完成后需要你手动重新打开。<br>界面更新（web 包）则无需退出。',
        confirmText: '下载并安装',
        cancelText: '稍后再说',
      });
      if (!go) return;
    }

    // 远程清单拿到的包不会自动落盘，先下载再安装
    if (!info.downloaded) {
      if (btn) btn.disabled = true;
      if (statusEl) statusEl.textContent = `正在下载 v${info.version} 更新包…`;
      toast('正在下载更新包…');
      await tauriInvoke('download_update', { baseUrl: base, file: info.file });
      if (statusEl) statusEl.textContent = '下载完成，正在安装…';
    }

    toast('正在更新...（请勿关闭应用）');
    const kind = await tauriInvoke('install_update', { baseUrl: base });
    if (kind === 'web') {
      toast('更新完成，正在刷新界面...');
      setUpdateDot(false);
      // 服务端已完成热切换，刷新页面即加载新版本
      setTimeout(() => { location.reload(); }, 600);
    }
    // kind === 'app'：应用将自动退出，由安装器接管
  } catch (e) {
    toast('更新失败：' + (e.message || e));
  } finally {
    updating = false;
  }
}

async function initUpdateSection() {
  const vEl = document.getElementById('cur-version');
  const statusEl = document.getElementById('upd-status');
  const webEl = document.getElementById('cur-web-version');
  const dirEl = document.getElementById('upd-dir');
  if (!isDesktopApp) {
    if (vEl) vEl.textContent = '网页版';
    if (statusEl) statusEl.textContent = '浏览器版无需更新（刷新页面即加载最新版本）';
    // 网页端也读出自己部署的版本号，方便和桌面端对照，确认两端是否同步
    // 用 no-store 避免被 Service Worker 返回旧的缓存副本
    fetch('version.json', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (!j || !webEl) return;
        webEl.textContent = 'v' + j.version;
        if (notesEl && j.notes) notesEl.textContent = '本版本更新：' + j.notes;
      })
      .catch(() => { if (webEl) webEl.textContent = '未知（version.json 不可达）'; });
    return;
  }
  // 一次拿到「程序版本 / 当前生效的前端版本 / 更新文件夹」，
  // 两端不同步时用户能直接看出来，而不是只能靠猜
  try {
    const st = await tauriInvoke('update_state');
    if (vEl) vEl.textContent = 'v' + st.app_version;
    if (webEl) {
      webEl.textContent = st.synced
        ? 'v' + st.web_version + '（与程序一致）'
        : 'v' + st.web_version + '（高于程序版本，已热更新）';
    }
    if (dirEl) dirEl.textContent = st.update_dir || '';
    // 把「更新源到底是什么、清单上是哪个版本」说清楚：过去用户只能看到
    // "最新版本"，分不清是真最新还是根本没找到更新源，只能反复点。
    // 现在按实际生效的顺序逐层展示，并带上探测到的清单版本号作对照。
    const srcEl = document.getElementById('upd-source-hint');
    if (srcEl) {
      const user = getUpdateBaseUrl();
      const selfBase = String(window.PF_DEPLOY_BASE || '').trim();
      const mv = st.local_manifest_version;
      const origin = st.manifest_origin;
      if (user) {
        srcEl.textContent = '更新源：' + user;
      } else if (st.internal_latest) {
        srcEl.textContent = '更新源：内置分发源（' + st.internal_latest + '）';
      } else if (mv && origin && origin !== '本地更新文件夹') {
        srcEl.textContent = '更新源：' + origin + '（清单 v' + mv + '）';
      } else if (st.local_manifest) {
        srcEl.textContent = '更新源：本地更新文件夹（已找到 ' + st.local_manifest
          + (mv ? '，清单 v' + mv : '') + '）';
      } else if (selfBase) {
        srcEl.textContent = '更新源：本机部署地址（' + selfBase + '），但该处没有 version.json。'
          + '请把发布目录里的 version.json 一并部署。';
      } else {
        srcEl.textContent = '更新源：未配置。请在上方填写更新源地址，'
          + '或把 version.json 与更新包放进更新文件夹（点「打开更新文件夹」）。';
      }
    }
  } catch {
    try {
      const v = await tauriInvoke('get_version');
      if (vEl) vEl.textContent = 'v' + v;
    } catch {}
  }
  const info = await checkForUpdate(false);

  // 装到旧版本也能自愈：启动即检测，发现完整包更新就主动问一次
  // （同一版本号只问一次，避免每次启动都弹窗）
  if (info && info.kind === 'app') {
    try {
      const asked = localStorage.getItem('pf_update_prompted');
      if (asked !== info.version) {
        localStorage.setItem('pf_update_prompted', info.version);
        const go = await askDialog({
          title: `发现新版本 v${info.version}`,
          body: `当前是 v${info.current_app}，服务器上是 v${info.version}。`
            + '<br>是否现在下载并安装？完整包更新会短暂停退出并由安装器自动完成。'
            + (info.notes ? `<br><br>更新内容：${escapeHTML(info.notes)}` : ''),
          confirmText: '立即更新',
          cancelText: '稍后',
        });
        if (go) { await doAppUpdate(); return; }
      }
    } catch {}
  }
  // 定时轮询：有新更新时侧边栏自动冒红点。
  // 页面不可见 / 离线时跳过，避免后台无意义的请求与耗电。
  setInterval(() => {
    if (!isDesktopApp) return;
    if (document.hidden) return;
    if (navigator.onLine === false) return;
    checkForUpdate(false);
  }, 45000);
}

function openUpdateFolder() {
  tauriInvoke('open_update_folder').catch((e) => toast('打开失败：' + (e.message || e)));
}

// 按运行平台显示/隐藏侧边栏菜单：
// - 桌面端本身就是安装好的程序，「安装应用」毫无意义 → 隐藏
// - 网页端没有客户端可更新，「检查更新」点了只会报"仅桌面版支持" → 隐藏
function initPlatformMenu() {
  const hide = (id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  };
  if (isDesktopApp) {
    // 桌面端本身就是安装好的程序，「下载桌面版」无意义
    hide('download-desktop-btn');
  } else {
    // 网页端没有客户端可更新，「检查更新」点了只会报"仅桌面版支持"
    hide('nav-check-update');
  }

  // 「程序位置」只对桌面版有意义；网页端的卸载语义是"移除已安装的应用"
  hide(isDesktopApp ? null : 'install-location-group');
  const hint = document.getElementById('uninstall-hint');
  if (hint) {
    hint.textContent = isDesktopApp
      ? '将打开系统卸载程序，卸载后本机会移除 PromptForge。卸载前建议先导出一份数据备份。'
      : '将注销本站的 Service Worker 并清除应用缓存（不会删除历史记录与设置）。';
  }
  const btn = document.querySelector('#uninstall-group .btn-danger');
  if (btn) btn.textContent = isDesktopApp ? '卸载 PromptForge' : '移除已安装的应用';

  if (isDesktopApp) {
    tauriInvoke('app_exe_path')
      .then((p) => {
        const el = document.getElementById('app-exe-path');
        if (el) el.textContent = p || '--';
      })
      .catch(() => {});
  }
}

// 下载桌面版安装包。
//
// 设计目标：与主流软件一致 —— 点一下就下载，不弹选择框、不做任何询问。
// 安装包固定为 Latest-Setup.exe，下载地址 = 更新源（或本页部署基址）+ /Latest-Setup.exe，
// 由 sync-dist 同步进 dist/。用绝对地址而非相对路径，才能在任何静态托管（如 GitHub Pages）上正确解析。
//
// 为什么原来是"探测 + 弹窗 + 让用户选格式"，现在要拆掉：
//   1. 探测一段用了 HEAD / Range GET，在 file:// 与部分静态托管下必然抛异常，
//      代码只好给出"探测失败"这一第三态；第三态又要靠弹窗安抚用户，
//      于是「点下载 → 弹窗 → 再点一次」成了常态，还常被当成"点了没反应"。
//   2. exe/msi 二选一对普通用户是纯负担：两者都能装，用户无从判断，
//      选错还要重来。默认给 NSIS（简体中文安装向导、体积更小）即可。
//   3. 探测本身有成本：多两次网络往返，且探测成功也不改变最终动作。
//
// 现在的链路：点击 → 立刻 <a download> 触发下载。探测改为"下载之后再后台复核"，
// 只在真的要出问题时（明确 404）才提示，且提示里给出可手动点的直链。
//
// file:// 的现实限制（无法用代码绕过）：浏览器禁止 file:// 页面用 <a download>
// 触发下载，也禁止脚本读取同目录文件判断是否存在。此时直接告诉用户目标路径。
async function downloadDesktopInstaller() {
  if (isDesktopApp) { toast('你使用的已经是桌面版'); return; }

  const SAVE_AS = 'PromptForge-Setup.exe'; // 保存到本地的文件名，带产品名便于识别

  // 拼出「完整下载地址」：优先用用户设置的更新源 / 本页服务器根地址
  // （如在 GitHub Pages 上就是 https://<用户>.github.io/promptforge），再退回清单里的 updateUrl。
  // 这样按钮在任意静态托管上点一下就下载 https://<部署地址>/Latest-Setup.exe，
  // 不再依赖「页面与 exe 同目录」的相对解析（那种写法在 file:// 下必然失效）。
  //
  // file:// 下不做这步：此时 PF_DEPLOY_BASE 为空，resolveUpdateBaseUrl 会去 fetch('version.json')
  // ——file:// 被视为独立 origin，该请求必然失败（虽被 catch 吞掉，但纯属浪费且在语义上不该联网）。
  let base = '';
  if (location.protocol !== 'file:') {
    base = getUpdateBaseUrl() || window.PF_DEPLOY_BASE || '';
    if (!base) base = await resolveUpdateBaseUrl();
  }
  const TARGET = (base ? base.replace(/\/+$/, '') + '/' : '') + 'Latest-Setup.exe';

  // file://：浏览器协议层面不支持脚本触发下载，这是无法用代码绕过的限制。
  // 唯一的「点一下就能用」出路是双击 启动.bat：在 127.0.0.1 起一个本地静态服务，
  // 浏览器再访问 http://127.0.0.1/... ，全部按钮恢复正常（下载 / 检查更新 / PWA）。
  // 该脚本随发布包一同分发在 dist/ 根目录，参见 README「file:// 与启动器」。
  if (location.protocol === 'file:') {
    await askDialog({
      title: '下载桌面版',
      body: '你正以<strong>本地文件方式</strong>（<code class="mono">file://</code>）打开本页，'
        + '浏览器出于安全策略禁止网页触发文件下载，这一条无法绕过。'
        + '<br><br><strong>推荐做法：</strong>在同一目录下<strong>双击 <code class="mono">启动.bat</code></strong>'
        + '（或 macOS/Linux 上的 <code class="mono">启动.ps1</code>），浏览器会自动打开 <code class="mono">http://127.0.0.1:14370/</code>，'
        + '此时本页所有按钮（下载、安装、检查更新）都恢复正常。'
        + '<br><br><span style="color:var(--text3);font-size:.8rem">'
        + '如确需直接拿安装包，请手动打开项目根目录下的 <code class="mono">dist\</code>（或 <code class="mono">release\</code>）文件夹，'
        + '双击 <code class="mono">Latest-Setup.exe</code> 安装。</span>',
      confirmText: '复制启动器路径',
      cancelText: '关闭',
    }).then(async (ok) => {
      if (!ok) return;
      // file:// 的 path 形如  /C:/Users/.../index.html —— 取目录部分并拼出启动器路径。
      // 任何一步缺字段就回退到「项目根目录」描述，让用户至少有线索。
      try {
        const pn = (typeof location.pathname === 'string') ? location.pathname : '';
        const dir = decodeURIComponent(pn.replace(/\/[^/]*$/, '/') || '');
        if (dir) {
          await navigator.clipboard.writeText(dir + '启动.bat');
          toast('已复制：' + dir + '启动.bat（在资源管理器地址栏粘贴跳转，双击运行）');
          return;
        }
        throw new Error('no pathname');
      } catch {
        toast('启动器在本目录：启动.bat（双击运行即可在 127.0.0.1:14370 打开网页）');
      }
    });
    return;
  }

  // 一键直下：不做任何前置询问，点击即开始。
  const a = document.createElement('a');
  a.href = TARGET;
  a.download = SAVE_AS;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 200);
  toast('已开始下载，完成后双击安装包即可');

  // 后台复核：只有拿到明确的 404 才提示"没有安装包"。
  // 放在下载之后，是为了让"能下载"的主路径零延迟、零打扰。
  // 注意"探测失败 ≠ 文件不存在"：file:// 已在上面提前返回，
  // 这里的失败只可能是被拦或跨域，同样不能据此报错。
  try {
    const head = await fetch(TARGET, { method: 'HEAD', cache: 'no-store' });
    if (head.status === 404) {
      await askDialog({
        title: '未找到安装包',
        body: '下载已触发，但服务器返回 404：网页根目录下没有 <code class="mono">Latest-Setup.exe</code>。'
          + '<br><br>若你是部署者，请先运行 <code class="mono">npm run release</code> 生成安装包，'
          + '再把 <code class="mono">dist/</code> 整个目录（或 <code class="mono">release/</code> 里的文件）'
          + '一并上传，确保 exe 与 <code class="mono">index.html</code> 同级。',
        confirmText: '知道了',
        cancelText: '关闭',
      });
    }
  } catch {}
}

// 启动时拉取内置在线服务配置（与 version.json 同源，改地址不用发新版）
async function initBuiltinService() {
  if (typeof fetchBuiltinService !== 'function') return;
  const base = getUpdateBaseUrl();
  await fetchBuiltinService(base);
  renderBuiltinServiceStatus();
}

// 设置页展示当前实际生效的调用来源，避免用户不知道自己用的是哪个
function renderBuiltinServiceStatus() {
  const el = document.getElementById('builtin-service-status');
  if (!el) return;
  const s = loadSettings();
  const cfg = typeof resolveOnlineConfig === 'function'
    ? resolveOnlineConfig(s)
    : { source: s.endpoint ? 'user' : 'none', sourceName: '你的 API' };
  const b = typeof getBuiltinService === 'function' ? getBuiltinService() : null;

  if (cfg.source === 'user') {
    el.textContent = `当前使用：你在上方填写的 API${b && b.enabled ? '（内置服务已就绪，留空时自动接管）' : ''}`;
    el.className = 'hint';
  } else if (cfg.source === 'builtin') {
    el.textContent = `当前使用：内置在线服务「${cfg.sourceName}」，无需自己配置即可联网使用`;
    el.className = 'hint';
  } else {
    el.textContent = '当前未配置任何在线服务，将使用本地规则引擎或离线模型。'
      + '（发布端可在更新源放置 service.json 下发内置服务，客户端装好即用）';
    el.className = 'hint';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Sidebar nav
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => { if (btn.dataset.view) switchView(btn.dataset.view); });
  });
  // Mobile nav
  document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  // Framework chips
  document.querySelectorAll('.fw-chip').forEach(chip => {
    chip.addEventListener('click', () => selectFramework(chip.dataset.fw));
  });
  // Enter key in textarea
  document.getElementById('user-idea').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      startOptimize();
    }
  });
  
  // 本地模式切换
  const localModeToggle = document.getElementById('set-local-mode');
  if (localModeToggle) {
    localModeToggle.addEventListener('change', () => {
      if (typeof window.checkLocalMode === 'function') {
        window.checkLocalMode();
      }
    });
  }

  // 引擎切换
  setupEngineListeners();

  // Init
  loadSharedFromHash();
  renderTemplates();
  loadSettingsUI();
  initPlatformMenu();
  renderBuiltinServiceStatus();
  registerServiceWorker();
  // 初始化 PWA 功能
  if (typeof PWAInstaller !== 'undefined') {
    PWAInstaller.init();
  }
  // 已配置云同步时，启动后静默拉取其他设备的数据
  if (getSyncConfig().configured) syncNow(false);
  
  // 应用内更新（桌面版自动检查）
  initUpdateSection();

  // 内置在线服务：拉一次配置，让没配 API 的新装用户也能直接联网用
  initBuiltinService();

  // 首屏同步一次导航 aria-current（初始化不经过 switchView，否则首页无任何 aria-current）
  syncNavAriaCurrent(state.currentView || 'new');

  // 如果是离线模式，初始化离线 UI
  const currentEngine = loadSettings().engine;
  if (currentEngine === 'offline') {
    setTimeout(() => {
      if (typeof window.onEngineChange === 'function') {
        window.onEngineChange('offline');
      }
    }, 100);
  }
});