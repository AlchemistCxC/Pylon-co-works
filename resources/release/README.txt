Pylon 便携版（portable）
========================

【首次运行前请先看这里】
如果双击 pylon.exe 无窗口、闪退，或系统提示缺少 WebView2 Runtime，
请先运行本目录下 tools\install-webview2.bat（需要联网），完成后重新双击 pylon.exe。

【配置 Agent】
1. 把 agents.example.yaml 复制为 agents.yaml（与 pylon.exe 同目录）。
2. 把 agents.yaml 中的 exe 占位路径改成你的 Agent 可执行文件绝对路径。
3. 启动 Pylon 后，可在 设置 → Agent 中切换/测试/新建 Agent。

【插件 SDK（离线开发）】
发行包内的 resources\sdk\ 是不依赖 Node 或源码的离线 SDK：
1. 将 resources\sdk\pylon-plugin-sdk.js 复制到插件目录；
2. 用同目录的 pylon-plugin-manifest.schema.json 校验 pylon-plugin.json；
3. 在纯 JS ESM 入口中相对导入 ./pylon-plugin-sdk.js，然后从 设置 → 插件 安装目录。
离线 SDK 只包含浏览器 runtime 和 manifest schema；需要 TypeScript、类型声明或
createMockContext 测试基建时，请使用插件开发套件中的 sdk\ 正常版包。

【Hermes（Windows）】
便携包自带完整的 Git for Windows PortableGit，仅在 provider=hermes 的 ACP
子进程中使用；不需要另装 Git、修改 PATH 或手动配置 Bash。Pylon 启动 Hermes
前会自动检查运行时，遇到 Bash/环境卡死时会在短时间内取消并重启该 Hermes
进程，不会影响其他 Agent。
运行时位于 resources\runtime\git\，请勿从发行包中删除或只保留 bash.exe；
它依赖同目录的 MSYS/DLL、命令和配置文件。源码构建时由
scripts\prepare_hermes_runtime.py 按固定 SHA-256 准备。
如需调整 Hermes 内部并发工具批次的兜底秒数，可在该 Agent 的 `env` 中设置
`HERMES_CONCURRENT_TOOL_TIMEOUT_S`；未设置时为 30，且只作用于 Hermes 子进程。

如果使用的 Hermes 版本尚未包含 ACP Bash 探针修复，可运行
`tools\repair-hermes-acp.bat`，按菜单选择“检查”或“修复”。修复只针对可访问的
Hermes 源码 `tools\environments\local.py`，会先生成时间戳备份；编译版 hermes.exe
无法由该脚本直接修改，请升级到包含 Hermes 提交 `8f956812c` 的版本。脚本也支持
命令行 `-Check`、`-Repair`、`-Restore` 以及 `-HermesRoot <源码目录>`。

【数据目录】
本包为便携模式：所有数据（会话、插件、MCP、宠物等）保存在本目录 data\ 下。
删除 portable.flag 并移走 data\ 目录后启动，将回到系统 AppData 目录。

【安装包】
如果你需要安装版（NSIS/MSI），请使用 `npx tauri build --bundles nsis,msi`，
WebView2 会由安装器自动下载引导。
