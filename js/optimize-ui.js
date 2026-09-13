// ============================================================
// optimize-ui.js —— 「提示词优化」视图：输入已有提示词 → 一键优化 → 原文/优化版对比
//   依赖：optimizer.js（引擎）、app.js（toast / escapeHTML / scheduleWrite / switchView）
// ============================================================

const optState = {
  original: '',
  optimized: '',
  lang: 'auto',
  engine: 'local',
  style: 'auto',     // auto | standard | minimal | roleplay | stepwise | annotated | checklist
  styleUsed: '',     // 上一次实际生效的风格（auto 时由引擎决定）
  mode: 'split',     // split | diff
  busy: false,
  changes: [],
  report: null,
  controller: null,
  lastReplaced: '',  // 「替换为优化版」前的原文，用于还原
};

const OPT_EXAMPLE = `帮我写一篇关于 AI 教育的小红书笔记
面向 3-12 岁孩子的年轻妈妈
要口语化、有共鸣
500 字左右`;

function optEl(id) { return document.getElementById(id); }

// ---- 输入区 --------------------------------------------------------------
function initOptimizeView() {
  buildStyleOptions();
  renderStylePills();
  onOptEngineChange();
  updateOptDiagnosis();
}

// 用 StyleVariants 的元数据填充「版式风格」下拉，避免在 HTML 里硬编码重复一份
function buildStyleOptions() {
  const sel = optEl('opt-style');
  if (!sel || sel.dataset.built === '1') return;
  const styles = (typeof StyleVariants !== 'undefined' && StyleVariants.getStyles)
    ? StyleVariants.getStyles()
    : [];
  let html = '<option value="auto">自动挑选（按内容特征）</option>';
  styles.forEach((s) => {
    html += `<option value="${escapeHTML(s.key)}">${escapeHTML(s.zh)}</option>`;
  });
  sel.innerHTML = html;
  sel.dataset.built = '1';
}

function onOptStyleChange() {
  const sel = optEl('opt-style');
  optState.style = sel ? sel.value : 'auto';
  updateOptStyleHint();
  // 已经出过结果的话，换风格后立刻用同一份输入重渲染，方便用户对比挑一个
  if (optState.original.trim() && !optState.busy && optState.engine !== 'llm') {
    runLocalOptimize(optState.original.trim());
  }
}

function updateOptStyleHint() {
  const box = optEl('opt-style-desc');
  if (!box) return;
  if (optState.style === 'auto') {
    box.textContent = '按输入长短、是否含步骤、是否已有角色等特征自动选一种版式';
    return;
  }
  const styles = (typeof StyleVariants !== 'undefined' && StyleVariants.getStyles) ? StyleVariants.getStyles() : [];
  const hit = styles.find((s) => s.key === optState.style);
  box.textContent = hit ? hit.zhDesc : '';
}

function onOptEngineChange() {
  const sel = optEl('opt-engine');
  optState.engine = sel ? sel.value : 'local';
  // 版式风格只作用于本地规则引擎：AI 深度优化输出由模型自行组织
  const styleField = optEl('opt-style-field');
  if (styleField) styleField.classList.toggle('hidden', optState.engine === 'llm');
  const hint = optEl('opt-hint');
  if (hint && !optState.busy) {
    hint.textContent = optState.engine === 'llm'
      ? 'AI 深度优化会调用设置里配置的模型（在线 API 或本地离线模型均可）'
      : '本地规则优化完全在本机完成，不联网、不消耗 token、不配 API 也能用';
  }
  updateOptStyleHint();
}

// 输入时的实时体检：语言 + 五维命中情况。
//
// 防抖：index.html 的 oninput 每敲一个字符就会触发本函数，长提示词下全量 analyze()
// 明显卡顿。这里做 250ms 防抖 —— 停手后才真正诊断，中间输入不重复计算。
// 注意：必须保留 `function updateOptDiagnosis()` 这个名字与声明形式 ——
// 内联 handler 通过 window 查找它，改成 const 会让 oninput 绑定整体失效。
// 真正的诊断逻辑挪到内部函数 runOptDiagnosis。
let _optDiagTimer = 0;
const OPT_DIAG_DEBOUNCE_MS = 250;

