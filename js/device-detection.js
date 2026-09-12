// ========== 设备检测和优化 ==========

const DeviceDetector = (() => {
  // ========== 设备信息 ==========
  let deviceInfo = null;
  
  // ========== 检测设备能力 ==========
  async function detectDevice() {
    if (deviceInfo) return deviceInfo;
    
    const info = {
      // 基本信息检测
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      
      // 内存检测
      memory: navigator.deviceMemory || 4,
      
      // CPU 检测
      cpuCores: navigator.hardwareConcurrency || 4,
      
      // GPU 检测
      gpu: null,
      gpuSupport: false,
      
      // 屏幕检测
      screen: {
        width: screen.width,
        height: screen.height,
        pixelRatio: window.devicePixelRatio || 1,
      },
      
      // 存储检测
      storage: {
        estimated: 0,
        available: 0,
      },
      
      // 性能检测
      performance: {
        navigationTiming: null,
        memoryUsage: null,
      },
      
      // 推荐配置
      recommendation: {
        model: null,
        deviceType: null,
        warnings: [],
        suggestions: [],
      }
    };
    
    // 检测 GPU 支持
    try {
      if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
          info.gpu = 'WebGPU';
          info.gpuSupport = true;
          info.recommendation.warnings.push('✓ 检测到 WebGPU 支持，推荐使用大模型');
        } else {
          info.gpu = 'WebGPU (无适配器)';
          info.gpuSupport = false;
          info.recommendation.warnings.push('⚠ 未检测到 WebGPU 适配器，将使用 WASM 模式');
        }
      } else {
        info.gpu = 'WebGPU (不支持)';
        info.gpuSupport = false;
        info.recommendation.warnings.push('⚠ 当前设备不支持 WebGPU，将使用 WASM 模式');
      }
    } catch (error) {
      info.gpu = '检测失败';
      info.gpuSupport = false;
      info.recommendation.warnings.push('⚠ GPU 检测失败，将使用 WASM 模式');
    }
    
    // 检测设备类型
    if (/Mobi|Android/i.test(info.userAgent)) {
      info.recommendation.deviceType = 'mobile';
      info.recommendation.suggestions.push('检测到移动设备，建议使用 SmolLM2-1.7B 模型');
    } else if (/Tablet|iPad/i.test(info.userAgent)) {
      info.recommendation.deviceType = 'tablet';
      info.recommendation.suggestions.push('检测到平板设备，建议使用 Qwen2.5-1.5B 模型');
    } else {
      info.recommendation.deviceType = 'desktop';
      info.recommendation.suggestions.push('检测到桌面设备，推荐使用 Qwen2.5-1.5B 模型');
    }
    
    // 根据内存推荐模型
    if (info.memory < 4) {
      info.recommendation.model = 'SmolLM2-1.7B';
      info.recommendation.warnings.push('⚠ 内存不足（<4GB），建议使用 SmolLM2-1.7B 模型');
    } else if (info.memory < 8) {
      info.recommendation.model = 'Qwen2.5-1.5B';
      info.recommendation.suggestions.push('建议使用 Qwen2.5-1.5B 模型');
    } else {
      info.recommendation.model = 'Phi-3.5 Mini';
      info.recommendation.suggestions.push('推荐使用 Phi-3.5 Mini 模型获得最佳性能');
    }
    
    // 性能检测
    if (window.performance) {
      const timing = performance.getEntriesByType('navigation')[0];
      if (timing) {
        info.performance.navigationTiming = {
          domainLookupEnd: timing.domainLookupEnd,
          domainLookupStart: timing.domainLookupStart,
          responseEnd: timing.responseEnd,
          responseStart: timing.responseStart,
          loadEventEnd: timing.loadEventEnd,
          loadEventStart: timing.loadEventStart,
        };
      }
      
      // 内存使用情况
      if (performance.memory) {
        info.performance.memoryUsage = {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
        };
      }
    }
    
    // 存储空间检测
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        info.storage.estimated = estimate.quota || 0;
        info.storage.available = estimate.quota ? estimate.quota - (estimate.usage || 0) : 0;
        
        if (info.storage.available < 1000000000) { // 小于 1GB
          info.recommendation.warnings.push('⚠ 存储空间不足，建议清理缓存后重试');
        }
      } catch (error) {
        info.recommendation.warnings.push('⚠ 存储空间检测失败');
      }
    }
    
    deviceInfo = info;
    return info;
  }
  
  // ========== 获取设备推荐 ==========
  function getDeviceRecommendations() {
    if (!deviceInfo) {
      return {
        model: 'SmolLM2-1.7B',
        warnings: ['请先进行设备检测'],
        suggestions: ['建议先检测设备信息'],
      };
    }
    
    return deviceInfo.recommendation;
  }
  
  // ========== 检查设备兼容性 ==========
  function checkDeviceCompatibility(modelId) {
    if (!deviceInfo) {
      return {
        compatible: true,
        warnings: ['设备信息未检测'],
        suggestions: ['请先进行设备检测'],
      };
    }
    
    const warnings = [];
    const suggestions = [];
    let compatible = true;
    
    // 检查内存
    if (deviceInfo.memory < 4) {
      compatible = false;
      warnings.push('内存不足（<4GB），可能导致运行不稳定');
    }
    
    // 检查存储空间
    if (deviceInfo.storage.available < 1500000000) { // 小于 1.5GB
      compatible = false;
      warnings.push('存储空间不足，无法下载模型文件');
    }
    
    // 检查 GPU 支持
    if (modelId.includes('phi') && !deviceInfo.gpuSupport) {
      suggestions.push('Phi-3.5 Mini 需要 WebGPU 以获得最佳性能');
    }
    
    // 检查 CPU 核数
    if (deviceInfo.cpuCores < 4) {
      suggestions.push('CPU 核数较少，推理速度可能较慢');
    }
    
    return {
      compatible,
      warnings,
      suggestions,
    };
  }
  
  // ========== 公开 API ==========
  return {
    detectDevice,
    getDeviceRecommendations,
    checkDeviceCompatibility,
    getDeviceInfo: () => deviceInfo,
  };
})();

// 说明：getDeviceTypeName 由 offline-ui.js 统一提供（带图标版本）。
// 此处不再重复定义同名全局函数，否则后加载者会覆盖前者，造成难以定位的行为差异。

// 导出设备检测模块
window.DeviceDetector = DeviceDetector;