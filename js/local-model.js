// ============================================================
// local-model.js —— 本地离线模型管理（基于 Transformers.js）
// ============================================================

class LocalModelManager {
  constructor() {
    // OfflineLLM 是顶层 const，不会成为 window 属性；必须用裸引用读取
    this.offlineLLM = (typeof OfflineLLM !== 'undefined') ? OfflineLLM : null;
    if (!this.offlineLLM) {
      throw new Error('离线 LLM 模块未加载');
    }
    this.currentModel = null;
    this.isInitialized = false;
    this.isModelLoaded = false;
    this.modelProgress = 0;

    // 模型配置：从 OfflineLLM.MODEL_OPTIONS（全项目唯一数据源）派生，按短键索引。
    // 不要再在这里手写一份副本 —— 历史上 4 份副本导致短键不一致与体积漂移。
    const opts = (this.offlineLLM && this.offlineLLM.MODEL_OPTIONS) || [];
    this.modelInfo = Object.fromEntries(
      opts.map((m) => [m.key, { id: m.id, name: m.name, size: m.size, desc: m.desc }])
    );

    // 检查浏览器支持
    this.checkBrowserSupport();
  }

  checkBrowserSupport() {
    // 检查是否支持必要的 API
    const requiredApis = ['indexedDB', 'caches'];
    for (const api of requiredApis) {
      if (!(api in window)) {
        throw new Error(`浏览器不支持 ${api}`);
      }
    }
    
    // 检查 Transformers.js 支持（OfflineLLM 是顶层 const，需用 typeof 检测）
    if (typeof OfflineLLM === 'undefined') {
      throw new Error('离线 LLM 模块未加载');
    }
  }

  async init() {
    if (this.isInitialized) return true;
    
    try {
      console.log('Initializing local model engine with Transformers.js...');
      
      // 加载用户上次选择的模型
      const savedModel = localStorage.getItem('pf_offline_model');
      if (savedModel && this.modelInfo[savedModel]) {
        const modelConfig = this.modelInfo[savedModel];
        console.log(`Restoring saved model: ${modelConfig.name}`);
      }
      
      this.isInitialized = true;
      console.log('Local model engine initialized');
      return true;
    } catch (error) {
      console.error('Failed to initialize local model engine:', error);
      return false;
    }
  }

  async loadModel(modelType) {
    if (!this.isInitialized) {
      const initialized = await this.init();
      if (!initialized) {
        throw new Error('Failed to initialize local model engine');
      }
    }

    if (this.isModelLoaded && this.currentModel === modelType) {
      return true; // 模型已经加载
    }

    try {
      const modelInfo = this.modelInfo[modelType];
      if (!modelInfo) {
        throw new Error(`Unknown model type: ${modelType}`);
      }

      // 检查模型是否已缓存
      const isCached = await this.offlineLLM.isModelCached(modelInfo.id);
      if (!isCached) {
        throw new Error(`Model ${modelInfo.name} not found. Please download it first.`);
      }

      console.log(`Loading model: ${modelInfo.name}`);
      
      // 使用 Transformers.js 加载模型
      await this.offlineLLM.loadModel(modelInfo.id, (progress) => {
        this.updateProgress(progress);
      });
      
      this.currentModel = modelType;
      this.isModelLoaded = true;
      
      console.log(`Model loaded: ${modelInfo.name}`);
      return true;
    } catch (error) {
      console.error('Failed to load model:', error);
      this.isModelLoaded = false;
      throw error;
    }
  }

  updateProgress(progress) {
    this.modelProgress = progress.progress;

    // 进度回调在模型下载/加载期间被调用，**不能**读设置页控件：
    // 旧版离线控件（set-local-model 等）早已被 #set-engine + #model-cards 取代，
    // getElementById 返回 null、读 .value 会抛空引用崩溃。
    // 状态文案统一由 updateModelStatus(status) 写入 #model-status；需要当前模型时用 this.currentModel。
    if (progress.status === 'downloading') {
      updateModelStatus(`下载中... ${Math.round(progress.progress * 100)}%`);
      window.updateProgress(progress.progress * 100, `下载中... ${Math.round(progress.progress * 100)}%`);
    } else if (progress.status === 'loading') {
      updateModelStatus(`加载中... ${Math.round(progress.progress * 100)}%`);
      window.updateProgress(progress.progress * 100, `加载中... ${Math.round(progress.progress * 100)}%`);
    } else if (progress.status === 'ready') {
      updateModelStatus('已加载');
      window.hideProgress();
    }
  }

