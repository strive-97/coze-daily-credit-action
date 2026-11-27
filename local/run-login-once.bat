@echo off
rem 一次性登录：弹出有头浏览器，手动完成 coze.cn 登录（短信/扫码），登录成功后关掉窗口即可。
rem 登录态保存在 COZE_PROFILE_DIR 指向的本地浏览器档案里，之后每天由 run-daily.bat 复用。
setlocal
cd /d "%~dp0.."
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
if exist "%~dp0secrets.cmd" call "%~dp0secrets.cmd"
set COZE_PROFILE_DIR=%LOCALAPPDATA%\coze-daily-profile
set HEADLESS=false
node scripts\coze-daily.mjs
endlocal
