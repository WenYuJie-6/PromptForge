# ============================================================
# _selftest-launcher.ps1 —— 启动器自检（MIME + 路径穿越 + 真实 HttpListener）
#
# 为什么必须有这个脚本：
#   assets-templates/启动.ps1 是双击使用的本地静态服务，肉眼无法看出它在
#   中文 Windows 上的若干陷阱：
#     1. 必须 UTF-8 BOM + CRLF —— 否则 PS 5.1 按 ANSI 解码、报假语法错误；
#     2. .exe/.msi 必须 Content-Disposition: attachment —— 否则浏览器内联打开；
#     3. 必须 GetFullPath + 前缀检查 —— 否则 ".." 可逃出 dist/；
#     4. 端口必须固定区间 —— 否则 localStorage/IndexedDB 因 origin 变化被清空。
#
# 本脚本起一个真实 HttpListener、按启动器同一套逻辑处理请求、自发自收，22 项断言。
#
# 文件格式强制：UTF-8 BOM + CRLF。否则本脚本自身无法正确解析。
# 见 scripts/fix-ps-encoding.mjs。
# ============================================================
$ErrorActionPreference = 'Stop'
$out = New-Object System.Collections.Generic.List[string]
function P($s) { $out.Add($s) | Out-Null }

$dist = 'C:\Users\Wenyujie\Desktop\Compile\Prompt\dist'
$outFile = 'C:\Users\Wenyujie\Desktop\Compile\Prompt\.workbuddy\_selftest.txt'
$port = 14401

# ---- A. MIME ----
$MimeMap = @{
  '.html'        = 'text/html; charset=utf-8'
  '.htm'         = 'text/html; charset=utf-8'
  '.js'          = 'application/javascript; charset=utf-8'
  '.mjs'         = 'application/javascript; charset=utf-8'
  '.css'         = 'text/css; charset=utf-8'
  '.json'        = 'application/json; charset=utf-8'
  '.webmanifest' = 'application/manifest+json; charset=utf-8'
  '.svg'         = 'image/svg+xml'
  '.png'         = 'image/png'
  '.ico'         = 'image/x-icon'
  '.woff2'       = 'font/woff2'
  '.exe'         = 'application/octet-stream'
  '.msi'         = 'application/octet-stream'
  '.zip'         = 'application/zip'
}
function Get-Mime([string]$Path) {
  $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
  if ($MimeMap.ContainsKey($ext)) { return $MimeMap[$ext] }
  return 'application/octet-stream'
}
P '=== A. MIME mapping ==='
$cases = @(
  @{ f = 'index.html';           want = 'text/html; charset=utf-8' }
  @{ f = 'js/app.js';            want = 'application/javascript; charset=utf-8' }
  @{ f = 'version.json';         want = 'application/json; charset=utf-8' }
  @{ f = 'manifest.webmanifest'; want = 'application/manifest+json; charset=utf-8' }
  @{ f = 'Latest-Setup.exe';     want = 'application/octet-stream' }
  @{ f = 'Latest-Setup.msi';     want = 'application/octet-stream' }
  @{ f = 'portable.zip';         want = 'application/zip' }
  @{ f = 'unknown.xyz';          want = 'application/octet-stream' }
)
foreach ($c in $cases) {
  $got = Get-Mime $c.f
  $ok = $got -eq $c.want
  P ("  {0}  {1} -> {2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $c.f, $got)
}

# ---- B. 路径穿越 ----
P ''
P '=== B. path traversal guard ==='
$root = (Resolve-Path -LiteralPath $dist).Path
$rootWithSep = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$escapes = @('/../secret.txt', '/../../Windows/win.ini', '/js/../../secret', '/%2e%2e/secret.txt', '/..%5c..%5cWindows%5cwin.ini')
foreach ($raw in $escapes) {
  $decoded = [System.Uri]::UnescapeDataString($raw)
  $rel = $decoded.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
  $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
  $inside = $full.StartsWith($rootWithSep, [System.StringComparison]::OrdinalIgnoreCase)
  P ("  {0}  {1} -> {2}" -f $(if (-not $inside) { 'PASS' } else { 'FAIL' }), $raw, $(if ($inside) { 'ALLOWED(danger!)' } else { 'denied' }))
}
$okPath = [System.IO.Path]::GetFullPath((Join-Path $root 'js\app.js'))
$okInside = $okPath.StartsWith($rootWithSep, [System.StringComparison]::OrdinalIgnoreCase)
P ("  {0}  /js/app.js -> {1}" -f $(if ($okInside) { 'PASS' } else { 'FAIL' }), 'allowed')

# ---- C. 实机请求 ----
P ''
P '=== C. live requests (real HttpListener) ==='
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$port/")
try { $listener.Start(); P "  listener started on 127.0.0.1:$port" }
catch { P "  FAIL  cannot start listener: $($_.Exception.Message)"; $out | Set-Content -Path $outFile -Encoding UTF8; exit 1 }

$stopFile = 'C:\Users\Wenyujie\Desktop\Compile\Prompt\.workbuddy\_selftest.stop'
if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile -Force }

