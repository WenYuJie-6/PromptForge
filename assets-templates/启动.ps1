<#
  PromptForge 本地服务器 —— 让"双击打开"享有与部署到网站完全一致的能力。

  为什么需要这个脚本：
    浏览器把每个 file:// 路径都视为【不同的源】。于是双击 index.html 打开时，
    以下功能全部被浏览器安全策略禁用，且无法用代码绕过：
      · <a download> 下载安装包 —— 被静默忽略（用户看到"点了没反应"）
      · Service Worker / PWA 安装 —— 非安全上下文不注册
      · fetch 读取同目录 version.json —— 跨源被拦，更新检测失效
    这四条限制的根因是同一个（file:// 不参与同源判定），所以一次解决。

  做法：用 Windows 自带的 .NET HttpListener 起一个只监听 127.0.0.1 的静态服务器，
  然后打开 http://127.0.0.1:<port>/。此时页面处于正常的 http 源下，上述功能全部恢复。

  为什么不用 Python / Node：用户机器上不保证装了。PowerShell 5.1 与 .NET 是 Windows 内置的，
  零依赖、双击即可用。

  安全设计：
    · 只绑定 127.0.0.1（不是 0.0.0.0），局域网内其他机器访问不到
    · 只读取本脚本所在目录及其子目录，路径穿越请求一律 403
    · 需要管理员权限才能监听的 URL 前缀会回退到随机高位端口
#>

[CmdletBinding()]
param(
    # 指定端口；0 表示自动挑选可用端口（默认）
    [int]$Port = 0,
    # 只启动服务器，不自动打开浏览器（调试用）
    [switch]$NoBrowser,
    # 服务器就绪后等待的秒数上限
    [int]$ReadyTimeoutSec = 15
)

$ErrorActionPreference = 'Stop'

# 以脚本自身所在目录为网站根目录 —— 部署方把启动脚本与 index.html 放一起即可
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path -LiteralPath $Root).Path

$IndexPath = Join-Path $Root 'index.html'
if (-not (Test-Path -LiteralPath $IndexPath)) {
    Write-Host ''
    Write-Host '  [错误] 当前目录下没有找到 index.html' -ForegroundColor Red
    Write-Host "  当前目录：$Root" -ForegroundColor DarkGray
    Write-Host '  请把本脚本与 index.html 放在同一个文件夹里再运行。' -ForegroundColor DarkGray
    Write-Host ''
    Read-Host '按回车键退出'
    exit 1
}

# ---------------------------------------------------------------- MIME 映射
$MimeMap = @{
    '.html' = 'text/html; charset=utf-8'
    '.htm'  = 'text/html; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.mjs'  = 'application/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.webmanifest' = 'application/manifest+json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.gif'  = 'image/gif'
    '.webp' = 'image/webp'
    '.ico'  = 'image/x-icon'
    '.woff' = 'font/woff'
    '.woff2' = 'font/woff2'
    '.ttf'  = 'font/ttf'
    '.otf'  = 'font/otf'
    '.txt'  = 'text/plain; charset=utf-8'
    '.md'   = 'text/plain; charset=utf-8'
    '.map'  = 'application/json; charset=utf-8'
    # 安装包：用 octet-stream 且带 Content-Disposition，确保浏览器落盘而不是尝试打开
    '.exe'  = 'application/octet-stream'
    '.msi'  = 'application/octet-stream'
    '.zip'  = 'application/zip'
}
function Get-Mime([string]$Path) {
    $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
    if ($MimeMap.ContainsKey($ext)) { return $MimeMap[$ext] }
    return 'application/octet-stream'
}

# ---------------------------------------------------------------- 挑选端口
# 依次尝试固定端口（保证 localStorage 等按来源存储的数据跨启动可复用 —— 端口不同
# 就是不同的源，用户的设置与历史会"消失"，所以优先固定端口）。
function New-Listener([int[]]$Candidates) {
    foreach ($p in $Candidates) {
        $l = New-Object System.Net.HttpListener
        $l.Prefixes.Add("http://127.0.0.1:$p/")
        try {
            $l.Start()
            return @{ Listener = $l; Port = $p }
        } catch {
            try { $l.Close() } catch {}
        }
    }
    return $null
}

$candidates = if ($Port -gt 0) { @($Port) } else { 14370..14390 }
$bound = New-Listener $candidates

if (-not $bound) {
    Write-Host ''
    Write-Host '  [提示] 常用端口被占用，改用系统随机端口。' -ForegroundColor Yellow
    Write-Host '  （注意：端口变化会导致浏览器里已保存的设置与历史记录读不到，' -ForegroundColor DarkGray
    Write-Host '    因为不同端口属于不同的来源。关闭占用端口的程序后重试可恢复。）' -ForegroundColor DarkGray
    $l = New-Object System.Net.HttpListener
    $randomPort = Get-Random -Minimum 40000 -Maximum 60000
    $l.Prefixes.Add("http://127.0.0.1:$randomPort/")
    $l.Start()
    $bound = @{ Listener = $l; Port = $randomPort }
}

