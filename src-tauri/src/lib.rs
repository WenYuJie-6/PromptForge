use std::collections::HashMap;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, RwLock};
use std::thread;
use std::time::Duration;

use base64::Engine;
use tauri::Manager;
use tauri::utils::assets::AssetKey;

/// 无退出热更新状态：指向当前生效的前端资源目录（None = 使用内嵌资源）
struct AppState {
  web_root: Arc<RwLock<Option<PathBuf>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let context = tauri::generate_context!();

  // 将所有嵌入资源拷入内存映射，供内置静态服务器使用。
  // 注意：iter() 给出的字节是 brotli 压缩态，必须经 get() 解压；
  // 资源键均以 "/" 开头（如 /index.html），保留原始键便于精确匹配。
  let provider = context.assets();
  let keys: Vec<String> = provider
    .iter()
    .map(|(k, _)| k.into_owned())
    .collect();
  let mut assets: HashMap<String, Vec<u8>> = HashMap::new();
  for k in keys {
    if let Some(bytes) = provider.get(&AssetKey::from(k.as_str())) {
      assets.insert(k, bytes.into_owned());
    }
  }
  let assets = Arc::new(assets);

  // 启动时恢复此前通过热更新安装的前端版本（取版本号最高的目录）
  let web_root: Arc<RwLock<Option<PathBuf>>> =
    Arc::new(RwLock::new(restore_web_root()));

  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      get_version,
      check_update,
      download_update,
      install_update,
      open_update_folder,
      update_state,
      builtin_service_config,
      open_app_dir,
      app_exe_path,
      create_desktop_shortcut,
      uninstall_app
    ])
    .setup(move |app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      app.manage(AppState {
        web_root: web_root.clone(),
      });

      // Windows 下部分机器上 WebView2 对 http://tauri.localhost 的自定义协议拦截
      // 可能失效（表现为 DNS 解析错误页白屏乱码），这里改为内嵌静态服务器：
      // 直接监听 127.0.0.1 固定端口，把嵌入资源作为普通 HTTP 内容返回，
      // 完全不依赖 DNS 与自定义协议拦截。
      let listener = bind_fixed_port();
      let port = listener.local_addr().map(|a| a.port()).unwrap_or(14370);
      let server = tiny_http::Server::from_listener(listener, None).map_err(|e| {
        format!("静态资源服务器启动失败: {e}")
      })?;
      thread::spawn(move || {
        serve_forever(server, assets, web_root);
      });

      tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::External(
          format!("http://127.0.0.1:{port}/")
            .parse()
            .expect("invalid app url"),
        ),
      )
      .title("PromptForge 提示词工坊")
      .inner_size(1280.0, 800.0)
      .min_inner_size(640.0, 480.0)
      .resizable(true)
      .fullscreen(false)
      .build()
      .map_err(|e| format!("窗口创建失败: {e}"))?;

      Ok(())
    })
    .run(context)
    .expect("error while running tauri application");
}

/// 依次尝试固定端口（保证 localStorage 等按来源存储的数据跨启动可复用），
/// 全部被占用时退回系统分配的随机端口。
fn bind_fixed_port() -> TcpListener {
  for port in 14370..14390 {
    if let Ok(l) = TcpListener::bind(("127.0.0.1", port)) {
      return l;
    }
  }
  TcpListener::bind(("127.0.0.1", 0)).expect("no port available")
}

fn guess_mime(path: &str) -> &'static str {
  let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
  match ext.as_str() {
    "html" => "text/html; charset=utf-8",
    "css" => "text/css; charset=utf-8",
    "js" | "mjs" => "application/javascript; charset=utf-8",
    "json" | "webmanifest" => "application/json; charset=utf-8",
    "svg" => "image/svg+xml",
    "png" => "image/png",
    "ico" => "image/x-icon",
    "woff2" => "font/woff2",
    "txt" | "md" => "text/plain; charset=utf-8",
    _ => "application/octet-stream",
  }
}