function updateOptDiagnosis() {
  clearTimeout(_optDiagTimer);
  _optDiagTimer = setTimeout(runOptDiagnosis, OPT_DIAG_DEBOUNCE_MS);
}

function runOptDiagnosis() {
  const ta = optEl('opt-input');
  const box = optEl('opt-scan');
  if (!ta || !box) return;
  const text = ta.value;
  optState.original = text;

  if (!text.trim()) { box.innerHTML = ''; optState.report = null; return; }

  const rep = PromptOptimizer.analyze(text);
  optState.report = rep;
  const langLabel = rep.lang.mixed
    ? '中英混合 · 主导 ' + (rep.lang.primary === 'zh' ? '中文' : 'English')
    : (rep.lang.primary === 'zh' ? '中文' : 'English');

  box.innerHTML =
    `<span class="opt-chip ok">${escapeHTML(langLabel)}</span>` +
    `<span class="opt-chip">${text.trim().length} 字</span>` +
    rep.dims.map((d) =>
      `<span class="opt-chip ${d.hit ? 'ok' : ''}">${d.hit ? '✓' : '✗'} ${escapeHTML(d.label)}</span>`
    ).join('');
}

function optInputKeydown(e) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    optimizePromptNow();
  }
}

function fillOptExample() {
  const ta = optEl('opt-input');
  if (!ta) return;
  ta.value = OPT_EXAMPLE;
  updateOptDiagnosis();
  ta.focus();
}

function clearOptimizer() {
  const ta = optEl('opt-input');
  if (ta) ta.value = '';
  optState.original = '';
  optState.optimized = '';
  optState.changes = [];
  optState.report = null;
  optState.lastReplaced = '';
  showOptResult(false);
  const scan = optEl('opt-scan');
  if (scan) scan.innerHTML = '';
  const undo = optEl('btn-opt-undo');
  if (undo) undo.disabled = true;
  const ta2 = optEl('opt-input');
  if (ta2) ta2.focus();
}

// ---- 主流程 --------------------------------------------------------------
async function optimizePromptNow() {
  if (optState.busy) return;
  const ta = optEl('opt-input');
  const src = (ta ? ta.value : '').trim();
  if (!src) { toast('请先粘贴或输入要优化的提示词'); if (ta) ta.focus(); return; }

  const langSel = optEl('opt-lang');
  optState.lang = langSel ? langSel.value : 'auto';
  optState.original = ta ? ta.value : src;

  setOptBusy(true);
  showOptResult(true);
  resetResultPanes();

  try {
    if (optState.engine === 'llm') await runLLMOptimize(src);
    else runLocalOptimize(src);
  } catch (err) {
    if (err && err.name === 'AbortError') toast('已停止优化');
    else toast('优化失败: ' + ((err && err.message) || err));
  } finally {
    optState.controller = null;
    setOptBusy(false);
  }
}

function runLocalOptimize(src) {
  const res = PromptOptimizer.optimizeLocal(src, { lang: optState.lang, style: optState.style });
  optState.optimized = res.optimized;
  optState.changes = res.changes || [];
  optState.styleUsed = res.style || 'standard';
  renderOptimizeResult({
    optimized: res.optimized,
    changes: res.changes,
    report: res.report,
    scoreBefore: res.scoreBefore,
    scoreAfter: res.scoreAfter,
    engine: 'local',
    style: res.style,
  });
}

