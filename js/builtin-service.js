// ============================================================
// builtin-service.js —— 内置在线服务（装好即用的关键）
// ------------------------------------------------------------
// 问题：新装客户端打开就要用户去申请 API Key，否则「开始优化」直接报错。
// 方案：内置一份在线服务配置，从远端 service.json 下发，与 version.json 同源。
//       - 改服务地址 / 换模型 / 关停服务都不需要发新版客户端
//       - 用户一旦在设置里填了自己的 API，就优先用用户的
//       - 本地缓存 6 小时，离线或拉取失败时沿用上次的配置
// 安全：前端内置的 key 任何访客都能拿到，因此仅应放「自建代理」的令牌，
//       不要把高额度主账号 Key 写进 service.json。
// ============================================================

const BUILTIN_SERVICE_KEY = 'pf_builtin_service';
const BUILTIN_SERVICE_TTL = 6 * 60 * 60 * 1000; // 6 小时
const BUILTIN_FETCH_TIMEOUT = 8000;

// 内置服务的兜底配置：远端没配也能跑（留空表示未启用）
const BUILTIN_SERVICE_FALLBACK = {
  enabled: false,
  name: '',
  endpoint: '',
  model: '',
  key: '',
  note: '',
};

function loadBuiltinServiceCache() {
  try {
    const raw = localStorage.getItem(BUILTIN_SERVICE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

function saveBuiltinServiceCache(cfg) {
  try {
    localStorage.setItem(BUILTIN_SERVICE_KEY, JSON.stringify({ ...cfg, _cachedAt: Date.now() }));
  } catch {}
}

/// 返回当前可用的内置服务配置（可能未启用）
function getBuiltinService() {
  return loadBuiltinServiceCache() || BUILTIN_SERVICE_FALLBACK;
}

function builtinServiceUsable(cfg) {
  return !!(cfg && cfg.enabled && cfg.endpoint && cfg.model);
}

/// 归一化远端下发的配置，只保留可信字段，避免下发端塞进奇怪的东西
function normalizeBuiltinService(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return {
    enabled: raw.enabled !== false, // 默认启用，只有显式 false 才关
    name: str(raw.name, 40),
    endpoint: str(raw.endpoint),
    model: str(raw.model, 80),
    key: str(raw.key, 400),
    note: str(raw.note, 200),
  };
}

/// 从更新源拉取 service.json；失败静默降级到缓存
async function fetchBuiltinService(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return getBuiltinService();

  const cache = loadBuiltinServiceCache();
  const fresh = cache && Date.now() - (cache._cachedAt || 0) < BUILTIN_SERVICE_TTL;
  if (fresh) return cache;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUILTIN_FETCH_TIMEOUT);
  try {
    const res = await fetch(`${base}/service.json`, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return cache || BUILTIN_SERVICE_FALLBACK;
    const cfg = normalizeBuiltinService(await res.json());
    if (!cfg) return cache || BUILTIN_SERVICE_FALLBACK;
    saveBuiltinServiceCache(cfg);
    return cfg;
  } catch {
    return cache || BUILTIN_SERVICE_FALLBACK;
  } finally {
    clearTimeout(timer);
  }
}

/// 统一的「在线调用配置」解析：用户自己填的优先，否则用内置服务
/// 返回 { endpoint, key, model, source: 'user' | 'builtin' | 'none', sourceName }
function resolveOnlineConfig(settings) {
  const s = settings || (typeof loadSettings === 'function' ? loadSettings() : {}) || {};
  if (s.endpoint) {
    return {
      endpoint: s.endpoint,
      key: s.key || '',
      model: s.model || '',
      source: 'user',
      sourceName: '你的 API',
    };
  }
  const b = getBuiltinService();
  if (builtinServiceUsable(b)) {
    return {
      endpoint: b.endpoint,
      key: b.key || '',
      model: b.model,
      source: 'builtin',
      sourceName: b.name || '内置在线服务',
    };
  }
  return { endpoint: '', key: '', model: '', source: 'none', sourceName: '' };
}

if (typeof window !== 'undefined') {
  window.BuiltinService = {
    get: getBuiltinService,
    fetch: fetchBuiltinService,
    resolveOnlineConfig,
    usable: builtinServiceUsable,
    clear: () => { try { localStorage.removeItem(BUILTIN_SERVICE_KEY); } catch {} },
  };
}
