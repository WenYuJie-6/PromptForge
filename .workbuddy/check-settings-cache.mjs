// ============================================================
// check-settings-cache.mjs —— 设置缓存命中 / 失效 / 副本隔离
//
// 校验目标
//   storage.js 的 loadSettings() 带内存缓存（全项目最热路径，24 个调用点）。
//   缓存的「三条纪律」必须成立：
//     1. 写入即失效 —— saveSettingsToStorage() 必须清缓存，否则读回旧值；
//     2. 返回副本   —— 调用方 s.x = 1 不能污染缓存，也不能被缓存污染；
//     3. 提供显式失效入口 —— 绕过本函数的写入（云同步）需 invalidateSettingsCache() 兜底。
//   另覆盖 JSON 损坏容错、历史/墓碑的容量截断、同步元数据往返。
//
// 输入：js/storage.js（只读，在沙盒中执行）
// 输出：逐条 '✓' / 'FAIL'，末行 '>>> check-settings-cache: N PASS / M FAIL'
// 失败判定：任一断言失败 → 打印 FAIL 行并以退出码 1 结束
//
// 为什么值得单列：缓存化是很小的改动，但「返回引用而非副本」这类问题不会报错，
// 只会让某处设置被莫名改掉；而漏失效会表现为「保存了但没生效」。两者都极难排查。
// ============================================================
import { makeEnv, reporter } from './_check-lib.mjs';

const r = reporter('check-settings-cache');
const env = makeEnv();
env.run('js/storage.js');

const ev = (code) => env.eval(code);

// ---- A. 默认值与损坏容错 ----
r.section('A. 默认值与损坏容错');
r.check(typeof ev('loadSettings()') === 'object', '空存储下 loadSettings() 返回对象');
r.eq(ev('loadSettings().engine'), 'online', '无 engine 字段时默认 online');
env.localStorage.setItem('pf_settings', '{ 这不是 JSON');
r.check(typeof ev('loadSettings()') === 'object', '设置 JSON 损坏时不抛错，返回对象');
r.eq(ev('loadSettings().engine'), 'online', '设置损坏时 engine 仍回落 online');
env.localStorage.setItem('pf_history', '###');
r.eq(JSON.stringify(ev('loadHistory()')), '[]', '历史 JSON 损坏时返回空数组');
env.localStorage.setItem('pf_tombstones', '###');
r.eq(JSON.stringify(ev('loadTombstones()')), '[]', '墓碑 JSON 损坏时返回空数组');
env.localStorage.setItem('pf_sync_meta', '###');
r.eq(JSON.stringify(ev('loadSyncMeta()')), '{}', '同步元数据损坏时返回空对象');

// ---- B. 副本隔离 ----
r.section('B. 返回值是副本（不污染缓存）');
env.localStorage.removeItem('pf_settings');
ev('invalidateSettingsCache()');
ev('saveSettingsToStorage({ engine: "online", nickname: "原件" })');
ev('loadSettings()');                       // 建立缓存
r.check(ev('loadSettings() !== loadSettings()'), '两次调用返回不同对象（不是同一引用）');
r.eq(ev('JSON.stringify(loadSettings())'), ev('JSON.stringify(loadSettings())'), '两次调用内容一致');
ev('const __s = loadSettings(); __s.nickname = "被改坏了"; __s.engine = "offline";');
r.eq(ev('loadSettings().nickname'), '原件', '  改返回值不影响后续读取（副本隔离）');
r.eq(ev('loadSettings().engine'), 'online', '  改返回值不会污染缓存里的 engine');
r.eq(ev('JSON.parse(localStorage.getItem("pf_settings")).nickname'), '原件', '  改返回值没有写回 localStorage');

// ---- C. 写入即失效 ----
r.section('C. 写入即失效');
ev('invalidateSettingsCache()');
ev('saveSettingsToStorage({ engine: "offline" })');
r.eq(ev('JSON.parse(localStorage.getItem("pf_settings")).engine'), 'offline', 'saveSettingsToStorage 写入了 localStorage');
r.eq(ev('loadSettings().engine'), 'offline', 'save 后立刻读到新值');
// 强断言：save 必须清空缓存 ——
// 先读一次建立缓存，save 之后再直写 localStorage；若缓存被清，读到的应是直写值。
ev('loadSettings()');                                   // 缓存 = {engine:'offline'}
ev('localStorage.setItem("pf_settings", JSON.stringify({ engine: "direct-after-save" }))');
ev('saveSettingsToStorage({ engine: "offline2" })');    // 应清空缓存
ev('localStorage.setItem("pf_settings", JSON.stringify({ engine: "direct-after-save2" }))');
r.eq(ev('loadSettings().engine'), 'direct-after-save2', 'saveSettingsToStorage 清空了缓存（直写值立刻可见）');

// ---- D. 外部写入需显式失效 ----
r.section('D. 外部写入（云同步）需显式失效');
ev('invalidateSettingsCache()');
ev('saveSettingsToStorage({ engine: "online" })');
ev('loadSettings()');                                   // 建立缓存 = {engine:'online'}
ev('localStorage.setItem("pf_settings", JSON.stringify({ engine: "online", sync: 1 }))');
r.eq(ev('loadSettings().sync'), undefined, '绕过函数直写时读到缓存旧值（证明缓存生效）');
ev('localStorage.setItem("pf_settings", JSON.stringify({ engine: "online", sync: 2 }))');
r.eq(ev('loadSettings().sync'), undefined, '再次直写同样不影响（仍读缓存）');
ev('invalidateSettingsCache()');
r.eq(ev('loadSettings().sync'), 2, '显式 invalidate 后读到最新值');

// ---- E. 历史与墓碑容量 ----
r.section('E. 历史 / 墓碑容量控制');
ev('localStorage.removeItem("pf_history")');
for (let i = 0; i < 60; i++) ev(`addHistory({ id: ${i} })`);
r.eq(ev('loadHistory().length'), 50, '历史记录上限 50 条');
r.eq(ev('loadHistory()[0].id'), 59, '最新一条在最前（unshift）');
ev('saveSettingsToStorage({})');
r.check(ev('typeof loadTombstones()') === 'object', 'saveTombstones/loadTombstones 可用');
const big = Array.from({ length: 600 }, (_, i) => 't' + i);
env.eval(`saveTombstones(${JSON.stringify(big)})`);
r.eq(ev('loadTombstones().length'), 300, '墓碑超限时截断为最近 300 条');
r.eq(ev('loadTombstones()[299]'), 't599', '墓碑保留的是最近写入的条目（slice(-300)）');

// ---- F. 同步元数据往返 ----
r.section('F. 同步元数据往返');
ev('saveSyncMeta({ settings: 12345, tombstones: 678 })');
r.eq(ev('loadSyncMeta().settings'), 12345, 'saveSyncMeta/loadSyncMeta 往返一致');
r.eq(ev('loadSyncMeta().tombstones'), 678, '同步元数据第二个字段一致');

r.done();