  async generate(messages, { signal = null, onUpdate = null } = {}) {
    if (!this.isModelLoaded || !this.currentModel) {
      throw new Error('Model not loaded. Please download and load a model first.');
    }

    try {
      // 创建中止控制器
      const abortController = new AbortController();
      
      if (signal) {
        signal.addEventListener('abort', () => {
          abortController.abort();
        });
      }
      
      // 使用 Transformers.js 生成
      const result = await this.offlineLLM.generate(messages, {
        onToken: onUpdate,
        maxNewTokens: 2048,
        temperature: 0.7,
      });
      
      return result;
    } catch (error) {
      console.error('Failed to generate with local model:', error);
      throw error;
    }
  }

  async downloadModel(modelType) {
    const modelInfo = this.modelInfo[modelType];
    if (!modelInfo) {
      throw new Error(`Unknown model type: ${modelType}`);
    }

    console.log(`Starting download for ${modelInfo.name}`);
    
    try {
      updateModelStatus('准备下载...');
      
      // 检查是否已缓存
      const isCached = await this.offlineLLM.isModelCached(modelInfo.id);
      if (isCached) {
        updateModelStatus('已下载');
        toast('模型已存在');
        return;
      }
      
      // 使用 Transformers.js 下载模型
      await this.offlineLLM.loadModel(modelInfo.id, (progress) => {
        this.updateProgress(progress);
      });
      
      toast('模型下载完成！');
      updateModelStatus('已下载');
      
    } catch (error) {
      console.error('Download failed:', error);
      toast('模型下载失败: ' + error.message);
      updateModelStatus('下载失败');
      throw error;
    }
  }

  unloadModel() {
    if (this.offlineLLM) {
      this.offlineLLM.unloadModel();
    }
    this.currentModel = null;
    this.isModelLoaded = false;
    this.modelProgress = 0;
  }

  getLoadedModel() {
    return this.currentModel;
  }

  isModelAvailable(modelType) {
    if (!this.offlineLLM) return false;
    return this.offlineLLM.isModelCached(this.modelInfo[modelType].id);
  }

  getModelStatus(modelType) {
    const modelInfo = this.modelInfo[modelType];
    if (!modelInfo) return { status: 'error' };
    
    return new Promise((resolve) => {
      this.offlineLLM.isModelCached(modelInfo.id).then(isCached => {
        if (isCached) {
          resolve({ 
            status: 'downloaded',
            modelType,
            name: modelInfo.name,
            size: modelInfo.size,
            desc: modelInfo.desc
          });
        } else {
          resolve({ status: 'not_downloaded' });
        }
      }).catch(() => {
        resolve({ status: 'error' });
      });
    });
  }

  async deleteModelCache(modelType) {
    const modelInfo = this.modelInfo[modelType];
    if (!modelInfo) return;
    
    try {
      await this.offlineLLM.deleteModelCache(modelInfo.id);
      toast(`已删除 ${modelInfo.name} 缓存`);
    } catch (error) {
      console.error('Failed to delete model cache:', error);
      toast('删除缓存失败');
    }
  }

  getDeviceInfo() {
    if (!this.offlineLLM) return null;
    return this.offlineLLM.getDevice();
  }
}

// 创建全局实例（OfflineLLM 是顶层 const 而非 window 属性，用 typeof 检测；失败时降级为空实例）
const localModelManager = (() => {
  try {
    return new LocalModelManager();
  } catch (e) {
    console.warn('本地模型管理器初始化失败（离线模型功能不可用）:', e);
    return null;
  }
})();
window.localModelManager = localModelManager;

// 模型卡片数据：从唯一数据源派生，保留 UI 需要的 icon / recommended
const modelCards = (OfflineLLM.MODEL_OPTIONS || []).map((m) => ({
  id: m.key,
  name: m.name.replace('（推荐）', ''), // 卡片上用徽章表达"推荐"，不重复写进名字
  desc: m.desc,
  size: m.size,
  recommended: !!m.recommended,
  icon: m.icon || '🧩',
}));

// 辅助函数
// 只承载「状态文案」一个职责：写入 #model-status。
// 历史上它带一个从未被使用的 modelType 形参，正是它诱使调用方去读已废弃的下拉框。
function updateModelStatus(status) {
  const statusElement = document.getElementById('model-status');
  if (statusElement) {
    statusElement.textContent = status;
  }
}