$listener = $bound.Listener
$port = $bound.Port
$baseUrl = "http://127.0.0.1:$port/"

Write-Host ''
Write-Host '  ╔══════════════════════════════════════════════════╗' -ForegroundColor Cyan
Write-Host '  ║        PromptForge 提示词工坊 · 本地启动器        ║' -ForegroundColor Cyan
Write-Host '  ╚══════════════════════════════════════════════════╝' -ForegroundColor Cyan
Write-Host ''
Write-Host "   网站目录：$Root" -ForegroundColor DarkGray
Write-Host "   访问地址：$baseUrl" -ForegroundColor Green
Write-Host ''
Write-Host '   在此模式下「下载桌面版」「安装应用」「检查更新」全部可用。' -ForegroundColor DarkGray
Write-Host '   关闭此窗口即停止服务（浏览器里的数据会保留）。' -ForegroundColor DarkGray
Write-Host ''

# ---------------------------------------------------------------- 打开浏览器
if (-not $NoBrowser) {
    Start-Process $baseUrl | Out-Null
}

# ---------------------------------------------------------------- 请求循环
# 说明：PowerShell 5.1 没有稳定的异步循环，这里用同步 GetContext()。
# 单用户本地访问场景下性能完全够用（安装包 3MB 也就几十毫秒）。
$running = $true
try {
    while ($running -and $listener.IsListening) {
        $ctx = $null
        try { $ctx = $listener.GetContext() } catch { break }

        $req = $ctx.Request
        $res = $ctx.Response
        try {
            # --- 路径解析 + 穿越防护 ---
            $rawPath = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
            if ([string]::IsNullOrWhiteSpace($rawPath) -or $rawPath -eq '/') {
                $rawPath = '/index.html'
            }
            # 归一化后必须仍在 Root 之下，否则拒绝
            $rel = $rawPath.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
            $full = [System.IO.Path]::GetFullPath((Join-Path $Root $rel))
            $rootWithSep = $Root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

            if (-not $full.StartsWith($rootWithSep, [System.StringComparison]::OrdinalIgnoreCase)) {
                $res.StatusCode = 403
                $body = [System.Text.Encoding]::UTF8.GetBytes('403 Forbidden')
                $res.ContentType = 'text/plain; charset=utf-8'
                $res.ContentLength64 = $body.Length
                $res.OutputStream.Write($body, 0, $body.Length)
                $res.Close()
                Write-Host "   403  $rawPath" -ForegroundColor Yellow
                continue
            }

            # 目录请求 → 补 index.html
            if (Test-Path -LiteralPath $full -PathType Container) {
                $full = Join-Path $full 'index.html'
            }

            if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
                $res.StatusCode = 404
                $body = [System.Text.Encoding]::UTF8.GetBytes('404 Not Found')
                $res.ContentType = 'text/plain; charset=utf-8'
                $res.ContentLength64 = $body.Length
                $res.OutputStream.Write($body, 0, $body.Length)
                $res.Close()
                Write-Host "   404  $rawPath" -ForegroundColor DarkGray
                continue
            }

            # --- 输出文件 ---
            $bytes = [System.IO.File]::ReadAllBytes($full)
            $res.StatusCode = 200
            $res.ContentType = Get-Mime $full
            $res.ContentLength64 = $bytes.Length
            # 安装包强制落盘：否则浏览器可能尝试用关联程序打开
            $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
            if ($ext -eq '.exe' -or $ext -eq '.msi') {
                $fileName = [System.IO.Path]::GetFileName($full)
                $res.AddHeader('Content-Disposition', "attachment; filename=`"$fileName`"")
            }
            # 明确告知浏览器这是可缓存的静态内容
            $res.AddHeader('Cache-Control', 'no-cache')
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
            $res.Close()

            $sizeKb = [math]::Round($bytes.Length / 1KB, 1)
            $color = if ($ext -eq '.exe' -or $ext -eq '.msi') { 'Green' } else { 'DarkGray' }
            Write-Host "   200  $rawPath  ($sizeKb KB)" -ForegroundColor $color
        } catch {
            try {
                $res.StatusCode = 500
                $res.Close()
            } catch {}
            Write-Host "   500  $($req.Url.AbsolutePath)  $($_.Exception.Message)" -ForegroundColor Red
        }
    }
} finally {
    try { $listener.Stop(); $listener.Close() } catch {}
    Write-Host ''
    Write-Host '   服务已停止。' -ForegroundColor DarkGray
    Write-Host ''
}