$sb = {
  param($ln, $root, $stopFile)
  while (-not (Test-Path -LiteralPath $stopFile)) {
    $ctx = $null
    try { $ctx = $ln.GetContext() } catch { break }
    if ($null -eq $ctx) { break }
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      $rawPath = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
      if ([string]::IsNullOrWhiteSpace($rawPath) -or $rawPath -eq '/') { $rawPath = '/index.html' }
      $rel = $rawPath.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
      $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
      $rootSep = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
      if (-not $full.StartsWith($rootSep, [System.StringComparison]::OrdinalIgnoreCase)) {
        $res.StatusCode = 403; $b = [System.Text.Encoding]::UTF8.GetBytes('403'); $res.ContentLength64 = $b.Length; $res.OutputStream.Write($b, 0, $b.Length); continue
      }
      if (Test-Path -LiteralPath $full -PathType Container) { $full = Join-Path $full 'index.html' }
      if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        $res.StatusCode = 404; $b = [System.Text.Encoding]::UTF8.GetBytes('404'); $res.ContentLength64 = $b.Length; $res.OutputStream.Write($b, 0, $b.Length); continue
      }
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
      $mime = 'application/octet-stream'
      if ($ext -eq '.html' -or $ext -eq '.htm') { $mime = 'text/html; charset=utf-8' }
      elseif ($ext -eq '.js' -or $ext -eq '.mjs') { $mime = 'application/javascript; charset=utf-8' }
      elseif ($ext -eq '.css') { $mime = 'text/css; charset=utf-8' }
      elseif ($ext -eq '.json') { $mime = 'application/json; charset=utf-8' }
      $res.StatusCode = 200
      $res.ContentType = $mime
      $res.ContentLength64 = $bytes.Length
      $res.AddHeader('Cache-Control', 'no-cache')
      if ($ext -eq '.exe' -or $ext -eq '.msi') {
        $fileName = [System.IO.Path]::GetFileName($full)
        $res.AddHeader('Content-Disposition', "attachment; filename=$fileName")
      }
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch { } finally { try { $res.Close() } catch {} }
  }
}

$ps = [PowerShell]::Create()
$null = $ps.AddScript($sb).AddArgument($listener).AddArgument($root).AddArgument($stopFile)
$null = $ps.BeginInvoke()
Start-Sleep -Milliseconds 500

$tests = @(
  @{ url = '/index.html';       want = 200 }
  @{ url = '/js/app.js';        want = 200 }
  @{ url = '/version.json';     want = 200 }
  @{ url = '/Latest-Setup.exe'; want = 200 }
  @{ url = '/nope.txt';         want = 404 }
)
foreach ($t in $tests) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port$($t.url)" -UseBasicParsing -TimeoutSec 10
    $got = $r.StatusCode; $len = $r.RawContentLength
  } catch {
    $got = 0; $len = 0
    if ($_.Exception.Response -ne $null) { try { $got = [int]$_.Exception.Response.StatusCode.value__ } catch {} }
  }
  $ok = $got -eq $t.want
  P ("  {0}  {1} -> {2} (len={3})" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $t.url, $got, $len)
}

try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/Latest-Setup.exe" -UseBasicParsing -TimeoutSec 10
  $cd = [string]$r.Headers['Content-Disposition']
  $ct = [string]$r.Headers['Content-Type']
  P ("  {0}  exe Content-Disposition = {1}" -f $(if ($cd -like '*attachment*') { 'PASS' } else { 'FAIL' }), $cd)
  P ("  {0}  exe Content-Type = {1}" -f $(if ($ct -like '*octet-stream*') { 'PASS' } else { 'FAIL' }), $ct)
  P ("  {0}  exe size = {1} MB" -f $(if ($r.RawContentLength -gt 3000000) { 'PASS' } else { 'FAIL' }), [math]::Round($r.RawContentLength / 1MB, 2))
} catch { P "  FAIL  exe request error: $($_.Exception.Message)" }

New-Item -ItemType File -Path $stopFile -Force | Out-Null
try { $listener.Stop() } catch {}; try { $listener.Close() } catch {}
Start-Sleep -Milliseconds 300
try { $ps.Stop() } catch {}; try { $ps.Dispose() } catch {}
Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue

P ''
P '=== result ==='
$fails = @($out | Where-Object { $_ -match 'FAIL' }).Count
$passes = @($out | Where-Object { $_ -match 'PASS' }).Count
P "  passed: $passes"
P "  failed: $fails"
$out | Set-Content -Path $outFile -Encoding UTF8
if ($fails -gt 0) { exit 1 } else { exit 0 }