fn serve_forever(
  server: tiny_http::Server,
  assets: Arc<HashMap<String, Vec<u8>>>,
  web_root: Arc<RwLock<Option<PathBuf>>>,
) {
  for request in server.incoming_requests() {
    let path = request
      .url()
      .split(['?', '#'])
      .next()
      .unwrap_or("/")
      .trim_start_matches('/');
    let raw = format!("/{}", if path.is_empty() { "index.html" } else { path });
    // 与嵌入资源的规范化键保持一致（统一前导斜杠）
    let key: String = AssetKey::from(raw.as_str()).into();

    // 1) 热更新目录优先：从磁盘读取最新前端资源；2) 回退到内嵌资源
    let body = {
      let mut found = None;
      if let Ok(guard) = web_root.read() {
        if let Some(dir) = guard.as_ref() {
          found = read_from_web_root(dir, &key);
        }
      }
      found.or_else(|| assets.get(&key).cloned())
    };

    let response = match body {
      Some(bytes) => {
        let header = tiny_http::Header::from_bytes(
          &b"Content-Type"[..],
          guess_mime(&key).as_bytes().to_vec(),
        )
        .expect("invalid content-type header");
        tiny_http::Response::from_data(bytes).with_header(header)
      }
      None => tiny_http::Response::from_string("Not Found").with_status_code(404),
    };
    let _ = request.respond(response);
  }
}

/// 从热更新目录安全读取文件（拒绝路径穿越，仅限目录内相对路径）
fn read_from_web_root(dir: &Path, key: &str) -> Option<Vec<u8>> {
  let rel = key.trim_start_matches('/');
  if rel.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..") {
    return None;
  }
  std::fs::read(dir.join(rel)).ok()
}

// ============================================================
// 应用内自动更新：前端 web 包热更新（不退出软件）；完整安装包（需退出）
// ============================================================

fn app_data_base() -> Result<PathBuf, String> {
  let base = std::env::var_os("LOCALAPPDATA")
    .map(PathBuf::from)
    .ok_or_else(|| "无法获取 LOCALAPPDATA 目录".to_string())?;
  Ok(base.join("PromptForge"))
}

/// 更新文件夹：%LOCALAPPDATA%\PromptForge\Updates（version.json + 更新包放这里）
fn update_dir() -> Result<PathBuf, String> {
  let dir = app_data_base()?.join("Updates");
  std::fs::create_dir_all(&dir).map_err(|e| format!("创建更新目录失败: {e}"))?;
  Ok(dir)
}

/// 主程序所在目录（NSIS 装到 %LOCALAPPDATA%\Programs\PromptForge 或旧版 %LOCALAPPDATA%\PromptForge）
fn install_dir() -> Result<PathBuf, String> {
  let exe = std::env::current_exe().map_err(|e| format!("无法定位程序位置: {e}"))?;
  exe.parent().map(|p| p.to_path_buf()).ok_or_else(|| "无法定位程序目录".to_string())
}

/// 已安装的前端热更新目录：%LOCALAPPDATA%\PromptForge\WebApp\<version>\
fn webapp_dir() -> Result<PathBuf, String> {
  let dir = app_data_base()?.join("WebApp");
  std::fs::create_dir_all(&dir).map_err(|e| format!("创建前端资源目录失败: {e}"))?;
  Ok(dir)
}

fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
  let mut parts = s.trim().trim_start_matches('v').split('.');
  Some((
    parts.next()?.parse().ok()?,
    parts.next()?.parse().ok()?,
    parts.next()?.parse().ok()?,
  ))
}

/// 启动时恢复版本号最高、包含 index.html 的热更新目录
fn restore_web_root() -> Option<PathBuf> {
  let base = webapp_dir().ok()?;
  let mut best: Option<((u64, u64, u64), PathBuf)> = None;
  let entries = std::fs::read_dir(&base).ok()?;
  for entry in entries.flatten() {
    if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
      continue;
    }
    let name = entry.file_name().to_string_lossy().into_owned();
    let Some(ver) = parse_version(&name) else { continue };
    if entry.path().join("index.html").is_file() {
      if best.as_ref().map(|(b, _)| ver > *b).unwrap_or(true) {
        best = Some((ver, entry.path()));
      }
    }
  }
  best.map(|(_, p)| p)
}

#[tauri::command]
fn get_version(app: tauri::AppHandle) -> String {
  app.package_info().version.to_string()
}