// 渲染模型卡片
// 注意：offline-ui.js 中另有一个 renderModelCards（渲染 .offline-model-card，与 CSS 对应），
// 本函数改名为 renderLocalModelCards，避免后加载覆盖掉设置页真正使用的那一个。
async function renderLocalModelCards() {
  const container = document.getElementById('model-cards');
  if (!container) return;

  // isModelAvailable 是异步的，必须 await：否则拿到的是恒为真的 Promise
  const availability = await Promise.all(
    modelCards.map(m => localModelManager.isModelAvailable(m.id).catch(() => false))
  );

  container.innerHTML = modelCards.map((model, i) => {
    const isAvailable = availability[i];
    const isSelected = localModelManager.getLoadedModel() === model.id;

    return `
      <div class="model-card ${isSelected ? 'selected' : ''} ${isAvailable ? 'available' : ''}" 
           onclick="selectModel('${model.id}')">
        <div class="model-card-header">
          <div class="model-icon">${model.icon}</div>
          <div class="model-info">
            <div class="model-name">${model.name}</div>
            <div class="model-desc">${model.desc}</div>
          </div>
          ${model.recommended ? '<div class="model-badge">推荐</div>' : ''}
        </div>
        <div class="model-footer">
          <div class="model-size">${model.size}</div>
          <div class="model-action">
            ${isAvailable ? 
              (isSelected ? '已选择' : '已下载') : 
              '<button class="btn btn-sm" onclick="event.stopPropagation(); downloadModelCard(\'' + model.id + '\')">下载</button>'}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// 选择模型
async function selectModel(modelId) {
  const model = modelCards.find(m => m.id === modelId);
  if (!model) return;

  // 检查模型是否可用（异步）
  const available = await localModelManager.isModelAvailable(modelId).catch(() => false);
  if (!available) {
    toast('请先下载该模型');
    return;
  }

  // 加载模型
  localModelManager.loadModel(modelId).then(() => {
    toast(`已选择 ${model.name}`);
    renderLocalModelCards();

    // 保存设置
    const settings = loadSettings();
    settings.localModel = modelId;
    saveSettingsToStorage(settings);
  }).catch(error => {
    toast('模型加载失败: ' + error.message);
  });
}

// 下载模型（卡片版本）
function downloadModelCard(modelId) {
  const model = modelCards.find(m => m.id === modelId);
  if (!model) return;
  
  showProgress(`正在下载 ${model.name}...`);
  
  localModelManager.downloadModel(modelId).then(() => {
    hideProgress();
    toast(`${model.name} 下载完成！`);
    renderLocalModelCards();
  }).catch(error => {
    hideProgress();
    toast('下载失败: ' + error.message);
  });
}

// 显示进度
function showProgress(text = '准备中...') {
  const progressDiv = document.getElementById('model-progress');
  const progressText = document.getElementById('progress-text');
  const progressPct = document.getElementById('progress-pct');
  const progressBar = document.getElementById('progress-bar');
  
  if (progressDiv) progressDiv.style.display = 'block';
  if (progressText) progressText.textContent = text;
  if (progressPct) progressPct.textContent = '0%';
  if (progressBar) progressBar.style.width = '0%';
}

// 更新进度
function updateProgress(progress, text = '') {
  const progressPct = document.getElementById('progress-pct');
  const progressBar = document.getElementById('progress-bar');
  const progressText = document.getElementById('progress-text');
  
  if (progressPct) progressPct.textContent = Math.round(progress) + '%';
  if (progressBar) progressBar.style.width = progress + '%';
  if (progressText && text) progressText.textContent = text;
}

// 隐藏进度
function hideProgress() {
  const progressDiv = document.getElementById('model-progress');
  if (progressDiv) progressDiv.style.display = 'none';
}

// 显示设备信息
function showDeviceInfo() {
  const deviceInfo = document.getElementById('device-info');
  if (!deviceInfo) return;
  
  const device = localModelManager.getDeviceInfo();
  const info = [
    '设备信息:',
    `后端: ${device === 'webgpu' ? 'WebGPU (推荐)' : 'WASM'}`,
    '状态: 支持本地模型'
  ];
  
  deviceInfo.innerHTML = info.join('<br>');
}

// 说明：此处的 window.initOfflineModels 已删除 —— 它只是 onEngineChange('offline') 的薄包装，
// 全仓无任何调用者（无内联 handler、无脚本引用），属死代码；本项目无插件机制，
// 不构成对外扩展点。离线入口统一走 #set-engine 触发 onEngineChange()。

// ============================================================
// 本处原有 4 个全局函数已删除：downloadLocalModel / checkLocalMode /
// saveLocalSettings / manageLocalModels。
//
// 删除原因：它们全部依赖早被废弃的旧版离线控件 id ——
//   set-local-mode / set-local-model / local-model-config
// 这些 id 在新界面中并不存在（引擎选择改用 #set-engine，模型选择改用
// #model-cards），因此 getElementById 返回 null，读 .value / .checked
// 会抛「Cannot read properties of null」崩溃；而全仓已无任何调用者，
// 保留它们只会制造随时会被触发的活雷（downloadLocalModel 尤其危险）。
//
// 与之等价的能力由 offline-ui.js 的 renderModelCards() / selectModel() /
// downloadModelCard() 与 localModelManager 提供，属既有做法（此前已这样
// 删除了浮动安装按钮与旧的独立模型管理模块）。
// ============================================================

// 获取设备信息
window.getDeviceInfo = function() {
  return localModelManager.getDeviceInfo();
};