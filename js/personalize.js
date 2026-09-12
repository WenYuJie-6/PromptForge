// ============================================================
// 个性化系统：主题色 / 界面字体 / 背景氛围（自动保存 + 实时生效）
// ============================================================
(function () {
  const LS_KEY = 'pf_personalization';
  const DEFAULTS = { accent: '#4ade80', font: 'serif', bg: 'night', mode: 'dark' };

  const FONT_STACKS = {
    serif: "'Source Serif 4', Georgia, 'Songti SC', 'SimSun', serif",
    sans: "system-ui, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif",
    mono: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
  };

  // 背景预设：底色 + 两枚光斑色（光斑经高斯模糊后作为玻璃态衬底）
  const BG_PRESETS = {
    night:  { base: '#08090d', orb1: '#14532d', orb2: '#1e3a8a' },
    forest: { base: '#07110c', orb1: '#15803d', orb2: '#0e7490' },
    ocean:  { base: '#070d14', orb1: '#1e40af', orb2: '#0ea5a5' },
    purple: { base: '#0d0a14', orb1: '#6d28d9', orb2: '#be185d' },
    ember:  { base: '#140c07', orb1: '#c2410c', orb2: '#b45309' },
  };

  function load() {
    let cfg = {};
    try { cfg = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch {}
    return { ...DEFAULTS, ...cfg };
  }

  function save(cfg) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch {}
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return [74, 222, 128];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function apply(cfg) {
    if (!document.documentElement) return;
    const root = document.documentElement.style;
    const [r, g, b] = hexToRgb(cfg.accent);
    const bg = BG_PRESETS[cfg.bg] || BG_PRESETS.night;

    // 主题色及衍生色
    root.setProperty('--accent', (cfg.accent || DEFAULTS.accent));
    root.setProperty('--accent-hover', `rgb(${Math.round(r * 0.82)},${Math.round(g * 0.82)},${Math.round(b * 0.82)})`);
    root.setProperty('--accent-dim', `rgba(${r},${g},${b},.14)`);
    root.setProperty('--accent-glow', `rgba(${r},${g},${b},.10)`);

    // 界面字体
    root.setProperty('--font-body', FONT_STACKS[cfg.font] || FONT_STACKS.serif);

    // 背景氛围
    root.setProperty('--bg', bg.base);
    root.setProperty('--orb1', bg.orb1);
    root.setProperty('--orb2', bg.orb2);

    // 日间 / 夜间模式
    const mode = cfg.mode === 'light' ? 'light' : 'dark';
    document.body.dataset.mode = mode;
    const labelEl = document.getElementById('mode-label');
    if (labelEl) labelEl.textContent = mode === 'light' ? '日间' : '夜间';

    // 同步控件激活态
    document.querySelectorAll('[data-accent]').forEach((el) => {
      el.classList.toggle('active', (el.dataset.accent || '').toLowerCase() === String(cfg.accent).toLowerCase());
    });
    const custom = document.getElementById('custom-accent');
    if (custom && custom.value.toLowerCase() !== String(cfg.accent).toLowerCase()) {
      custom.value = cfg.accent;
    }
    document.querySelectorAll('[data-font]').forEach((el) => el.classList.toggle('active', el.dataset.font === cfg.font));
    document.querySelectorAll('[data-bg]').forEach((el) => el.classList.toggle('active', el.dataset.bg === cfg.bg));
    document.querySelectorAll('[data-mode]').forEach((el) => el.classList.toggle('active', el.dataset.mode === mode));

    save(cfg);
  }

  // 全局 API（供页面按钮 onclick 调用）
  window.setAccent = function (hex) {
    const c = load();
    c.accent = hex;
    apply(c);
  };
  window.setFont = function (font) {
    const c = load();
    c.font = font;
    apply(c);
  };
  window.setBackground = function (bg) {
    const c = load();
    c.bg = bg;
    apply(c);
  };
  window.setMode = function (mode) {
    const c = load();
    c.mode = mode === 'light' ? 'light' : 'dark';
    apply(c);
  };
  window.toggleMode = function () {
    const c = load();
    c.mode = c.mode === 'light' ? 'dark' : 'light';
    apply(c);
  };
  window.resetPersonalization = function () {
    try { localStorage.removeItem(LS_KEY); } catch {}
    apply({ ...DEFAULTS });
    if (typeof toast === 'function') toast('已恢复默认个性化设置');
  };

  // 启动即应用（脚本位于 app.js 之前，尽早渲染避免闪烁）
  const cfg = load();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => apply(cfg));
  } else {
    apply(cfg);
  }
})();