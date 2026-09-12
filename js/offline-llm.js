/**
 * PromptForge 离线大模型模块
 * 基于 Transformers.js，支持 WebGPU / WASM 双后端
 */

const OfflineLLM = (() => {
  // ========== 可用模型列表（全项目唯一数据源）==========
  // 这是模型元数据的唯一事实源。local-model.js 的 this.modelInfo / modelCards
  // 都从 MODEL_OPTIONS 派生，不要另建副本 —— 历史上有 4 份副本，
  // 直接导致短键不一致（smollm vs smollm2）与 sizeBytes 硬编码漂移。
  //
  // 字段约定：
  //   key     短键，用于 localStorage 的 pf_offline_model 与设置页下拉框
  //   id      HuggingFace 仓库全名，传给 Transformers.js
  //   size    人类可读体积（UI 展示）
  //   sizeBytes 精确字节数（存储空间校验）
  //   dtype   量化精度，须与仓库实际提供的文件一致
  const MODEL_OPTIONS = [
    {
      key: 'qwen25',
      id: 'onnx-community/Qwen2.5-1.5B-Instruct',
      name: 'Qwen2.5-1.5B（推荐）',
      size: '~1.5GB',
      sizeBytes: 1500000000,
      desc: '中文能力优秀，提示词优化效果最好',
      quantized: true,
      dtype: 'q4',
      recommended: true,
      icon: '🌟',
    },
    {
      key: 'phi35',
      id: 'onnx-community/Phi-3.5-mini-instruct-onnx-web',
      name: 'Phi-3.5 Mini',
      size: '~2.2GB',
      sizeBytes: 2200000000,
      desc: '英文能力强，通用推理能力好',
      quantized: true,
      // 该仓库仅提供 q4f16 量化文件（model_q4f16.onnx）
      dtype: 'q4f16',
      icon: '🚀',
    },
    {
      key: 'smollm',
      id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct',
      name: 'SmolLM2-1.7B',
      size: '~1.0GB',
      sizeBytes: 1000000000,
      desc: '最轻量，适合手机等低内存设备',
      quantized: true,
      dtype: 'q4',
      icon: '📱',
    },
  ];

  // 短键 ↔ 仓库全名 的双向查找表，供其它模块复用，避免各自写 find()
  const MODEL_BY_KEY = Object.fromEntries(MODEL_OPTIONS.map((m) => [m.key, m]));
  const MODEL_BY_ID = Object.fromEntries(MODEL_OPTIONS.map((m) => [m.id, m]));

  // 把任意写法（短键或仓库全名）解析成模型条目；解析不到返回 null
  function resolveModel(ref) {
    if (!ref) return null;
    return MODEL_BY_KEY[ref] || MODEL_BY_ID[ref] || null;
  }

  // ========== 状态 ==========
  let generator = null;
  let currentModelId = null;
  let isGenerating = false;
  let abortController = null;
  let progressCallback = null;
  let generationCallback = null;

  // 模型加载 in-flight 去重：避免连点触发两次 GB 级下载/加载
  const loadingTasks = new Map();

  // transformers-cache 的 key 列表开销较大（含大量模型分片），做一次内存索引
  let cacheIndexPromise = null;
  function invalidateModelCacheIndex() { cacheIndexPromise = null; }
  async function getModelCacheKeys() {
    if (!cacheIndexPromise) {
      cacheIndexPromise = (async () => {
        try {
          const cache = await caches.open('transformers-cache');
          return await cache.keys();
        } catch {
          return [];
        }
      })();
    }
    return cacheIndexPromise;
  }
  function modelCacheKey(modelId) {
    const parts = String(modelId || '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  // ========== 加载 Transformers.js（多渠道容错）==========
// 国内网络下 cdn.jsdelivr.net 经常不可达，优先使用可达的 fastly CDN；
// 使用自包含的 web 打包版（onnxruntime 已内联，无裸导入）。
let transformersPromise = null;
async function importTransformers() {
  // 动态 import 结果缓存，避免重复触发 CDN 回退
  if (transformersPromise) return transformersPromise;
  const urls = [
    'https://fastly.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.web.js',
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.web.js',
  ];
  transformersPromise = (async () => {
    let lastErr = null;
    for (const url of urls) {
      try {
        return await import(url);
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error('Transformers.js 库加载失败，请检查网络后重试');
  })();
  // 失败时不缓存 Promise，允许后续重试
  transformersPromise.catch(() => { transformersPromise = null; });
  return transformersPromise;
}

// ========== 初始化/加载模型 ==========
async function loadModel(modelId, onProgress) {
    if (generator && currentModelId === modelId) {
      return; // 已加载
    }
    // 同一模型正在加载中：复用同一个 Promise，避免重复下载
    if (loadingTasks.has(modelId)) {
      return loadingTasks.get(modelId);
    }
    const task = doLoadModel(modelId, onProgress);
    loadingTasks.set(modelId, task);
    try {
      return await task;
    } finally {
      loadingTasks.delete(modelId);
    }
}

async function doLoadModel(modelId, onProgress) {
    if (generator && currentModelId === modelId) {
      return; // 已加载
    }

    // 卸载旧模型释放内存
    // generator 是 { tokenizer, model } 普通对象，没有 dispose 方法；
    // 原写法调用 generator.dispose() 会抛错并被吞掉，导致切换模型时旧模型从不释放。
    if (generator) {
      try { await generator.model.dispose(); } catch {}
      generator = null;
    }

    progressCallback = onProgress || (() => {});

    const { AutoTokenizer, AutoModelForCausalLM, env } = await importTransformers();

    // 国内网络适配：
    // 1. 模型文件改从 hf-mirror.com 镜像下载（huggingface.co 国内不可达）
    // 2. ONNX wasm 运行时二进制改从可达的 fastly CDN 加载
    env.remoteHost = 'https://hf-mirror.com';
    if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
      env.backends.onnx.wasm.wasmPaths =
        'https://fastly.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/';
    }

    progressCallback({ status: 'loading', message: '正在加载分词器...', progress: 0 });

    const tokenizer = await AutoTokenizer.from_pretrained(modelId, {
      progress_callback: (data) => {
        if (data.status === 'progress') {
          progressCallback({
            status: 'downloading',
            message: '下载分词器...',
            progress: data.progress / 100 * 0.3,
          });
        }
      },
    });

    progressCallback({ status: 'loading', message: '正在加载模型...', progress: 0.3 });

    // 按仓库实际提供的量化文件选择 dtype（如 Phi-3.5 仅提供 q4f16）
    const modelOption = MODEL_OPTIONS.find((m) => m.id === modelId);
    const dtype = (modelOption && modelOption.dtype) || 'q4';

    const model = await AutoModelForCausalLM.from_pretrained(modelId, {
      dtype,
      device: await getDevice(),
      progress_callback: (data) => {
        if (data.status === 'progress') {
          progressCallback({
            status: 'downloading',
            message: '下载模型...',
            progress: 0.3 + data.progress / 100 * 0.7,
          });
        }
      },
    });

    generator = { tokenizer, model };
    currentModelId = modelId;
    invalidateModelCacheIndex(); // 新分片已写入缓存，旧索引失效

    progressCallback({ status: 'ready', message: '模型加载完成', progress: 1 });

    // 保存用户选择
    localStorage.setItem('pf_offline_model', modelId);
  }

  // ========== 检测设备能力 ==========
  async function getDevice() {
    try {
      // 尝试 WebGPU
      if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) return 'webgpu';
      }
    } catch {}
    return 'wasm';
  }

  // ========== 生成文本 ==========
  async function generate(messages, options = {}) {
    if (!generator) {
      throw new Error('模型未加载，请先在设置中下载并加载离线模型');
    }

    if (isGenerating) {
      throw new Error('正在生成中，请等待当前任务完成');
    }

    isGenerating = true;
    abortController = new AbortController();

    const { onToken, maxNewTokens = 2048, temperature = 0.7 } = options;
    generationCallback = onToken || (() => {});

    try {
      const { tokenizer, model } = generator;

      // 构建 chat prompt
      const inputs = tokenizer.apply_chat_template(messages, {
        add_generation_prompt: true,
        return_dict: true,
      });

      // 序列长度（step[0] 是"prompt + 已生成内容"的完整序列）
      const seqLen = (t) => (t && t.dims ? t.dims[t.dims.length - 1] : 0);

      // 从 decodedLen 起只解码新增部分；失败返回 null 由调用方降级为整段解码
      const decodeTail = (tensor, from, to) => {
        try {
          const data = tensor.data;
          if (!data) return null;
          const tail = new Array(to - from);
          for (let i = from; i < to; i++) tail[i - from] = Number(data[i]);
          return tokenizer.decode(tail, { skip_special_tokens: true });
        } catch {
          return null;
        }
      };

      let decodedLen = seqLen(inputs.input_ids); // 起点为 prompt 长度，避免把提示词回显进结果
      let canIncrement = decodedLen > 0;
      let fullText = '';

      const output = await model.generate({
        ...inputs,
        max_new_tokens: maxNewTokens,
        temperature: temperature,
        do_sample: temperature > 0,
        callback_function: (step) => {
          if (abortController?.signal.aborted) {
            throw new Error('Generation aborted');
          }
          if (!step || !step[0]) return;

          const total = seqLen(step[0]);
          if (total <= decodedLen) return;

          let chunk = null;
          if (canIncrement) {
            chunk = decodeTail(step[0], decodedLen, total);
            if (chunk === null) canIncrement = false; // WebGPU 等拿不到 data 时降级
          }
          if (!canIncrement) {
            fullText = tokenizer.decode(step[0], { skip_special_tokens: true });
          } else if (chunk) {
            // 只拼接新 token：原来每步都重解整个序列，是 O(n²) 的重复计算
            fullText += chunk;
          }
          decodedLen = total;
          generationCallback(fullText);
        },
      });

      // 兜底：未触发过回调时整段解码（此时已无法区分 prompt，用特殊标记裁剪）
      if (!fullText && output && output[0]) {
        const rawText = tokenizer.decode(output[0], { skip_special_tokens: true })
          .replace(/<\|im_start\|>/g, '')
          .replace(/<\|im_end\|>/g, '');
        const marker = 'assistant';
        const idx = rawText.lastIndexOf(marker);
        fullText = idx >= 0 ? rawText.slice(idx + marker.length) : rawText;
      }

      return fullText
        .replace(/<\|im_end\|>/g, '')
        .replace(/<\|im_start\|>/g, '')
        .trim();
    } finally {
      isGenerating = false;
      abortController = null;
    }
  }

  // ========== 停止生成 ==========
  function stopGeneration() {
    if (abortController) {
      abortController.abort();
    }
  }

  // ========== 卸载模型释放内存 ==========
  async function unloadModel() {
    if (generator) {
      try { await generator.model.dispose(); } catch {}
      generator = null;
      currentModelId = null;
    }
  }

  // ========== 检查模型是否已缓存 ==========
  async function isModelCached(modelId) {
    const key = modelCacheKey(modelId);
    if (!key) return false;
    const keys = await getModelCacheKeys();
    return keys.some(req => req.url.includes(key));
  }

  // ========== 删除模型缓存 ==========
  async function deleteModelCache(modelId) {
    const key = modelCacheKey(modelId);
    if (!key) return;
    try {
      const cache = await caches.open('transformers-cache');
      const keys = await cache.keys();
      for (const req of keys) {
        if (req.url.includes(key)) {
          await cache.delete(req);
        }
      }
    } catch {}
    invalidateModelCacheIndex();
  }

  // ========== 公开 API ==========
  return {
    MODEL_OPTIONS,
    MODEL_BY_KEY,
    MODEL_BY_ID,
    resolveModel,
    loadModel,
    generate,
    stopGeneration,
    unloadModel,
    deleteModelCache,
    isModelCached,
    isLoaded: () => !!generator,
    isBusy: () => isGenerating,
    getCurrentModel: () => currentModelId,
    getDevice,
    invalidateModelCacheIndex,
  };
})();

// 顶层 const 不会自动挂到 window，显式导出以兼容 window.OfflineLLM 的旧写法
if (typeof window !== 'undefined') window.OfflineLLM = OfflineLLM;