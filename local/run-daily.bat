@echo off
rem 每天由任务计划程序调用：无头跑一次领取，日志追加到 local\run.log。
setlocal
cd /d "%~dp0.."
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
if exist "%~dp0secrets.cmd" call "%~dp0secrets.cmd"
set COZE_PROFILE_DIR=%LOCALAPPDATA%\coze-daily-profile
set HEADLESS=true
echo ===== %DATE% %TIME% =====>> "%~dp0run.log"
node scripts\coze-daily.mjs>> "%~dp0run.log" 2>&1
endlocal
