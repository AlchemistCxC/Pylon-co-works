Pylon 便携版（portable）
========================

【首次运行前请先看这里】
如果双击 pylon.exe 无窗口、闪退，或系统提示缺少 WebView2 Runtime，
请先运行本目录下 tools\install-webview2.bat（需要联网），完成后重新双击 pylon.exe。

【配置 Agent】
1. 把 agents.example.yaml 复制为 agents.yaml（与 pylon.exe 同目录）。
2. 把 agents.yaml 中的 exe 占位路径改成你的 Agent 可执行文件绝对路径。
3. 启动 Pylon 后，可在 设置 → Agent 中切换/测试/新建 Agent。

【数据目录】
本包为便携模式：所有数据（会话、插件、MCP、宠物等）保存在本目录 data\ 下。
删除 portable.flag 并移走 data\ 目录后启动，将回到系统 AppData 目录。

【安装包】
如果你需要安装版（NSIS/MSI），请使用 `npx tauri build --bundles nsis,msi`，
WebView2 会由安装器自动下载引导。
