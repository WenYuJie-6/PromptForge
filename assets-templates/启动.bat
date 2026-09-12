@echo off
rem ============================================================================
rem  PromptForge 提示词工坊 —— 本地启动器
rem
rem  双击本文件即可：自动起一个本地服务器并打开浏览器。
rem
rem  为什么需要它：浏览器把每个 file:// 路径视为不同的源，于是双击 index.html
rem  打开时「下载桌面版」「安装应用」「检查更新」都会被浏览器禁用，且无法用代码绕过。
rem  经由本脚本以 http://127.0.0.1 打开，这些功能全部恢复正常。
rem
rem  本文件必须保存为 ANSI / GBK 编码（中文注释才不会乱码），
rem  且不能包含中文字符以外的非 ASCII 符号在本行的 rem 之后。
rem ============================================================================

setlocal
chcp 65001 >nul 2>&1

rem 以本文件所在目录为工作目录
cd /d "%~dp0"

set "PS1=%~dp0启动.ps1"
if not exist "%PS1%" (
    echo.
    echo   [错误] 未找到 启动.ps1，请确认它与本文件在同一目录。
    echo.
    pause
    exit /b 1
)

rem -NoProfile 跳过用户 profile，避免被自定义别名/策略干扰
rem -ExecutionPolicy Bypass 只对本次进程生效，不修改系统设置
rem -STA 让 Start-Process 等 UI 相关调用行为正常
powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "%PS1%" %*

if errorlevel 1 (
    echo.
    echo   [提示] 启动器异常退出。若提示"无法启动服务"，可能是端口被占用，
    echo          关闭其他 PromptForge 启动器窗口后重试即可。
    echo.
    pause
)

endlocal