// ============================================================
// 应用内自动更新
//   清单来源：远程更新源（设置里的 URL）优先，取不到再回退本地更新目录。
//   这样网页端与客户端共用同一份 version.json，发布一次两端同时可见。
// ============================================================

/// 检测 15s 超时；下载给 10 分钟（安装包可能几十 MB）
const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(serde::Serialize)]
struct UpdateInfo {
  version: String,
  /// "web" = 前端热更新（不退出软件）；"app" = 完整安装包（需退出安装）
  kind: String,
  file: String,
  notes: String,
  /// 清单来源："remote" = 远程更新源，"local" = 本地更新目录
  source: String,
  /// 安装包是否已在本地（远程清单需要先 download_update 拉取）
  downloaded: bool,
  current_app: String,
  current_web: String,
  size: u64,
}

/// 规范化后的更新清单（兼容新旧两种字段写法）
struct Manifest {
  version: String,
  notes: String,
  app_file: Option<String>,
  web_file: Option<String>,
  size: u64,
  /// 内置在线服务配置，随清单一起下发（改地址不用发新版客户端）
  service_endpoint: Option<String>,
  service_model: Option<String>,
  service_key: Option<String>,
  service_enabled: bool,
  /// 部署方更新 version.json 时忘了同步 Latest-*：由清单自己声明，
  /// 前端据此提示用户重新下载，不要静默显示「最新版本」。
  internal_latest: Option<String>,
}

fn manifest_from_value(v: &serde_json::Value) -> Result<Manifest, String> {
  let version = v
    .get("version")
    .and_then(|x| x.as_str())
    .ok_or("更新清单缺少 version 字段")?
    .to_string();
  let notes = v.get("notes").and_then(|x| x.as_str()).unwrap_or("").to_string();
  let size = v.get("size").and_then(|x| x.as_u64()).unwrap_or(0);
  // 单个字段可能是字符串也可能是 {file,size} 对象，两种都兼容
  let as_file = |key: &str| -> Option<String> {
    let val = v.get(key)?;
    if let Some(s) = val.as_str() {
      return Some(s.to_string());
    }
    val.get("file").and_then(|f| f.as_str()).map(|s| s.to_string())
  };

  let mut app_file = as_file("windows").or_else(|| as_file("app"));
  let mut web_file = as_file("web");
  // 兼容旧版 latest.json：只有 file 字段时按扩展名判断类型
  if let Some(f) = as_file("file") {
    if f.to_ascii_lowercase().ends_with(".json") {
      if web_file.is_none() {
        web_file = Some(f);
      }
    } else if app_file.is_none() {
      app_file = Some(f);
    }
  }

  // service 块：enabled/endpoint/model/key
  let svc = v.get("service");
  let svc_str = |k: &str| svc.and_then(|s| s.get(k)).and_then(|x| x.as_str()).map(|s| s.to_string());
  let service_enabled = svc.and_then(|s| s.get("enabled")).and_then(|x| x.as_bool()).unwrap_or(false);

  // internalLatest 可能是字符串，也可能是 {enabled, endpoint, name} 对象
  let internal_latest = match v.get("internalLatest") {
    Some(serde_json::Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
    Some(serde_json::Value::Object(_)) => {
      let enabled = v
        .get("internalLatest")
        .and_then(|x| x.get("enabled"))
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
      if enabled {
        v.get("internalLatest")
          .and_then(|x| x.get("endpoint"))
          .and_then(|x| x.as_str())
          .filter(|s| !s.trim().is_empty())
          .map(|s| s.to_string())
      } else {
        None
      }
    }
    _ => None,
  };

  Ok(Manifest {
    version,
    notes,
    app_file,
    web_file,
    size,
    service_endpoint: svc_str("endpoint"),
    service_model: svc_str("model"),
    service_key: svc_str("key"),
    service_enabled,
    internal_latest,
  })
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, String> {
  reqwest::Client::builder()
    .timeout(timeout)
    .user_agent(concat!("PromptForge/", env!("CARGO_PKG_VERSION")))
    .build()
    .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))
}

