// ========== 统一调用层：自动选择在线/离线引擎 ==========

async function callLLM(messages, options = {}) {
  const settings = loadSettings();

  if (settings.engine === 'offline') {
    return callOfflineLLM(messages, options);
  } else {
    return callOnlineLLM(messages, options);
  }
}

// 在线调用（OpenAI 兼容 API）
async function callOnlineLLM(messages, options = {}) {
  const s = loadSettings();
  // 用户自己填的 API 优先；没填就退回内置在线服务，做到「装好即用」
  const cfg = typeof resolveOnlineConfig === 'function'
    ? resolveOnlineConfig(s)
    : { endpoint: s.endpoint || '', key: s.key || '', model: s.model || '', source: 'user' };

  const endpoint = cfg.endpoint || '';
  const key = cfg.key || '';
  const model = cfg.model || '';

  if (!endpoint) throw new Error('尚未配置在线 API，请在设置中填写，或切换到离线模式');

  const url = endpoint.replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;

  const body = { model, messages, temperature: 0.7, stream: !!options.stream };

  // 透传中止信号（「停止生成」按钮依赖此能力）；无 signal 时用 5 分钟兜底超时
  const signal = options.signal || AbortSignal.timeout(300000);

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('已停止生成');
    throw err;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`API 请求失败 (${res.status}): ${errText.slice(0, 200)}`);
  }

  if (options.stream) {
    return readStream(res, {
      onUpdate: options.onUpdate || options.onToken,
      signal,
    });
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// 离线调用
async function callOfflineLLM(messages, options = {}) {
  if (typeof OfflineLLM === 'undefined' || !OfflineLLM.isLoaded()) {
    throw new Error('离线模型未加载，请在设置中下载并加载模型');
  }

  // 流式回调优先使用调用方传入的 onUpdate/onToken，回退到全局输出更新
  const onToken = options.onUpdate || options.onToken || ((text) => {
    if (typeof onUpdateStreaming === 'function') {
      onUpdateStreaming(text);
    }
  });

  const result = await OfflineLLM.generate(messages, {
    onToken,
    maxNewTokens: options.maxTokens || 2048,
    temperature: 0.7,
  });

  return result;
}

// 流式读取（OpenAI 兼容 SSE / Ollama 原生行 JSON）
async function readStream(res, { onUpdate = null, signal = null } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';

  while (true) {
    let part;
    try {
      part = await reader.read();
    } catch (err) {
      break; // abort 时 read() 抛出 AbortError
    }
    if (part.done) break;

    buffer += decoder.decode(part.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // 最后一段可能是不完整的行，留到下一轮

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 已中止时尽早释放底层流
      if (signal && signal.aborted) {
        try { reader.cancel(); } catch {}
        return full;
      }

      // OpenAI 兼容格式：data: {...}；Ollama 原生格式：每行一个裸 JSON 对象
      const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content || json.message?.content || '';
        if (delta) {
          full += delta;
          if (typeof onUpdate === 'function') onUpdate(full);
        }
      } catch {}
    }
  }
  return full;
}