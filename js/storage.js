// ============================================================
// storage.js —— LocalStorage 读写（设置 / 历史 / 删除墓碑 / 同步元数据）
// ============================================================

// Storage Helpers
// ============================================================

// loadSettings 的内存缓存。
// 它是全项目最热的读取路径（callLLM / onEngineChange / updateEngineUI / getSyncConfig
// 等每次调用都会 JSON.parse 一遍 localStorage，共 24 个调用点）。
// 缓存三条纪律：
//   1. 写入必须失效（saveSettingsToStorage 里清掉）
//   2. 返回副本，避免调用方就地改字段把缓存改脏（历史上出现过 settings 被顺手赋值的写法）
//   3. 外部（如云同步）也可能绕过本函数写 localStorage，故提供 invalidateSettingsCache()
let _settingsCache = null;

function invalidateSettingsCache() {
  _settingsCache = null;
}

function loadSettings() {
  if (_settingsCache) return Object.assign({}, _settingsCache);
  let settings;
  try {
    settings = JSON.parse(localStorage.getItem('pf_settings')) || {};
  } catch {
    settings = {};
  }
  // 确保引擎设置存在（兼容旧版本）
  if (!settings.engine) {
    settings.engine = 'online'; // 默认使用在线 API
  }
  _settingsCache = settings;
  return Object.assign({}, settings);
}
function saveSettingsToStorage(s) {
  localStorage.setItem('pf_settings', JSON.stringify(s));
  // 写完立即失效：否则后续 loadSettings 会读到旧缓存
  invalidateSettingsCache();
}
function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem('pf_history')) || [];
  } catch { return []; }
}
// 新增一条历史。内容重复时**不再新增副本**：
// 重复点「保存」会在列表里堆出一模一样的记录，既占位又让人以为保存失败。
// 命中重复时把旧记录提到最前并刷新时间 —— 语义上等价于「再次保存」。
// @returns {{deduped: boolean}} 便于调用方给出不同提示
function addHistory(item) {
  const h = loadHistory();
  const key = item && item.output != null ? String(item.output) : '';
  if (key) {
    const i = h.findIndex((x) => x && String(x.output ?? '') === key);
    if (i >= 0) {
      const [old] = h.splice(i, 1);
      h.unshift(Object.assign({}, old, item, { updatedAt: Date.now() }));
      localStorage.setItem('pf_history', JSON.stringify(h));
      return { deduped: true };
    }
  }
  h.unshift(item);
  if (h.length > 50) h.length = 50;
  localStorage.setItem('pf_history', JSON.stringify(h));
  return { deduped: false };
}
function loadTombstones() {
  try {
    return JSON.parse(localStorage.getItem('pf_tombstones')) || [];
  } catch { return []; }
}
function saveTombstones(ids) {
  if (ids.length > 500) ids = ids.slice(-300); // 防止无限增长
  localStorage.setItem('pf_tombstones', JSON.stringify(ids));
}
// 用于比较远端/本地最新修改时间：{ settings: 毫秒时间戳, tombstones: 时间戳 }
function loadSyncMeta() {
  try {
    return JSON.parse(localStorage.getItem('pf_sync_meta')) || {};
  } catch { return {}; }
}
function saveSyncMeta(meta) {
  localStorage.setItem('pf_sync_meta', JSON.stringify(meta));
}

// ============================================================