async fn fetch_remote_manifest(base: &str) -> Option<Manifest> {
  let base = base.trim().trim_end_matches('/');
  if base.is_empty() {
    return None;
  }
  let url = format!("{base}/version.json");
  let client = http_client(CHECK_TIMEOUT).ok()?;
  let resp = client.get(&url).send().await.ok()?;
  if !resp.status().is_success() {
    return None;
  }
  let value: serde_json::Value = resp.json().await.ok()?;
  manifest_from_value(&value).ok()
}

fn read_local_manifest() -> Result<Manifest, String> {
  let dir = update_dir()?;
  for name in ["version.json", "latest.json"] {
    if let Ok(text) = std::fs::read_to_string(dir.join(name)) {
      let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{name} 解析失败: {e}"))?;
      return manifest_from_value(&value);
    }
  }
  Err("未找到更新清单：请在设置里填写「更新源地址」，或把 version.json 与更新包放进更新文件夹".to_string())
}

/// 从磁盘上的某个 version.json 读清单。失败一律返回 None（调用方只关心"有没有"）。
fn read_manifest_at(path: &Path) -> Option<Manifest> {
  let text = std::fs::read_to_string(path).ok()?;
  let value: serde_json::Value = serde_json::from_str(&text).ok()?;
  manifest_from_value(&value).ok()
}

/// 便携部署（绿色版）自描述清单：主程序目录下的 version.json。
///
/// 为什么需要这一层：此前更新只剩两条路——用户手填更新源地址，或把清单手工放进
/// %LOCALAPPDATA%\PromptForge\Updates。两条都要用户"记得做点什么"，于是
/// 「发布新版本 → 旧客户端点检查更新 → 永远显示最新版本」成了反复出现的故障。
/// 而便携包（release/ 整个目录拷到 U 盘或共享盘）本来就带着一份 version.json，
/// 客户端自己就能读到，不该再要求人工配置。
fn read_portable_manifest() -> Option<Manifest> {
  let dir = install_dir().ok()?;
  for name in ["version.json", "latest.json"] {
    if let Some(m) = read_manifest_at(&dir.join(name)) {
      return Some(m);
    }
  }
  None
}

/// 热更新目录（%LOCALAPPDATA%\PromptForge\WebApp\<版本>\）里的清单副本。
/// 前端页面本身就位于这个目录，用户在那里放一份 version.json 同样应当被识别到。
fn read_webapp_manifest() -> Option<Manifest> {
  let root = restore_web_root()?;
  for name in ["version.json", "latest.json"] {
    if let Some(m) = read_manifest_at(&root.join(name)) {
      return Some(m);
    }
  }
  None
}

/// 探测所有本地清单来源，按优先级返回"版本号最高"的那一份。
/// 返回 (清单, 来源说明)。来源说明用于前端展示，让用户知道是哪个文件生效的。
fn read_best_local_manifest() -> Option<(Manifest, String)> {
  let mut best: Option<((u64, u64, u64), Manifest, String)> = None;
  let mut consider = |m: Option<Manifest>, label: &str| {
    let Some(m) = m else { return };
    let Some(v) = parse_version(&m.version) else { return };
    if best.as_ref().map(|(bv, _, _)| v > *bv).unwrap_or(true) {
      best = Some((v, m, label.to_string()));
    }
  };
  consider(read_local_manifest().ok(), "本地更新文件夹");
  consider(read_portable_manifest(), "主程序目录");
  consider(read_webapp_manifest(), "前端资源目录");
  best.map(|(_, m, l)| (m, l))
}

/// 清理过时的前端版本目录：只保留当前生效的和上一个（留一个可回滚），其余删除。
/// 长期不清理会让 %LOCALAPPDATA% 里堆一堆积压的旧版本。
fn prune_web_versions(keep: Option<&str>) -> Result<usize, String> {
  let base = webapp_dir()?;
  let mut dirs: Vec<((u64, u64, u64), PathBuf, String)> = Vec::new();
  for entry in std::fs::read_dir(&base).map_err(|e| format!("读取前端资源目录失败: {e}"))?.flatten() {
    if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
    let name = entry.file_name().to_string_lossy().into_owned();
    if let Some(v) = parse_version(&name) {
      dirs.push((v, entry.path(), name));
    }
  }
  if dirs.len() <= 2 { return Ok(0); }

  dirs.sort_by(|a, b| b.0.cmp(&a.0)); // 新 → 旧
  let keep_prev = dirs
    .iter()
    .find(|(_, _, n)| Some(n.as_str()) != keep)
    .map(|(_, _, n)| n.clone());

  let mut removed = 0;
  for (_, path, name) in dirs {
    if Some(name.as_str()) == keep { continue; }
    if keep_prev.as_deref() == Some(name.as_str()) { continue; }
    if std::fs::remove_dir_all(&path).is_ok() { removed += 1; }
  }
  Ok(removed)
}