async function runLLMOptimize(src) {
  const s = loadSettings();
  const cfg = typeof resolveOnlineConfig === 'function' ? resolveOnlineConfig(s) : null;
  // 没配 API 但有内置服务时照样能跑，不再把用户赶去设置页
  if (s.engine !== 'offline' && !s.endpoint && !(cfg && cfg.source === 'builtin')) {
    toast('请先在设置中配置 API，或改用「本地规则」引擎');
    switchView('settings');
    return;
  }

  const req = PromptOptimizer.buildLLMRequest(src, { lang: optState.lang });
  const controller = new AbortController();
  optState.controller = controller;
  activeControllers.add(controller);

  const area = optEl('opt-new-area');
  try {
    const raw = await callLLM(req.messages, {
      stream: true,
      signal: controller.signal,
      onUpdate: (t) => {
        optState.optimized = t;
        scheduleWrite(area,
          () => escapeHTML(t) + '<span class="cursor"></span>',
          () => { if (area) area.scrollTop = area.scrollHeight; });
      },
    });

    cancelPendingWrite(area);
    const cleaned = PromptOptimizer.stripCodeFence(raw);
    optState.optimized = cleaned;

    const after = PromptOptimizer.analyze(cleaned);
    optState.changes = buildLLMChanges(req.report, after, req.lang);
    renderOptimizeResult({
      optimized: cleaned,
      changes: optState.changes,
      report: req.report,
      scoreBefore: req.report.score,
      scoreAfter: after.score,
      engine: 'llm',
    });
  } finally {
    activeControllers.delete(controller);
  }
}

function buildLLMChanges(before, after, lang) {
  const out = [];
  const afterMap = new Map(after.dims.map((d) => [d.key, d.hit]));
  before.dims.forEach((d) => {
    if (!d.hit && afterMap.get(d.key)) {
      out.push(lang === 'en' ? `Completed "${d.label}"` : `已补全「${d.label}」`);
    }
  });
  if (!out.length) {
    out.push(lang === 'en'
      ? 'No missing dimension found; the wording and structure were tightened.'
      : '未发现明显缺失维度，已对措辞与结构做清晰化重写');
  }
  const gain = after.score - before.score;
  out.unshift((lang === 'en' ? 'Completeness score: ' : '完整度评分：')
    + before.score + ' → ' + after.score + (gain > 0 ? ' (+' + gain + ')' : ''));
  return out;
}

function stopOptimize() {
  if (!optState.busy) { toast('当前没有进行中的优化'); return; }
  if (typeof OfflineLLM !== 'undefined' && OfflineLLM.isBusy && OfflineLLM.isBusy()) {
    OfflineLLM.stopGeneration();
  }
  if (optState.controller) optState.controller.abort();
  toast('已停止');
}

// ---- 结果渲染 ------------------------------------------------------------
function showOptResult(show) {
  const box = optEl('opt-result');
  if (box) box.classList.toggle('hidden', !show);
}

function resetResultPanes() {
  const oa = optEl('opt-orig-area');
  const na = optEl('opt-new-area');
  const da = optEl('opt-diff-area');
  cancelPendingWrite(oa); cancelPendingWrite(na); cancelPendingWrite(da);
  if (oa) oa.innerHTML = '<span style="color:var(--text3)">' + escapeHTML(optState.original) + '</span>';
  if (na) na.innerHTML = '<span class="cursor"></span>';
  if (da) da.innerHTML = '';
  const rep = optEl('opt-report');
  if (rep) rep.innerHTML = '<span style="color:var(--text3);font-size:.85rem">优化中…</span>';
  const chg = optEl('opt-changes');
  if (chg) chg.innerHTML = '';
}

function scoreClass(v) {
  return v >= 8 ? '' : (v >= 5 ? 'mid' : 'bad');
}

function styleLabel(key) {
  const styles = (typeof StyleVariants !== 'undefined' && StyleVariants.getStyles) ? StyleVariants.getStyles() : [];
  const hit = styles.find((s) => s.key === key);
  return hit ? hit.zh : (key || 'standard');
}

// 结果区顶部的风格切换：换一种版式，用同一份输入立刻重渲染
function switchOptimizeStyle(key) {
  if (!optState.original.trim()) { toast('请先输入要优化的提示词'); return; }
  optState.style = key;
  const sel = optEl('opt-style');
  if (sel) sel.value = key;
  updateOptStyleHint();
  syncStylePills();
  if (optState.engine === 'llm') {
    toast('版式风格只作用于本地规则引擎');
    return;
  }
  runLocalOptimize(optState.original.trim());
  if (optState.mode === 'diff') renderOptDiff();
  toast('已切换为「' + styleLabel(optState.styleUsed) + '」版式');
}

