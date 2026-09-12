// ============================================================
// export.js —— 导出与导入（Markdown / JSON / PDF、全量备份与恢复）
// ============================================================

// Export 多格式导出
// ============================================================
function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportMarkdown() {
  if (!state.outputText) { toast('请先生成提示词'); return; }
  const fwName = FRAMEWORKS[state.outputFramework]?.name || state.outputFramework;
  const md = `# 优化后的提示词

- 框架：${fwName}
- 原始想法：${state.userIdea}
- 生成时间：${new Date().toLocaleString('zh-CN')}

---

${state.outputText}
`;
  downloadFile(`prompt-${Date.now()}.md`, md, 'text/markdown;charset=utf-8');
  toast('已导出 Markdown');
}

function exportJSON() {
  if (!state.outputText) { toast('请先生成提示词'); return; }
  const data = {
    app: 'PromptForge',
    version: 1,
    idea: state.userIdea,
    framework: state.outputFramework,
    output: state.outputText,
    date: new Date().toISOString(),
  };
  downloadFile(`prompt-${Date.now()}.json`, JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
  toast('已导出 JSON');
}

function exportPDF() {
  if (!state.outputText) { toast('请先生成提示词'); return; }
  window.print();
}

// ============================================================
function exportAllData() {
  const data = {
    app: 'PromptForge',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: loadSettings(),
    history: loadHistory(),
  };
  downloadFile(`promptforge-backup-${Date.now()}.json`, JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
  toast('已导出全部数据');
}

function importAllData(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || (typeof data.settings !== 'object' && !Array.isArray(data.history))) {
        throw new Error('不是有效的 PromptForge 备份文件');
      }
      if (!confirm('导入将覆盖当前的历史记录与 API 设置，确定继续吗？')) return;
      if (Array.isArray(data.history)) {
        localStorage.setItem('pf_history', JSON.stringify(data.history.slice(0, 50)));
      }
      if (data.settings && typeof data.settings === 'object') {
        saveSettingsToStorage(Object.assign(loadSettings(), data.settings));
      }
      renderHistory();
      loadSettingsUI();
      toast('导入成功');
    } catch (err) {
      toast('导入失败: ' + err.message);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// ============================================================