/// 清理更新文件夹里的旧版更新包（只保留当前清单里引用的那个）
fn prune_update_files(keep: Option<&str>) -> Result<usize, String> {
  let dir = update_dir()?;
  let mut removed = 0;
  for entry in std::fs::read_dir(&dir).map_err(|e| format!("读取更新目录失败: {e}"))?.flatten() {
    if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) { continue; }
    let name = entry.file_name().to_string_lossy().into_owned();
    // 清单本身不删；当前正在用的包不删
    if name == "version.json" || name == "latest.json" { continue; }
    if keep.map(|k| k == name).unwrap_or(false) { continue; }
    if std::fs::remove_file(entry.path()).is_ok() { removed += 1; }
  }
  Ok(removed)
}

/// 只允许落盘到更新目录内的单层文件名，杜绝路径穿越
fn safe_file_name(f: &str) -> Result<String, String> {
  let name = f.rsplit(['/', '\\']).next().unwrap_or("").trim().to_string();
  if name.is_empty() || name.contains("..") || name.contains('\0') {
    return Err(format!("非法的更新文件名: {f}"));
  }
  Ok(name)
}

/// 当前生效的前端版本：热更新目录版本优先，否则等于程序版本
fn current_web_version(app: &tauri::AppHandle) -> String {
  match restore_web_root() {
    Some(p) => {
      let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
      if parse_version(&name).is_some() {
        name
      } else {
        app.package_info().version.to_string()
      }
    }
    None => app.package_info().version.to_string(),
  }
}

/// 检查更新：远程清单优先，失败回退本地更新目录
#[tauri::command]
async fn check_update(
  app: tauri::AppHandle,
  base_url: Option<String>,
) -> Result<Option<UpdateInfo>, String> {
  let base = base_url.unwrap_or_default();
  let app_version = app.package_info().version.to_string();
  let web_version = current_web_version(&app);

  // 用户没填更新源时，试一次清单里声明的内置分发源（internalLatest）。
  // 少了这一层，新装客户端在「程序本体落后」时永远拿不到安装包，
  // 只能显示「最新版本」——这正是之前用户报告的故障。
  let mut manifest = fetch_remote_manifest(&base).await;
  let mut source = "remote";
  if manifest.is_none() && base.trim().is_empty() {
    if let Some((local, label)) = read_best_local_manifest() {
      if let Some(il) = local.internal_latest.clone() {
        if let Some(m) = fetch_remote_manifest(&il).await {
          manifest = Some(m);
          source = "internal";
        }
      }
      let _ = label;
    }
  }
  let (manifest, source) = match manifest {
    Some(m) => (m, source.to_string()),
    None => match read_best_local_manifest() {
      Some((m, label)) => (m, label),
      None => (read_local_manifest()?, "local".to_string()),
    },
  };

  let newest = parse_version(&manifest.version).ok_or("清单里的版本号格式不正确")?;
  let cur_app = parse_version(&app_version).unwrap_or((0, 0, 0));
  let cur_web = parse_version(&web_version).unwrap_or(cur_app);

  // 程序本体落后 → 装完整安装包；只有前端落后 → 走热更新。
  //
  // 关键修复：程序本体落后却拿不到安装包时，过去直接 return Ok(None)，
  // 前端据此显示「已是最新版本」——把"清单不完整"谎报成"没有更新"，
  // 用户因此反复点检查更新却永远升不上去。现在明确报错，把原因说清楚。
  let (kind, file) = if newest > cur_app {
    match manifest.app_file.clone() {
      Some(f) => ("app", f),
      None => match manifest.web_file.clone() {
        Some(f) => ("web", f),
        None => {
          return Err(format!(
            "清单已是 v{}（当前程序 v{}），但既没有安装包字段（windows/app）也没有前端热更新包字段（web）。\
             请检查更新源里的 version.json 是否由 `npm run release` 生成。",
            manifest.version, app_version
          ))
        }
      },
    }
  } else if newest > cur_web {
    match manifest.web_file.clone() {
      Some(f) => ("web", f),
      None => {
        return Err(format!(
          "清单已是 v{}（当前前端 v{}），但缺少前端热更新包字段（web）。\
             请检查更新源里的 version.json，或改用手填更新源地址重新发布。",
          manifest.version, web_version
        ))
      }
    }
  } else {
    return Ok(None);
  };

  // 远程/内置源：包不一定在本地（需要先 download_update）。
  // 本地源：必须已经存在，否则明确报错，不要假装「已是最新」。
  let payload = update_dir()?.join(safe_file_name(&file)?);
  let downloaded = payload.exists();
  if source == "local" && !downloaded {
    return Err(format!("更新文件不存在: {}", payload.display()));
  }

  Ok(Some(UpdateInfo {
    version: manifest.version.clone(),
    kind: kind.to_string(),
    file,
    notes: manifest.notes.clone(),
    source,
    downloaded,
    current_app: app_version,
    current_web: web_version,
    size: manifest.size,
  }))
}

