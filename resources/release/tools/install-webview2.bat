@echo off
setlocal
set "SETUP=%~dp0MicrosoftEdgeWebview2Setup.exe"

if not exist "%SETUP%" (
  echo [Pylon] 未找到 WebView2 bootstrapper: "%SETUP%"
  exit /b 1
)

echo [Pylon] 正在安装 Microsoft Edge WebView2 Runtime（Evergreen Bootstrapper）...
"%SETUP%" /silent /install

if errorlevel 1 (
  echo [Pylon] WebView2 安装失败，退出码: %errorlevel%
  exit /b 1
)

echo [Pylon] WebView2 Runtime 安装完成。如仍无法启动，请重启电脑后重试。
exit /b 0
