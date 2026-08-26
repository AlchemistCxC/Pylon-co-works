# Pylon

Pylon 是一个基于 ACP（Agent Client Protocol）的桌面 Agent 工作台。它负责连接本地 Agent、管理会话和工作区，并把消息、思考、工具调用、文件和权限请求组织在同一个界面中。Pylon 不包含模型，也不绑定某一家 Agent；只要 Agent 能通过 ACP 接入，就可以使用同一套工作台。

本文是当前版本的使用与开发说明。实现地图和扩展契约见 [`docs/`](docs/)，内部施工资料已移到 `G:\Project\prism-team-workdir\Docs\prism-desktop-internal`。

## 1. 能做什么

- 通过 ACP 连接本地 Agent runtime，并保留每个 Agent 的独立会话。
- 按工作区绑定项目目录、技能、Hook 和 MCP 配置。
- 在消息流中查看用户消息、助手回复、可折叠的思考块、工具输入/输出、差异和运行状态。
- 使用文件工作台浏览、搜索、编辑和查看 Git 工作区。
- 通过设置页调整界面模式、呈现预设、字体、颜色、指示器、布局和 Agent 配置。
- 通过插件增加命令、工具、Hook、渲染器、设置项和工作区贡献。
- 使用 Gateway/CLI 将部分控制能力暴露给本机脚本或消息平台。

## 2. 使用前准备

### 2.1 已发布版本

解压便携版后直接运行 Pylon。首次使用需要在 Agent 设置中填写可执行文件、参数和工作目录；配置会保存在应用用户数据目录，不会写入项目仓库。

### 2.2 从源码运行

需要 Node.js（建议 LTS）、Rust stable、Tauri 2 依赖和 Windows WebView2。安装依赖：

```bash
npm install
```

启动前端浏览器预览（不连接真实 Agent）：

```bash
npm run dev
```

启动 Tauri 开发应用：

```bash
npm run tauri dev
```

浏览器预览使用内置 mock 消息，适合检查终端风格、消息间距、工具卡和响应式布局；它不会模拟真实 ACP 生命周期。

## 3. 第一次使用

1. 打开“设置 → Agent”，新增或编辑 Agent runtime。填写启动命令、参数和必要的环境变量。
2. 在左栏选择 Agent。聊天模式可以直接新建会话；工作区模式先选择一个工作区，再输入首条请求。
3. 点击“开始新会话”。Pylon 会先创建本地会话，再向 Agent 建立 ACP session；首条请求发送失败时会回滚新建的会话。
4. 发送消息后，消息流会显示回复和工具活动。工具输出默认折叠，点击工具行可展开；长输出会限制在独立滚动区域内。
5. 需要查看项目文件时，打开文件工作台。文件工作台使用当前会话的工作目录，不会自动切换到其他会话的目录。

空态创建入口的行为：聊天模式不要求工作区；工作区模式没有可用工作区时提交按钮保持禁用，选择工作区后才允许创建。创建成功会自动选中新会话并发送首条请求。

## 4. 工作区、会话与数据

### 工作区

工作区是项目上下文的持久化实体，包含根路径以及技能、Hook、MCP 等关联。删除工作区不会删除磁盘上的项目文件；它只解除 Pylon 的上下文绑定。

### 会话

会话属于某个 Agent Profile，并记录远端 ACP session 的映射。切换会话时，Pylon 会先加载 canonical 历史，再接收实时事件；切回过程中不会把旧会话的消息或工具状态混入当前会话。

### 持久化

配置、Profile、工作区、会话索引和 canonical transcript 分开保存。Tauri 模式由 Rust/SQLite 与前端存储协同完成；浏览器模式使用 localStorage 作为演示存储。导出/导入配置请使用设置页提供的功能，不要手工改写存储文件。

## 5. 消息流怎么读

- 用户行表示发送到当前会话的请求。
- 思考行是 Agent 的 reasoning 片段，可展开查看；被协议或服务端隐藏时只显示隐藏原因。
- 助手行支持 Markdown、代码高亮、表格、链接和复制。
- 工具行显示工具名称、状态和摘要；成功、运行、失败和取消使用不同的状态指示器。
- 连续工具调用之间的连接线表示同一轮活动，不代表新的消息或额外请求。
- 底部生成状态显示当前阶段、耗时和 token 统计；点击停止只取消当前生成，不删除已落盘历史。

## 6. 外观与界面模式

Pylon 当前提供终端风格和现代 GUI 等界面模式。聊天的语义结构由同一套消息契约提供，预设只改变字体、间距、颜色、指示器和表面表现。终端风格下，消息块共用固定左侧指示列，助手标记、思考块和工具标记保持同一条基线。

设置修改即时生效，并按 Profile 保存。恢复默认值只影响当前设置范围；插件贡献的设置项由贡献者声明，宿主负责展示和持久化。

## 7. 插件

插件是本地目录中的受信任代码包。插件可以贡献：

- 命令、CLI 子命令和快捷操作；
- Agent 适配器、会话创建 Hook、工具和 MCP 配置；
- 消息/内容渲染器、呈现预设、主题字段和设置页；
- 工作区 Sheet、左栏/右栏面板、文件操作和 Gateway 路由。