/// 从远程更新源下载更新包到本地更新目录
#[tauri::command]
async fn download_update(base_url: Option<String>, file: String) -> Result<String, String> {
  let base = base_url.unwrap_or_default().trim().trim_end_matches('/').to_string();
  if base.is_empty() {
    return Err("未配置更新源地址，无法下载".to_string());
  }
  let name = safe_file_name(&file)?;
  let url = format!("{base}/{name}");

  let resp = http_client(DOWNLOAD_TIMEOUT)?
    .get(&url)
    .send()
    .await
    .map_err(|e| format!("下载失败: {e}"))?;
  if !resp.status().is_success() {
    return Err(format!("下载失败，服务器返回 {}", resp.status()));
  }
  let bytes = resp.bytes().await.map_err(|e| format!("读取下载内容失败: {e}"))?;

  let dest = update_dir()?.join(&name);
  std::fs::write(&dest, &bytes).map_err(|e| format!("写入更新包失败: {e}"))?;
  Ok(dest.to_string_lossy().into_owned())
}

/// 安装更新：web 包原地解包并热切换（不退出）；app 安装包静默安装后退出
#[tauri::command]
async fn install_update(
  app: tauri::AppHandle,
  base_url: Option<String>,
) -> Result<String, String> {
  let Some(info) = check_update(app.clone(), base_url.clone()).await? else {
    return Err("当前已是最新版本".to_string());
  };

  // 远程清单且尚未下载 → 先落盘再安装
  if !info.downloaded {
    download_update(base_url, info.file.clone()).await?;
  }

  let payload_path = update_dir()?.join(safe_file_name(&info.file)?);

  if info.kind == "web" {
    let data = std::fs::read_to_string(&payload_path)
      .map_err(|e| format!("读取更新包失败: {e}"))?;
    let pack: serde_json::Value =
      serde_json::from_str(&data).map_err(|e| format!("更新包解析失败: {e}"))?;

    let version = pack
      .get("version")
      .and_then(|v| v.as_str())
      .ok_or("更新包缺少 version 字段")?
      .to_string();
    let target = webapp_dir()?.join(&version);
    // 覆盖式解包（重复安装同一版本也安全）
    std::fs::create_dir_all(&target).map_err(|e| format!("创建版本目录失败: {e}"))?;

    let files = pack
      .get("files")
      .and_then(|f| f.as_object())
      .ok_or("更新包缺少 files 字段")?;
    for (name, content) in files {
      // 安全校验：拒绝路径穿越
      if name.split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..") {
        return Err(format!("更新包包含非法路径: {name}"));
      }
      let b64 = content.as_str().ok_or("更新包文件内容格式错误")?;
      let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("文件解码失败: {e}"))?;
      let dest = target.join(name);
      if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
      }
      std::fs::write(&dest, bytes).map_err(|e| format!("写入文件失败: {e}"))?;
    }

    // 校验关键文件存在后热切换
    if !target.join("index.html").is_file() {
      return Err("更新包缺少 index.html，已中止".to_string());
    }

    let state = app.state::<AppState>();
    *state.web_root.write().map_err(|e| e.to_string())? = Some(target.clone());

    // 装完顺手清理积压的旧版本目录与旧更新包，避免越用越占空间
    let _ = prune_web_versions(Some(&version));
    let _ = prune_update_files(None);

    Ok("web".to_string())
  } else {
    // 完整安装包：延迟启动静默安装，随后退出应用
    let full = format!(
      "timeout /t 2 /nobreak >nul & start \"\" \"{}\" /S",
      payload_path.display().to_string().replace('"', "\"\"")
    );
    Command::new("cmd")
      .args(["/C", &full])
      .spawn()
      .map_err(|e| format!("启动安装器失败: {e}"))?;

    thread::spawn(move || {
      thread::sleep(Duration::from_millis(600));
      app.exit(0);
    });

    Ok("app".to_string())
  }
}

