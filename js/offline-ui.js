// ========== 离线模型 UI 控制 ==========
// 说明：onEngineChange 统一由 app.js 实现（含本页 renderModelCards / renderDeviceInfo 调用），
// 此处不再重复定义，避免同名函数相互覆盖。

async function renderDeviceInfo() {
  const el = document.getElementById('device-info');
  if (!el) return;

  try {
    // 检测设备信息
    const deviceInfo = await DeviceDetector.detectDevice();
    const device = await OfflineLLM.getDevice();
    
    // 生成设备信息HTML
    const deviceHtml = `
      <div class="device-info-container">
        <div class="device-info-header">
          <strong>设备信息</strong>
          <button class="btn btn-ghost btn-sm" onclick="refreshDeviceInfo()">刷新</button>
        </div>
        <div class="device-info-grid">
          <div class="device-info-item">
            <span class="device-label">设备类型：</span>
            <span class="device-value">${getDeviceTypeName(deviceInfo.recommendation.deviceType)}</span>
          </div>
          <div class="device-info-item">
            <span class="device-label">内存：</span>
            <span class="device-value">${deviceInfo.memory}GB RAM</span>
          </div>
          <div class="device-info-item">
            <span class="device-label">CPU：</span>
            <span class="device-value">${deviceInfo.cpuCores} 核</span>
          </div>
          <div class="device-info-item">
            <span class="device-label">GPU：</span>
            <span class="device-value ${deviceInfo.gpuSupport ? 'gpu-supported' : 'gpu-unsupported'}">${deviceInfo.gpu}</span>
          </div>
          <div class="device-info-item">
            <span class="device-label">屏幕：</span>
            <span class="device-value">${deviceInfo.screen.width}×${deviceInfo.screen.height}</span>
          </div>
          <div class="device-info-item">
            <span class="device-label">推荐模型：</span>
            <span class="device-value recommended-model">${deviceInfo.recommendation.model}</span>
          </div>
        </div>
        <div class="device-recommendations">
          ${deviceInfo.recommendation.warnings.map(w => `<div class="device-warning">${w}</div>`).join('')}
          ${deviceInfo.recommendation.suggestions.map(s => `<div class="device-suggestion">${s}</div>`).join('')}
        </div>
      </div>
    `;
    
    el.innerHTML = deviceHtml;

    // 推荐模型「展示名 → 短键」薄映射：这是「推荐名 ↔ 短键」的唯一对齐点，
    // 由 check-model-metadata §E 守护（键集合须等于模型卡片展示名集合、值须能被 resolveModel 解析）。
    // 设备检测算出的推荐模型此前被丢弃（旧版只回填早已不存在的 #set-local-model 下拉框）；
    // 这里按 data-model-id 在模型卡片区定位到对应卡片，标出「本机推荐」，让推荐真正可见。
    if (deviceInfo.recommendation.model) {
      const nameToKey = {
        'Qwen2.5-1.5B': 'qwen25',
        'Phi-3.5 Mini': 'phi35',
        'SmolLM2-1.7B': 'smollm',
      };
      const entry = OfflineLLM.resolveModel(nameToKey[deviceInfo.recommendation.model]);
      if (!entry) {
        // 映射失效（推荐名不在 nameToKey 里）：不抛异常，仅告警，避免「本机推荐」静默消失。
        console.warn('设备推荐模型无法映射到模型清单：' + deviceInfo.recommendation.model);
      } else {
        const cardsBox = document.getElementById('model-cards');
        const card = cardsBox ? cardsBox.querySelector('[data-model-id="' + entry.id + '"]') : null;
        if (card) {
          card.classList.add('device-recommended');
          if (!card.querySelector('.offline-model-device-badge')) { // 幂等：避免重复插入徽章
            const badge = document.createElement('span');
            badge.className = 'offline-model-device-badge';
            badge.textContent = '本机推荐';
            (card.querySelector('.offline-model-title') || card).appendChild(badge);
          }
        }
      }
    }

  } catch (error) {
    console.error('设备信息检测失败:', error);
    // 错误消息可能来自外部，用 textContent 写入避免注入
    el.innerHTML = `
      <div class="device-error">
        <strong>设备信息检测失败</strong>
        <div class="device-error-msg" style="color: var(--text3); font-size: 0.82rem; margin-top: 0.5rem;"></div>
        <button class="btn btn-ghost btn-sm" onclick="refreshDeviceInfo()" style="margin-top: 0.5rem;">重试</button>
      </div>
    `;
    const msgEl = el.querySelector('.device-error-msg');
    if (msgEl) msgEl.textContent = (error && error.message) ? error.message : String(error);
  }
}

