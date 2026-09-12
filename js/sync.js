// ============================================================
// sync.js —— Supabase 云同步（多端双向合并、删除墓碑、设置同步）
// ============================================================

// Cloud Sync (Supabase)
// ============================================================
function getSyncConfig() {
  const s = loadSettings();
  const url = (s.supabase?.url || '').trim().replace(/\/+$/, '');
  const key = (s.supabase?.key || '').trim();
  const ns = (s.supabase?.ns || '').trim() || 'default';
  return { url, key, ns, configured: !!(url && key) };
}

function setSyncStatus(text, isError) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? 'var(--danger)' : (text.includes('✓') ? 'var(--accent)' : 'var(--text3)');
}

const SYNC_TIMEOUT_MS = 20000;

function supabaseFetch(cfg, path, options = {}) {
  return fetch(cfg.url + '/rest/v1/' + path, {
    ...options,
    // 统一超时，避免网络异常时请求长期悬挂（后台自动同步尤其明显）
    signal: options.signal || AbortSignal.timeout(SYNC_TIMEOUT_MS),
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

function openSyncGuide() {
  document.getElementById('syncguide').classList.remove('hidden');
}
function closeSyncGuide() {
  document.getElementById('syncguide').classList.add('hidden');
}
function copySyncSQL() {
  const sql = document.getElementById('sync-sql').textContent;
  const ta = document.createElement('textarea');
  ta.value = sql;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  toast('SQL 已复制，去 Supabase SQL Editor 执行');
}

// 同步并发锁：启动同步 / 保存 / 删除都可能触发 syncNow，
// 并发执行会基于各自读到的快照互相覆盖。
let syncInFlight = null;

// 双向同步：拉取远端 → 按时间合并 → 推送本地较新的数据
async function syncNow(manual = true) {
  const cfg = getSyncConfig();
  if (!cfg.configured) {
    if (manual) toast('请先填写 Supabase URL 和 anon key');
    return false;
  }

  // 已有同步在跑：复用其结果，不另起一轮
  if (syncInFlight) return syncInFlight;

  syncInFlight = doSyncNow(manual, cfg);
  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

async function doSyncNow(manual, cfg) {
  if (manual) setSyncStatus('同步中…', false);
  try {
    // 1. 拉取远端该空间下的全部记录
    const res = await supabaseFetch(cfg, `pf_records?ns=eq.${encodeURIComponent(cfg.ns)}&select=id,updated_at,payload`);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (res.status === 404 || detail.includes('relation') || detail.includes('42P01')) {
        throw new Error('Supabase 里还没有 pf_records 表，请先按「首次配置指南」执行建表 SQL');
      }
      throw new Error(`拉取失败 (${res.status})，请检查 URL / anon key`);
    }
    const remoteRows = await res.json();
    const remote = {};
    remoteRows.forEach(r => { remote[r.id] = { updatedAt: new Date(r.updated_at).getTime(), payload: r.payload }; });

    // 2. 合并墓碑（删除记录）
    const remoteTomb = remote['t:tombstones']?.payload?.ids || [];
    let tombstones = [...new Set([...loadTombstones(), ...remoteTomb])];
    const bigTomb = Date.now();

    // 3. 合并历史记录：逐条取较新版本
    const localHistory = loadHistory();
    const merged = {};
    localHistory.forEach(h => {
      const lt = h.updatedAt || h.id; // 老数据没有 updatedAt，用 id（时间戳）兜底
      merged['h:' + h.id] = { updatedAt: lt, payload: h };
    });
    Object.keys(remote).forEach(id => {
      if (!id.startsWith('h:')) return;
      const r = remote[id];
      if (!merged[id] || r.updatedAt > merged[id].updatedAt) {
        merged[id] = { updatedAt: r.updatedAt, payload: r.payload };
      }
    });
    let history = Object.values(merged)
      .map(m => m.payload)
      .filter(h => !tombstones.includes(h.id))
      .sort((a, b) => (b.updatedAt || b.id) - (a.updatedAt || a.id))
      .slice(0, 50);
    localStorage.setItem('pf_history', JSON.stringify(history));

    // 4. 合并设置（远端较新则采用，保留本地云同步配置）
    const meta = loadSyncMeta();
    if (remote['s:settings']) {
      const rSet = remote['s:settings'];
      if (rSet.updatedAt > (meta.settings || 0)) {
        const localSb = loadSettings().supabase;
        const mergedSettings = Object.assign({}, rSet.payload);
        if (localSb) mergedSettings.supabase = localSb;
        saveSettingsToStorage(mergedSettings);
        loadSettingsUI();
        meta.settings = rSet.updatedAt;
      }
    }

    // 5. 构建待推送列表
    const pushes = [];
    history.forEach(h => {
      const id = 'h:' + h.id;
      const lt = h.updatedAt || h.id;
      if (!remote[id] || lt > remote[id].updatedAt) {
        pushes.push({ id, ns: cfg.ns, updated_at: new Date(lt).toISOString(), payload: h });
      }
    });
    const localSettings = loadSettings();
    const settingsTs = meta.settings || 0;
    if (settingsTs > (remote['s:settings']?.updatedAt || 0)) {
      const { supabase, ...shareable } = localSettings; // 云同步配置只留在本机
      pushes.push({ id: 's:settings', ns: cfg.ns, updated_at: new Date(settingsTs).toISOString(), payload: shareable });
    }
    if (tombstones.length > remoteTomb.length) {
      pushes.push({ id: 't:tombstones', ns: cfg.ns, updated_at: new Date(bigTomb).toISOString(), payload: { ids: tombstones } });
    }

    // 6. 推送（upsert）
    if (pushes.length > 0) {
      const upRes = await supabaseFetch(cfg, 'pf_records', {
        method: 'POST',
        body: JSON.stringify(pushes),
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      });
      if (!upRes.ok) {
        const detail = await upRes.text().catch(() => '');
        if (upRes.status === 404 || detail.includes('relation') || detail.includes('42P01')) {
          throw new Error('Supabase 里还没有 pf_records 表，请先按「首次配置指南」执行建表 SQL');
        }
        throw new Error(`推送失败 (${upRes.status}): ${detail.slice(0, 120)}`);
      }
    }

    saveTombstones(tombstones);
    saveSyncMeta({ settings: meta.settings || 0, tombstones: bigTomb });
    renderHistory();
    if (manual) {
      setSyncStatus(`✓ 同步完成（拉取 ${remoteRows.length} 条，推送 ${pushes.length} 条）`, false);
      toast('云同步完成');
    } else {
      setSyncStatus('✓ 已自动同步', false);
    }
    return true;
  } catch (err) {
    setSyncStatus('', true);
    if (manual) toast('同步失败: ' + err.message);
    else if (getSyncConfig().configured) setSyncStatus('自动同步失败，可手动重试', true);
    return false;
  }
}