/// 在文件管理器里打开主程序所在目录——解决"装完找不到 exe 在哪"
#[tauri::command]
fn open_app_dir() -> Result<(), String> {
  let dir = install_dir()?;
  Command::new("explorer")
    .arg(&dir)
    .spawn()
    .map_err(|e| format!("打开文件夹失败: {e}"))?;
  Ok(())
}

/// 主程序 exe 的绝对路径，设置页直接展示出来
#[tauri::command]
fn app_exe_path() -> Result<String, String> {
  let exe = std::env::current_exe().map_err(|e| format!("无法定位程序位置: {e}"))?;
  Ok(exe.to_string_lossy().into_owned())
}

/// 创建/重建桌面快捷方式（用 PowerShell 的 WScript.Shell，避免引入额外依赖）
#[tauri::command]
fn create_desktop_shortcut() -> Result<String, String> {
  let exe = std::env::current_exe().map_err(|e| format!("无法定位程序位置: {e}"))?;
  let exe_path = exe.to_string_lossy().replace("'", "''");
  let lnk_name = format!("{}.lnk", env!("CARGO_PKG_NAME"));

  // $Desktop 依赖 Shell.Application，能正确拿到"当前用户桌面"（含 OneDrive 重定向的情况）
  let ps = format!(
    "$s=(New-Object -COM WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) '{lnk}'));\
     $s.TargetPath='{exe}';\
     $s.WorkingDirectory=(Split-Path '{exe}');\
     $s.Description='PromptForge 提示词工坊';\
     $s.Save()",
    lnk = lnk_name.replace("'", "''"),
    exe = exe_path
  );

  let status = Command::new("powershell")
    .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
    .status()
    .map_err(|e| format!("启动 PowerShell 失败: {e}"))?;

  if !status.success() {
    return Err("创建快捷方式失败".to_string());
  }
  let desktop = std::env::var_os("USERPROFILE")
    .map(|h| PathBuf::from(h).join("Desktop").join(&lnk_name))
    .unwrap_or_else(|| PathBuf::from(&lnk_name));
  Ok(desktop.to_string_lossy().into_owned())
}

/// 启动系统卸载程序后退出应用（卸载入口只放在设置页最底部）
#[tauri::command]
fn uninstall_app(app: tauri::AppHandle) -> Result<(), String> {
  let dir = install_dir()?;
  // Tauri 官方 NSIS 模板用的是 `WriteUninstaller "$INSTDIR\uninstall.exe"`，
  // 卸载器固定名为 uninstall.exe 且位于安装根目录。
  // 注意：Windows 文件名不区分大小写，所以用 "Uninstall.exe" 也能命中同一个文件；
  // 这里按模板的实际大小写写，避免后来者误以为文件名不对。
  let mut candidates = vec![dir.join("uninstall.exe")];
  // 兼容历史版本（早期手工打包曾把卸载器放在上一层目录）
  if let Some(parent) = dir.parent() {
    candidates.push(parent.join("uninstall.exe"));
  }

  let unins = candidates.into_iter().find(|p| p.is_file())
    .ok_or_else(|| "未找到卸载程序，请在 Windows「设置 → 应用和功能」中卸载 PromptForge".to_string())?;

  Command::new(&unins)
    .spawn()
    .map_err(|e| format!("启动卸载程序失败: {e}"))?;

  thread::spawn(move || {
    thread::sleep(Duration::from_millis(500));
    app.exit(0);
  });
  Ok(())
}