// 结果区的风格胶囊：渲染一次，之后只切换 active 态
function renderStylePills() {
  const box = optEl('opt-style-pills');
  if (!box) return;
  const styles = (typeof StyleVariants !== 'undefined' && StyleVariants.getStyles) ? StyleVariants.getStyles() : [];
  const pills = [{ key: 'auto', zh: '自动' }].concat(styles);
  box.innerHTML = pills.map((s) =>
    `<button type="button" class="opt-pill" data-style="${escapeHTML(s.key)}" ` +
    `onclick="switchOptimizeStyle('${escapeHTML(s.key)}')">${escapeHTML(s.zh)}</button>`
  ).join('');
  syncStylePills();
}

function syncStylePills() {
  const box = optEl('opt-style-pills');
  if (!box) return;
  const active = optState.styleUsed || optState.style;
  Array.prototype.forEach.call(box.querySelectorAll('.opt-pill'), (b) => {
    b.classList.toggle('active', b.getAttribute('data-style') === active);
  });
}

function renderOptimizeResult(res) {
  const report = res.report || PromptOptimizer.analyze(optState.original);
  const after = res.scoreAfter;
  const lang = report.lang;
  const langLabel = lang && lang.mixed
    ? '中英混合'
    : (lang && lang.primary === 'en' ? 'English' : '中文');

  const rep = optEl('opt-report');
  if (rep) {
    rep.innerHTML =
      `<span class="opt-score ${scoreClass(report.score)}">${report.score}</span>` +
      `<span style="color:var(--text3)">→</span>` +
      `<span class="opt-score ${scoreClass(after)}">${after}</span>` +
      `<span style="font-size:.82rem;color:var(--text2)">/ 10 完整度</span>` +
      `<span class="tag">${res.engine === 'llm' ? 'AI 深度优化' : '本地规则优化'}</span>` +
      (res.engine === 'llm' ? '' : `<span class="tag">版式: ${escapeHTML(styleLabel(res.style))}</span>`) +
      `<span class="tag">输出语言: ${escapeHTML(langLabel)}</span>`;
  }

  const chg = optEl('opt-changes');
  if (chg) {
    chg.innerHTML = '<ul>' + (res.changes || []).map((c) => `<li>${escapeHTML(String(c))}</li>`).join('') + '</ul>';
  }

  // 结果区版式切换条（仅本地规则引擎有意义）
  if (res.engine !== 'llm') renderStylePills();
  else { const pills = optEl('opt-style-pills'); if (pills) pills.innerHTML = ''; }

  const oa = optEl('opt-orig-area');
  const na = optEl('opt-new-area');
  cancelPendingWrite(oa); cancelPendingWrite(na);
  if (oa) oa.innerHTML = escapeHTML(optState.original);
  if (na) na.innerHTML = escapeHTML(res.optimized);

  const om = optEl('opt-orig-meta');
  const nm = optEl('opt-new-meta');
  if (om) om.textContent = `${report.length} 字`;
  if (nm) { nm.textContent = `${res.optimized.length} 字`; nm.className = 'cmp-status done'; }

  if (optState.mode === 'diff') renderOptDiff();
}

function setOptMode(mode) {
  optState.mode = mode;
  const split = optEl('opt-split');
  const diff = optEl('opt-diff-area');
  const on = (id, active) => { const b = optEl(id); if (b) b.classList.toggle('active', active); };
  on('opt-mode-split', mode === 'split');
  on('opt-mode-diff', mode === 'diff');
  if (split) split.classList.toggle('hidden', mode !== 'split');
  if (diff) diff.classList.toggle('hidden', mode !== 'diff');
  if (mode === 'diff') renderOptDiff();
}

