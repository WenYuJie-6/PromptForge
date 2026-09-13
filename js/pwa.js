// PromptForge PWA 安装功能
// 提供应用安装和管理功能

const PWAInstaller = (() => {
  let deferredPrompt = null;
  let installButton = null;
  let isInstalled = false;
  let initialized = false;

  // 初始化 PWA 功能
  function init() {
    // 幂等：app.js 与 pwa.js 都可能在 DOMContentLoaded 调用，避免监听器重复注册
    if (initialized) return;
    initialized = true;

    // 只判断 Service Worker。原先还检查 'BeforeInstallPromptEvent' in window，
    // 但它并非标准且 Chrome 多数版本不暴露，会让安装功能静默失效。
    if (!('serviceWorker' in navigator)) {
      console.log('当前浏览器不支持 PWA 安装功能');
      return;
    }

    // 监听安装提示事件
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      
      
      console.log('PWA 安装提示已准备');
    });

    // 监听应用安装完成事件
    window.addEventListener('appinstalled', () => {
      isInstalled = true;
      hideInstallButton();
      showInstallSuccess();
      console.log('PromptForge 已安装到桌面');
    });

    // 检查是否已安装
    checkIfInstalled();

    // 检查 Service Worker 状态
    checkServiceWorkerStatus();
  }

  function showInstallButton() {
    // 在主界面添加安装按钮
    const installBtn = document.createElement('button');
    installBtn.id = 'pwa-install-btn';
    installBtn.className = 'btn btn-primary';
    installBtn.innerHTML = `
      <span class="install-icon">📱</span>
      <span class="install-text">安装到桌面</span>
    `;
    installBtn.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 1000;
      display: flex;
      align-items: center;
      gap: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      transition: all 0.3s ease;
    `;
    
    installBtn.addEventListener('click', handleInstall);
    
    // 添加悬停效果
    installBtn.addEventListener('mouseenter', () => {
      installBtn.style.transform = 'translateY(-2px)';
      installBtn.style.boxShadow = '0 6px 16px rgba(0,0,0,0.2)';
    });
    
    installBtn.addEventListener('mouseleave', () => {
      installBtn.style.transform = 'translateY(0)';
      installBtn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
    });
    
    document.body.appendChild(installBtn);
    installButton = installBtn;
    
    // 5秒后自动隐藏
    setTimeout(() => {
      if (!isInstalled) {
        hideInstallButton();
      }
    }, 5000);
  }

  // 隐藏安装按钮
  function hideInstallButton() {
    if (installButton) {
      installButton.style.opacity = '0';
      installButton.style.transform = 'translateY(20px)';
      setTimeout(() => {
        if (installButton && installButton.parentNode) {
          installButton.parentNode.removeChild(installButton);
        }
        installButton = null;
      }, 300);
    }
  }

  // 处理安装点击
  async function handleInstall() {
    if (!deferredPrompt) {
      showInstallInfo();
      return;
    }

    try {
      // 显示安装提示
      const { outcome } = await deferredPrompt.prompt();
      
      if (outcome === 'accepted') {
        console.log('用户接受了安装');
        hideInstallButton();
      } else {
        console.log('用户拒绝了安装');
        showInstallInfo();
      }
      
      deferredPrompt = null;
    } catch (error) {
      console.error('安装失败:', error);
      showInstallInfo();
    }
  }

  // 显示安装成功提示
  function showInstallSuccess() {
    const toast = document.createElement('div');
    toast.className = 'install-toast';
    toast.innerHTML = `
      <div class="toast-content">
        <span class="toast-icon">✅</span>
        <span class="toast-text">PromptForge 已安装到桌面！</span>
      </div>
    `;
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 1000;
      background: var(--accent);
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: var(--font-display);
      font-weight: 500;
      animation: slideIn 0.3s ease;
    `;
    
    // 添加动画样式（只注入一次，避免反复累积）
    injectStyleOnce('pf-pwa-toast-style', `
      @keyframes slideIn {
        from {
          transform: translateX(100%);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
      @keyframes slideOut {
        from {
          transform: translateX(0);
          opacity: 1;
        }
        to {
          transform: translateX(100%);
          opacity: 0;
        }
      }
    `);
    
    document.body.appendChild(toast);
    
    // 3秒后自动消失
    setTimeout(() => {
      toast.style.animation = 'slideOut 0.3s ease';
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300);
    }, 3000);
  }

  // 显示安装信息
  function showInstallInfo() {
    const info = document.createElement('div');
    info.className = 'install-info';
    info.innerHTML = `
      <div class="info-content">
        <span class="info-icon">ℹ️</span>
        <span class="info-text">点击浏览器菜单选择"添加到主屏幕"来安装 PromptForge</span>
        <button class="info-close" onclick="this.parentElement.parentElement.remove()">×</button>
      </div>
    `;
    info.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 1000;
      background: var(--s2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
      max-width: 400px;
      animation: slideIn 0.3s ease;
    `;
    
    injectStyleOnce('pf-pwa-info-style', `
      .info-content {
        display: flex;
        align-items: flex-start;
        gap: 12px;
      }
      .info-icon {
        font-size: 18px;
        flex-shrink: 0;
      }
      .info-text {
        font-size: 14px;
        color: var(--text);
        line-height: 1.4;
        flex: 1;
      }
      .info-close {
        background: none;
        border: none;
        font-size: 18px;
        color: var(--text3);
        cursor: pointer;
        padding: 4px;
        border-radius: 4px;
        transition: all 0.2s ease;
      }
      .info-close:hover {
        background: var(--s3);
        color: var(--text);
      }
    `);
    
    document.body.appendChild(info);
    
    // 10秒后自动消失
    setTimeout(() => {
      if (info.parentNode) {
        info.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => {
          if (info.parentNode) {
            info.parentNode.removeChild(info);
          }
        }, 300);
      }
    }, 10000);
  }

// 把一段 CSS 注入 <head>，同一个 id 只注入一次。
// 这两个 toast / info 面板都可能被反复调用，早先每次调用都 createElement('style')
// 无脑 append，导致 <head> 里同名 style（含 @keyframes）不断累积。
function injectStyleOnce(id, css) {
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}

// 检查是否已安装
function checkIfInstalled() {
    // 检查是否通过 PWA 方式安装
    if (window.matchMedia('(display-mode: standalone)').matches || 
        window.matchMedia('(display-mode: fullscreen)').matches) {
      isInstalled = true;
      hideInstallButton();
      return;
    }

    // 检查 localStorage 中的安装状态
    const installed = localStorage.getItem('pwa-installed') === 'true';
    if (installed) {
      isInstalled = true;
      hideInstallButton();
    }
  }

  // 检查 Service Worker 状态
  function checkServiceWorkerStatus() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.ready.then((registration) => {
      console.log('Service Worker 已激活');
      
      // 检查是否有更新
      registration.update().catch(() => {
        console.log('无法检查更新');
      });
    }).catch(() => {
      console.log('Service Worker 激活失败');
    });
  }

  // 手动触发安装检查
  function checkInstallAvailability() {
    if (deferredPrompt && !isInstalled) {
      showInstallButton();
    }
  }

  // 直接发起安装。
  // 之前侧边栏「安装应用」只调 showInstallButton()——它只是弹出一个 5 秒后
  // 自动消失的浮动按钮，从不调用 prompt()，用户点了就"没反应"。
  async function install() {
    if (isInstalled) return { ok: false, reason: 'installed' };

    if (!deferredPrompt) {
      return { ok: false, reason: 'unavailable' };
    }
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      deferredPrompt = null;
      if (choice && choice.outcome === 'accepted') {
        markAsInstalled();
        hideInstallButton();
        return { ok: true, outcome: 'accepted' };
      }
      return { ok: false, reason: 'dismissed' };
    } catch (error) {
      console.error('PWA 安装失败:', error);
      return { ok: false, reason: 'error', error };
    }
  }

  // 当前环境能不能直接唤起安装流程
  function getInstallHint() {
    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isWeixin = /MicroMessenger/i.test(ua);
    const isQQ = /\bQQ\//i.test(ua);
    const isEdge = /Edg\//.test(ua);
    const isChrome = /Chrome\//.test(ua) && !isEdge;
    const isSafari = /Safari\//.test(ua) && !isChrome && !isEdge;

    if (isWeixin || isQQ) {
      return { title: '请在系统浏览器中打开', steps: ['点击右上角「···」菜单', '选择「在浏览器打开」', '再点本页的「安装应用」即可'] };
    }
    if (isIOS && isSafari) {
      return { title: '在 Safari 中安装', steps: ['点击底部中间的「分享」按钮', '向下找到「添加到主屏幕」', '点右上角「添加」'] };
    }
    if (isIOS) {
      return { title: 'iPhone / iPad 请用 Safari 安装', steps: ['在 Safari 中打开本页', '点底部分享 → 「添加到主屏幕」'] };
    }
    if (isEdge) {
      return { title: '在 Edge 中安装', steps: ['点击地址栏右侧的「⋯」菜单', '依次选择「应用」→「将此站点安装为应用」'] };
    }
    if (isChrome) {
      return { title: '在 Chrome 中安装', steps: ['点击地址栏右侧的安装图标（或「⋮」菜单）', '选择「安装 PromptForge…」', '若看不到入口，说明当前环境不支持，可先把站点加为书签'] };
    }
    if (isSafari) {
      return { title: '在 Safari 中安装', steps: ['点击菜单栏「文件」→「添加到程序坞」'] };
    }
    return { title: '添加到主屏幕', steps: ['打开浏览器的菜单', '寻找「安装应用 / 添加到主屏幕 / 保存到桌面」'] };
  }

  // 网页端「移除已安装的应用」——清掉本地标记与缓存，让下次可重新安装
  async function uninstallWebApp() {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (window.caches && caches.keys) {
        const keys = await caches.keys();
        // 离线模型体积大且难重新下载，保留不动，只清应用缓存
        await Promise.all(keys.filter((k) => !/transformers|PromptForgeModels/i.test(k)).map((k) => caches.delete(k)));
      }
    } catch (e) {
      console.warn('清理 PWA 缓存失败:', e);
    }
    isInstalled = false;
    deferredPrompt = null;
    try { localStorage.removeItem('pwa-installed'); } catch {}
    return true;
  }

  // 标记为已安装
  function markAsInstalled() {
    isInstalled = true;
    localStorage.setItem('pwa-installed', 'true');
    hideInstallButton();
  }

  // 公开 API
  return {
    init,
    install,
    checkInstallAvailability,
    markAsInstalled,
    uninstallWebApp,
    getInstallHint,
    isInstalled: () => isInstalled,
    canInstall: () => !!deferredPrompt,
  };
})();

// 全局暴露，供其他模块调用（初始化统一由 app.js 的 DOMContentLoaded 触发，
// 此处不再自行注册，否则监听器会被注册两次）

window.PWAInstaller = PWAInstaller;