/// 帮助页要同时展示「程序版本」和「当前生效的前端版本」，两者可能不同
/// （前端热更新后界面版本会高于程序版本，这正是过去"两端不同步却看不出来"的原因）
#[derive(serde::Serialize)]
struct UpdateState {
  app_version: String,
  web_version: String,
  web_root: Option<String>,
  update_dir: String,
  synced: bool,
  /// 更新目录下已存在的清单文件名（version.json / latest.json），便于排查"为什么检查不到更新"
  local_manifest: Option<String>,
  /// 本地清单里声明的内置分发源，前端可提示用户"未配置也能用"
  internal_latest: Option<String>,
  /// 实际探测到的最佳本地清单版本号（主程序目录 / 更新文件夹 / 前端资源目录 取最高）
  local_manifest_version: Option<String>,
  /// 该清单来自哪一处（主程序目录 / 本地更新文件夹 / 前端资源目录）
  manifest_origin: Option<String>,
}

#[tauri::command]
fn update_state(app: tauri::AppHandle) -> Result<UpdateState, String> {
  let app_version = app.package_info().version.to_string();
  let web_version = current_web_version(&app);
  let dir = update_dir()?;
  // 探测本地更新目录里是否有可用清单：这是离线用户唯一的更新途径，
  // 过去用户点了「检查更新」只看到"最新版本"，无法分辨是"真最新"还是"清单没放"
  let mut local_manifest = None;
  let mut internal_latest = None;
  for name in ["version.json", "latest.json"] {
    let p = dir.join(name);
    if p.exists() {
      if local_manifest.is_none() {
        local_manifest = Some(name.to_string());
      }
      if let Ok(text) = std::fs::read_to_string(&p) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
          if let Ok(m) = manifest_from_value(&v) {
            if m.internal_latest.is_some() {
              internal_latest = m.internal_latest;
              break;
            }
          }
        }
      }
    }
  }
  // 把"实际能找到的最佳清单"也报给前端：用户没填更新源时，
  // 前端要据此说明"从哪检测的、清单上是哪个版本"，否则只能显示"最新版本"。
  let (local_manifest_version, manifest_origin) = match read_best_local_manifest() {
    Some((m, label)) => (Some(m.version), Some(label)),
    None => (None, None),
  };
  Ok(UpdateState {
    synced: web_version == app_version,
    app_version,
    web_version,
    web_root: restore_web_root().map(|p| p.to_string_lossy().into_owned()),
    update_dir: dir.to_string_lossy().into_owned(),
    local_manifest,
    internal_latest,
    local_manifest_version,
    manifest_origin,
  })
}

#[tauri::command]
fn open_update_folder() -> Result<(), String> {
  let dir = update_dir()?;
  Command::new("explorer")
    .arg(&dir)
    .spawn()
    .map_err(|e| format!("打开文件夹失败: {e}"))?;
  Ok(())
}

/// 读取更新清单里随包下发的内置在线服务配置。
/// 为什么走后端而不是前端直接 fetch：file:// 与混合内容场景下 fetch 会被拦，
/// 而客户端本就跑在本地 HTTP 服务上，由 Rust 侧读一次最稳。
/// 用户没填自己的 API 时，前端用这里返回的配置即可联网生成提示词。
#[tauri::command]
async fn builtin_service_config() -> Result<serde_json::Value, String> {
  let manifest = match read_local_manifest() {
    Ok(m) => m,
    Err(_) => return Ok(serde_json::json!({ "enabled": false })),
  };
  if !manifest.service_enabled || manifest.service_endpoint.is_none() {
    return Ok(serde_json::json!({ "enabled": false }));
  }
  Ok(serde_json::json!({
    "enabled": true,
    "endpoint": manifest.service_endpoint,
    "model": manifest.service_model,
    "key": manifest.service_key,
  }))
}