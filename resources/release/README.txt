Pylon 便携版（portable）
========================

【首次运行前请先看这里】
如果双击 pylon.exe 无窗口、闪退，或系统提示缺少 WebView2 Runtime，
请先运行本目录下 tools\install-webview2.bat（需要联网），完成后重新双击 pylon.exe。

【配置 Agent】
首次启动是干净的「零 Agent」空态，不需要事先准备任何配置文件，两条路都可以：
1. 让 Pylon 自己找：打开 设置 → Agent，「发现的运行时」会扫描本机已知 Agent，
   在结果里 验证 → 导入 即可。
2. 自己填：点「新建 Agent」填 id / 名称 / exe 绝对路径（或命令名）创建，
   创建后用卡片上的「测试连接」验证是否能真正启动。

也可以用 YAML 预置（高级，可选）：包内自带 agents.yaml（与 pylon.exe 同目录），
默认是零 Agent 的空模板。直接用文本编辑器打开它，按其中注释填写你的 Agent
（exe 用绝对路径），保存后重启 Pylon 生效；不需要复制改名，删除它也不影响启动。

【插件 SDK（离线开发）】
发行包内的 resources\sdk\ 是不依赖 Node 或源码的离线 SDK：
1. 将 resources\sdk\pylon-plugin-sdk.js 复制到插件目录；
2. 用同目录的 pylon-plugin-manifest.schema.json 校验 pylon-plugin.json；
3. 在纯 JS ESM 入口中相对导入 ./pylon-plugin-sdk.js，然后从 设置 → 插件 安装目录。
离线 SDK 只包含浏览器 runtime 和 manifest schema；需要 TypeScript、类型声明或
createMockContext 测试基建时，请使用插件开发套件中的 sdk\ 正常版包。

【Hermes（Windows）】
默认发行包不携带 Git 运行时：Hermes 依赖本机探测校验过的系统 Git Bash。
Pylon 按以下顺序解析 Bash：
1. 环境变量 PYLON_HERMES_RUNTIME_DIR（开发/覆盖用）；
2. 包内 resources\runtime\git\（仅 --with-runtime 构建的包存在，普通包没有此目录；
   该运行时由源码侧 scripts\prepare_hermes_runtime.py 按固定 SHA-256 准备）；
3. 环境变量 HERMES_GIT_BASH_PATH（可在 agents.yaml 该 Agent 的 env 中设置）；
4. 本机系统 Git Bash（自动探测并校验完整性：不盲信 PATH，会拒绝 WSL 的
   bash.exe 与残缺安装）。
本机未安装 Git for Windows 时，Hermes 无法解析 Bash；请先安装 Git for Windows
（标准路径即可，Pylon 不会改写系统 PATH，也不影响其他 Agent）。
Pylon 启动 Hermes 前会自动检查运行时，遇到 Bash/环境卡死时会在短时间内取消并重启
该 Hermes 进程，不会影响其他 Agent。

如需调整 Hermes 内部并发工具批次的兜底秒数，可在该 Agent 的 `env` 中设置
`HERMES_CONCURRENT_TOOL_TIMEOUT_S`；未设置时为 30，且只作用于 Hermes 子进程。

【数据目录】
本包为便携模式：所有数据（会话、插件、MCP、宠物等）保存在本目录 data\ 下。
删除 portable.flag 并移走 data\ 目录后启动，将回到系统 AppData 目录。

【安装包】
如果你需要安装版（NSIS/MSI），请使用 `bun run tauri -- build --bundles nsis,msi`，
WebView2 会由安装器自动下载引导。
