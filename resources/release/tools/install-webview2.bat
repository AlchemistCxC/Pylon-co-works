@echo off
setlocal
rem WebView2 Runtime 缺失时的兜底安装（2026-09-19 ADR-0014：发行包不再内置 bootstrapper）。
rem 优先使用同目录手动放置的 MicrosoftEdgeWebview2Setup.exe（离线场景），
rem 否则从微软官方 fwlink 下载 Evergreen Bootstrapper 后静默安装。
set "LOCAL_SETUP=%~dp0MicrosoftEdgeWebview2Setup.exe"
set "SETUP=%TEMP%\MicrosoftEdgeWebview2Setup.exe"

if exist "%LOCAL_SETUP%" (
  echo [Pylon] 使用同目录提供的 WebView2 安装器...
  set "SETUP=%LOCAL_SETUP%"
  goto install
)

echo [Pylon] 正在从微软官方链接下载 WebView2 Runtime 安装器（需要联网）...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/?LinkId=2124703' -OutFile '%SETUP%'"

if not exist "%SETUP%" (
  echo [Pylon] 下载失败：请检查网络，或在能联网的机器上从以下地址手动下载，
  echo         放到本 bat 同目录后重新运行：
  echo         https://go.microsoft.com/fwlink/?LinkId=2124703
  exit /b 1
)

:install
echo [Pylon] 正在安装 Microsoft Edge WebView2 Runtime（Evergreen Bootstrapper）...
"%SETUP%" /silent /install

if errorlevel 1 (
  echo [Pylon] WebView2 安装失败，退出码: %errorlevel%
  exit /b 1
)

echo [Pylon] WebView2 Runtime 安装完成。如仍无法启动，请重启电脑后重试。
exit /b 0
