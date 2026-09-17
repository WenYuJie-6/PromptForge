// PromptForge Service Worker
// 提供离线缓存和 PWA 功能

// 缓存名与前端资源版本（version.json 的 webVersion）绑定，由
// scripts/bump-version.mjs / scripts/bump-web-version.mjs 自动改写（见 scripts/sw-cache.mjs）。
// 为什么必须跟随：静态资源（本文件 STATIC_PATHS 及**所有** .js/.css）走「缓存优先」，
// 浏览器仅在 sw.js 字节变化时才重装 SW —— 改了前端却不改这里，网页端 PWA 用户会永远
// 吃到旧缓存、拿不到新前端。请勿手工填任意值，也不要在别处写死这两个名字。
const CACHE_NAME = 'promptforge-v0.2.2';
const API_CACHE_NAME = 'promptforge-api-v0.2.2';

// 缓存的静态资源
// 必须用相对路径：若写成绝对路径，部署在子目录（如 /promptforge/）时
// addAll 会全部 404，导致 Service Worker 安装失败、离线能力整体失效。
const STATIC_CACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './css/style.css',
  './js/frameworks.js',
  './js/storage.js',
  './js/builtin-service.js',
  './js/unified-llm.js',
  './js/offline-llm.js',
  './js/device-detection.js',
  './js/offline-ui.js',
  './js/local-model.js',
  './js/pwa.js',
  './js/personalize.js',
  './js/style-variants.js',
  './js/optimizer.js',
  './js/optimize-ui.js',
  './js/api.js',
  './js/sync.js',
  './js/export.js',
  './js/app.js'
];

// 解析成 pathname 便于 fetch 拦截时比对（子目录部署下 pathname 与相对路径不一致）
const STATIC_PATHS = new Set(
  STATIC_CACHE_URLS.map((u) => new URL(u, self.location.href).pathname)
);

// API 端点配置（用于缓存 API 响应）
const API_ENDPOINTS = [
  // 这里可以添加需要缓存的 API 端点
  // 注意：对于敏感数据，不建议缓存 API 响应
];

// 安装 Service Worker
self.addEventListener('install', (event) => {
  console.log('Service Worker installing...');
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Cache opened:', CACHE_NAME);
        // 逐条缓存：addAll 只要有一个资源 404 就整体失败，容错太差
        return Promise.allSettled(STATIC_CACHE_URLS.map((u) => cache.add(u)));
      })
      .then(() => self.skipWaiting())
  );
});

// 激活 Service Worker
self.addEventListener('activate', (event) => {
  console.log('Service Worker activating...');

  // 绝不可删除的缓存（离线模型等大文件缓存）
  const PROTECTED_CACHES = ['transformers-cache', 'PromptForgeModels', CACHE_NAME, API_CACHE_NAME];

  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (!PROTECTED_CACHES.includes(cacheName)) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 拦截网络请求
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // 对于 API 请求，使用网络优先策略
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // 如果请求成功，缓存响应（仅适用于 GET 请求）
          if (event.request.method === 'GET' && response.status === 200) {
            const responseClone = response.clone();
            caches.open(API_CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        })
        .catch(() => {
          // 网络失败时，尝试从缓存获取
          return caches.match(event.request);
        })
    );
    return;
  }
  
  // 对于静态资源，使用缓存优先策略
  if (STATIC_PATHS.has(url.pathname) || url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    event.respondWith(
      caches.match(event.request)
        .then((response) => {
          return response || fetch(event.request);
        })
    );
    return;
  }
  
  // 对于其他请求，使用网络优先策略
  event.respondWith(
    fetch(event.request)
      .catch(() => {
        // 网络失败时，尝试从缓存获取
        return caches.match(event.request);
      })
  );
});

// 消息处理
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CACHE_CLEAR') {
    caches.delete(CACHE_NAME).then(() => {
      event.ports[0].postMessage({ success: true });
    });
  }
});

// 后台同步
self.addEventListener('sync', (event) => {
  if (event.tag === 'promptforge-sync') {
    event.waitUntil(
      // 这里可以实现后台同步逻辑
      console.log('Background sync:', event.tag)
    );
  }
});

// 推送通知
self.addEventListener('push', (event) => {
  if (event.data) {
    const options = {
      body: event.data.text(),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [100, 50, 100],
      data: {
        dateOfArrival: Date.now(),
        primaryKey: 1
      }
    };
    
    event.waitUntil(
      self.registration.showNotification('PromptForge', options)
    );
  }
});

// 通知点击处理
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  
  if (event.action === 'view-history') {
    event.waitUntil(
      clients.openWindow('/?action=history')
    );
  } else {
    event.waitUntil(
      clients.openWindow('/')
    );
  }
});