function getDeviceTypeName(type) {
  const typeNames = {
    mobile: '📱 移动设备',
    tablet: '📱 平板设备', 
    desktop: '💻 桌面设备',
  };
  return typeNames[type] || '❓ 未知设备';
}

function refreshDeviceInfo() {
  renderDeviceInfo();
}

function renderModelCards() {
  const container = document.getElementById('model-cards');
  if (!container) return;

  const currentModel = localStorage.getItem('pf_offline_model') || '';

  container.innerHTML = OfflineLLM.MODEL_OPTIONS.map(m => {
    const isSelected = currentModel === m.id;
    const isLoaded = OfflineLLM.getCurrentModel() === m.id;
    return `
      <div class="offline-model-card ${isLoaded ? 'loaded' : ''}" data-model-id="${m.id}">
        <div class="offline-model-info">
          <div class="offline-model-title">
            <span class="offline-model-name">${m.name}</span>
            ${m.recommended ? '<span class="offline-model-badge">推荐</span>' : ''}
            ${isLoaded ? '<span class="offline-model-status">已加载</span>' : ''}
          </div>
          <p class="offline-model-desc">${m.desc}</p>
          <span class="offline-model-size">大小：${m.size}</span>
        </div>
        <div class="offline-model-actions">
          ${isLoaded
            ? `<button class="btn btn-ghost btn-sm" onclick="unloadOfflineModel()">卸载</button>`
            : `<button class="btn btn-primary btn-sm" onclick="downloadAndLoadModel('${m.id}')">下载加载</button>`
          }
          <button class="btn btn-ghost btn-sm" onclick="deleteOfflineModel('${m.id}')" style="font-size:.72rem;color:var(--text3)">清除缓存</button>
        </div>
      </div>
    `;
  }).join('');
}

async function downloadAndLoadModel(modelId) {
  const progressContainer = document.getElementById('model-progress');
  const progressText = document.getElementById('progress-text');
  const progressPct = document.getElementById('progress-pct');
  const progressBar = document.getElementById('progress-bar');
  const statusEl = document.getElementById('model-status');

  progressContainer.style.display = 'block';

  try {
    await OfflineLLM.loadModel(modelId, ({ status, message, progress }) => {
      const pct = Math.round(progress * 100);
      progressText.textContent = message;
      progressPct.textContent = `${pct}%`;
      progressBar.style.width = `${pct}%`;
    });

    setModelStatus('✓ 模型已就绪，可以离线使用了', 'var(--accent)');
    renderModelCards();
  } catch (err) {
    // err.message 可能来自远端（HF 仓库报错、网络错误体），不能拼进 innerHTML。
    // 用 textContent 写入，天然免疫注入。
    setModelStatus('加载失败：' + (err && err.message ? err.message : String(err)), 'var(--danger)');
  } finally {
    // 3 秒后隐藏进度条
    setTimeout(() => {
      if (progressContainer) progressContainer.style.display = 'none';
    }, 3000);
  }
}

// 统一样式地写入状态文本。用 textContent 而非 innerHTML —— 内容可能含外部输入。
function setModelStatus(text, color) {
  const el = document.getElementById('model-status');
  if (!el) return;
  el.textContent = text;
  el.style.color = color || '';
}

async function unloadOfflineModel() {
  await OfflineLLM.unloadModel();
  renderModelCards();
  setModelStatus('模型已卸载，内存已释放', 'var(--text2)');
}

async function deleteOfflineModel(modelId) {
  // 删除缓存属破坏性操作，统一走主题化弹窗（原生 confirm 无法主题化/体现危险色）
  const ok = await askDialog({
    title: '清除模型缓存',
    body: '确定要删除该模型的本地缓存吗？需要重新下载才能使用。',
    confirmText: '清除',
    cancelText: '取消',
    danger: true,
  });
  if (!ok) return;
  await OfflineLLM.deleteModelCache(modelId);
  if (OfflineLLM.getCurrentModel() === modelId) {
    await OfflineLLM.unloadModel();
  }
  renderModelCards();
  setModelStatus('缓存已清除', 'var(--text2)');
}