插件启用、停用、重新加载和卸载都在“设置 → 插件”完成。插件运行在宿主授予的 Scope 中；它们可以执行本机代码，因此只安装来源可信的插件。安装失败或激活异常时，Pylon 会保留已保存配置并进入降级/安全模式，而不是静默删除设置。

用户向导：[Pylon-插件系统说明书-用户版](docs/Pylon-插件系统说明书-用户版.md)

开发者契约：[Pylon-插件系统说明书-开发者版](docs/Pylon-插件系统说明书-开发者版.md)

## 8. CLI 与 Gateway

CLI 通过本机 IPC 控制已运行的 Pylon 实例，可查询状态、切换会话、修改呈现设置、打开 Sheet 或触发插件命令。完整命令表见 [Pylon-CLI-命令表](docs/Pylon-CLI-命令表.md)。

Gateway 是可选的消息转发层：外部平台的消息进入 Gateway 后映射到 ACP session，Agent 回复再由 Gateway 转回平台。Gateway 不会绕过会话权限或 Agent runtime 的配置。

## 9. 故障排查

### Agent 无法启动

检查 Agent 可执行文件、参数、工作目录和权限；在“运行监控”查看启动 stderr。先用同样的命令在终端直接启动，确认 Agent 本身能运行。

### 会话恢复失败

保留当前会话，不要重复创建同名会话。先点击“重试恢复”；仍失败时可创建分叉会话。canonical 历史会保留在本地，恢复失败不会清空消息。

### 插件更新后仍显示旧版本

在插件页执行重新加载；若仍未更新，完全退出 Pylon 后再启动。开发时请递增插件的 cachebuster/版本号，避免 WebView 缓存旧 bundle。

### 界面样式异常

确认当前 Profile 和界面模式，使用设置页恢复对应呈现预设；浏览器预览与 Tauri 生产环境的数据和字体可能不同，最终以 Tauri 窗口为准。

## 10. 开发、测试与构建

常用命令：

```bash
npm run lint                 # ESLint
npm test                     # Vitest 全量
npm run test:frontend       # 前端测试入口
npm run build               # TypeScript + Vite 构建
npm run check:frontend      # lint、覆盖率、构建与生产排除检查
npm run check:solid         # Solid 工作台边界与契约检查
npm run check:rust          # Rust 单元测试与构建
npm run check:all           # 前端、Rust、Solid 全量检查
npm run release:portable    # 构建 Tauri 便携版
```

按区域运行测试：

```bash
npx vitest run src/components/chat
npx vitest run src/sheets/agent-workbench
npx vitest run src/domains/theme
```

提交前至少运行 `npm run lint`、相关区域测试和 `npm run build`。改动渲染器时再运行 `npm run check:solid`；改动 Rust/Tauri 时再运行 `npm run check:rust`。

## 11. 代码地图

```text
src/main.tsx                         应用入口与 bootstrap
src/App.tsx                          产品壳、Sheet、生命周期
src/domains/                         领域模型与状态同步
src/application/transactions/        跨领域应用事务
src/components/chat/                 React 消息流、ACP 事件与会话生命周期
src/renderers/solid-workbench/       Solid 工作台与消息内容实现
src/sheets/agent-workbench/          Renderer Suite 宿主与 Agent 工作台接线
src/plugins/product/                 第一方插件、样式和注册表
src/plugins/core/                    第一方插件使用的实现模块
src-tauri/                           Rust Kernel、IPC、SQLite 与进程管理
shared/                              前后端共享协议和类型
```

当前架构事实、数据流和测试入口见 [Pylon-项目架构参考](docs/Pylon-项目架构参考.md)；插件化拓扑见 [Pylon-插件化前后端拓扑全图](docs/Pylon-插件化前后端拓扑全图.md)。

## 12. 当前边界

- Pylon 依赖外部 Agent；没有可用 ACP Agent 时只能使用浏览器 mock 或查看已有本地历史。
- 多 Agent 配置与切换已支持，但同时并行运行、跨 Agent 协作仍取决于各适配器和插件能力。
- reasoning 是否可见由 Agent/协议决定，Pylon 不会把隐藏的思考内容“还原”出来。
- 插件是受信任本机代码，不提供对任意插件的强隔离沙箱。
- Gateway、MCP、媒体和部分高级交互属于可选能力，是否出现取决于 Agent 和已启用插件。

## 13. 文档索引

- [CLI 命令表](docs/Pylon-CLI-命令表.md)
- [Agent 检测器](docs/Pylon-Agent-检测器.md)
- [插件用户手册](docs/Pylon-插件系统说明书-用户版.md)
- [插件开发者手册](docs/Pylon-插件系统说明书-开发者版.md)
- [插件设置选项贡献](docs/Pylon-插件设置选项贡献.md)
- [项目架构参考](docs/Pylon-项目架构参考.md)
- [插件化拓扑全图](docs/Pylon-插件化前后端拓扑全图.md)
- [发行包内容记录](docs/releases/RELEASES.md)

## License

见 [LICENSE](LICENSE)。