function renderOptDiff() {
  const box = optEl('opt-diff-area');
  if (!box) return;
  cancelPendingWrite(box);
  const ops = PromptOptimizer.diffLines(optState.original, optState.optimized);
  if (!ops) {
    box.innerHTML = '<span style="color:var(--text3)">文本过长，已跳过逐行比对，请查看「并排对比」。</span>\n\n'
      + escapeHTML(optState.optimized);
    return;
  }
  let add = 0, del = 0;
  const html = ops.map((o) => {
    const t = o.text === '' ? ' ' : escapeHTML(o.text);
    if (o.type === 'add') { add++; return `<span class="diff-add">+ ${t}</span>`; }
    if (o.type === 'del') { del++; return `<span class="diff-del">- ${t}</span>`; }
    return `<span class="diff-same">  ${t}</span>`;
  }).join('');
  const head = `<div style="color:var(--text3);font-size:.78rem;margin-bottom:.6rem;font-family:var(--font-display)">`
    + `新增 ${add} 行 · 移除 ${del} 行 · 未变 ${ops.length - add - del} 行</div>`;
  box.innerHTML = head + html;
}

function setOptBusy(v) {
  optState.busy = v;
  const run = optEl('btn-opt-run');
  const stop = optEl('btn-opt-stop');
  if (run) { run.disabled = v; run.textContent = v ? '优化中…' : '⚡ 一键优化'; }
  if (stop) stop.classList.toggle('hidden', !v);
  const hint = optEl('opt-hint');
  if (hint) {
    if (v) hint.textContent = optState.engine === 'llm' ? '正在调用模型重写提示词…' : '正在按规则重组并补全…';
    else onOptEngineChange();
  }
}

// ---- 结果操作 ------------------------------------------------------------
function optCopy(text, okMsg) {
  if (!text) { toast('还没有可复制的内容'); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(okMsg)).catch(() => optFallbackCopy(text, okMsg));
  } else {
    optFallbackCopy(text, okMsg);
  }
}

function optFallbackCopy(text, okMsg) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast(okMsg);
  } catch {
    toast('复制失败，请手动选中复制');
  }
}

function copyOptimizedText() {
  if (!optState.optimized) { toast('还没有优化结果'); return; }
  optCopy(optState.optimized, '优化版提示词已复制');
}

function replaceOriginalWithOptimized() {
  if (!optState.optimized) { toast('还没有优化结果'); return; }
  const ta = optEl('opt-input');
  if (!ta) return;
  optState.lastReplaced = ta.value;
  ta.value = optState.optimized;
  optState.original = optState.optimized;
  updateOptDiagnosis();
  const undo = optEl('btn-opt-undo');
  if (undo) undo.disabled = false;
  const oa = optEl('opt-orig-area');
  if (oa) oa.innerHTML = escapeHTML(optState.original);
  if (optState.mode === 'diff') renderOptDiff();
  toast('已替换输入框内容（可点「还原」撤销）');
}

function undoReplace() {
  if (!optState.lastReplaced) { toast('没有可还原的内容'); return; }
  const ta = optEl('opt-input');
  if (ta) ta.value = optState.lastReplaced;
  optState.original = optState.lastReplaced;
  optState.lastReplaced = '';
  const undo = optEl('btn-opt-undo');
  if (undo) undo.disabled = true;
  updateOptDiagnosis();
  const oa = optEl('opt-orig-area');
  if (oa) oa.innerHTML = escapeHTML(optState.original);
  if (optState.mode === 'diff') renderOptDiff();
  toast('已还原为优化前的原文');
}

function sendOptimizedToNew() {
  if (!optState.optimized) { toast('还没有优化结果'); return; }
  const idea = optEl('user-idea');
  if (!idea) return;
  idea.value = optState.optimized;
  state.userIdea = optState.optimized;
  switchView('new');
  showStep('input');
  idea.focus();
  toast('已填入「新建优化」，可继续用框架生成完整提示词');
}

function saveOptimizedToHistory() {
  if (!optState.optimized) { toast('还没有优化结果'); return; }
  addHistory({
    id: nextHistoryId(),
    idea: '[提示词优化] ' + String(optState.original || '').slice(0, 50),
    framework: 'optimize',
    output: optState.optimized,
    date: new Date().toLocaleString('zh-CN'),
    updatedAt: Date.now(),
  });
  toast('已保存到历史记录');
  if (getSyncConfig().configured) syncNow(false);
}
