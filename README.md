# Pylon — ACP 通用 GUI 客户端

ACP（Agent Communication Protocol）协议的桌面 GUI 实现。基于 Tauri v2 + React 19，通过 stdin/stdout JSON-RPC 连接任意 ACP 兼容 agent——不绑定特定后端，Peri、Hermes 或任何符合 [ACP 规范](ACP-SPEC.md) 的 agent 均可接入。

## 设计理念

Pylon 是 ACP 协议的**参考 GUI 实现**。它不定义 agent 行为，只提供标准化的对话界面：

- **协议优先** — 所有交互通过 ACP 命令/通知完成，GUI 本身无 AI 逻辑
- **Agent 无关** — `agents.yaml` 注册任意 agent，键值切换
- **纯终端体验** — Peri 风格 CLI 输入、代码块 `│` gutter、ECG 用量仪表

## 功能

### 会话管理
- 多会话并行，按平台分组（本地 / QQ 群聊 / QQ 私聊 / 终端）
- 会话重命名、搜索、删除，消息持久化到 localStorage
- 重启后历史会话自动恢复

### 聊天区
- Agent 回复实时流式渲染
- 思考块（reasoning）折叠/展开
- 工具调用卡片：指示器颜色、竖线连接、辉光、输入/输出预览
- 代码块 starry-night 语法高亮 + `│` gutter（对齐 Peri TUI）
- Bash 输出 ANSI 转义渲染
- ReactMarkdown 完整支持：列表、表格、引用、链接

### 中控区（Control Center）
- 自由拖拽/缩放的 widget 画布，8 个独立控件
- 输入栏：默认文本框 + CLI `❯` 双线模式
- 用量仪表：ECG 波形 / 柱状条 / 百分比 / Token 数
- 模型选择器：下拉 / 极简 / 徽章三变体
- 权限模式：bypass / auto / edit / default，颜色区分
- 编辑模式：自由布局 + PropertyPanel 属性编辑

### 主题系统
- CSS 变量驱动，`.app[data-ui-scheme]` 明暗双模
- 三套全局预设，五区独立（global / sidebar / chat / cc / right）
  - **Claude 风格** — 暗色 mono CLI，铜金 `#D77757` 终端美学
  - **Glass Light** — 高透毛玻璃，靛蓝 `#6366f1` 轻透风
  - **Nord Frost** — Nord 极光冷色，冰蓝 `#88c0d0` 终端风
- 设置面板实时预览，改即所见

### 终端宠物
- ASCII 螃蟹豆豆，idle / curious / excited / sleepy / error / happy 六情绪
- 双轴成长（token 量 + 工具成功数），四阶进化
- 中文气泡：发送 / 首 token / 完成 / 错误 / 戳 / 喂 / 深夜 / 回忆

## 技术栈

| 层 | 技术 |
|:--|:--|
| 框架 | Tauri v2 |
| 前端 | React 19 + TypeScript + Zustand（persist 中间件） + Vite |
| 后端 | Rust（stable-x86_64-pc-windows-gnu，tokio 异步运行时） |
| 协议 | ACP — stdin/stdout JSON-RPC 2.0，详见 [ACP-SPEC.md](ACP-SPEC.md) |
| 样式 | 纯 CSS（500+ CSS 变量），无 Tailwind |
| UI 库 | Radix UI（dialog / dropdown-menu / tabs / tooltip） |
| Markdown | react-markdown + remark-gfm + starry-night + Anser（ANSI） |
| 字体 | JetBrains Mono（npm @fontsource，打包嵌入） |

## 构建

### 前置条件

- Rust stable-x86_64-pc-windows-gnu（需 `windres`，MinGW binutils 提供）
- Node.js 18+
- WebView2 运行时（Windows 10+ 自带，Win7 需手动安装）

### 构建命令

```bash
# 安装依赖
npm install

# 前端类型检查 + 打包
npm run build        # tsc -b && vite build

# 后端类型检查
cd src-tauri && cargo check

# 完整打包（前端 + 后端 → exe）
npx tauri build
```

输出：`src-tauri/target/release/pylon.exe`
同时需要分发：`WebView2Loader.dll`、`resources/fonts/`

### 开发模式

```bash
npm run dev          # Vite HMR 开发服务器（仅前端，无 Tauri 后端）
```

浏览器预览会展示 mock 数据，供样式调试用。

## 项目结构

```
pylon/
├── src/                       # React 前端
│   ├── main.tsx               # 入口
│   ├── App.tsx                # 根组件 + CSS 变量注入
│   ├── store.ts               # Zustand store（ThemeSettings + Sessions + persist）
│   ├── presets.ts             # 全局预设定义 + 五区字段映射
│   │
│   ├── components/
│   │   ├── chat/
│   │   │   ├── ChatView.tsx   # 消息渲染 + ACP 事件监听
│   │   │   ├── InputBar.tsx   # 输入栏：默认 / CLI 模式 + 命令面板
│   │   │   ├── MessageBubble.tsx  # 消息气泡（备用风格）
│   │   │   ├── ModelWidget.tsx    # 模型选择器
│   │   │   ├── ModeWidget.tsx     # 权限模式切换
│   │   │   ├── SendWidget.tsx     # 独立发送按钮
│   │   │   └── AttachWidget.tsx   # 独立附件按钮
│   │   │
│   │   ├── ControlCenter.tsx  # 中控区 widget 画布 + PropertyPanel
│   │   ├── Sidebar.tsx        # 会话列表
│   │   ├── Settings.tsx       # 设置面板（含实时预览）
│   │   ├── RightPanel.tsx     # 右侧面板
│   │   ├── PrismSheet.tsx     # Prism 管理面板
│   │   ├── ProfileEditor.tsx  # Profile 编辑
│   │   ├── SessionSettings.tsx # 会话参数编辑
│   │   ├── ColorPopover.tsx   # 取色器组件
│   │   └── ErrorBoundary.tsx  # 出错降级
│   │
│   ├── index.css              # 全局样式 + CSS 变量定义
│   └── utils.ts               # 工具函数（时间格式化）
│
├── src-tauri/                 # Rust 后端
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── src/
│   │   ├── main.rs            # 入口
│   │   ├── lib.rs             # Tauri commands（17 个）
│   │   ├── acp.rs             # AcpClient：spawn agent + JSON-RPC
│   │   ├── agent_config.rs    # agents.yaml 解析
│   │   ├── error.rs           # PylonError 结构化错误
│   │   └── pet.rs             # 终端宠物状态机
│   └── resources/fonts/       # Iosevka 等宽字体（嵌入）
│
├── agents.yaml                # Agent 注册配置
├── ACP-SPEC.md                # ACP 协议规范
└── docs/
    └── api-reference.md       # 前后端 API 参考
```

## 配置 Agent

编辑 `agents.yaml`，支持任意 ACP 兼容 agent：

```yaml
agents:
  peri:
    name: Peri
    transport: subprocess
    exe: F:\A-I\Agent\Peri\target\release\peri.exe
    args: ["acp", "--model", "deepseek-v4-flash"]
    cwd: G:\Project\prism
    env:                          # 可选：注入环境变量
      API_KEY: "sk-xxx"

  hermes:
    name: Hermes
    transport: subprocess
    exe: hermes
    args: ["acp"]
    cwd: .
    default: true                 # 设为默认 agent
```

- `transport` — 当前仅支持 `subprocess`（stdin/stdout 子进程）
- `exe` — agent 可执行文件路径（PATH 搜索或绝对路径）
- `args` — 命令行参数
- `cwd` — 工作目录
- `env` — 注入环境变量

## ACP 协议

Pylon 实现了 ACP 协议的 GUI 端。协议细节见 [ACP-SPEC.md](ACP-SPEC.md)。

核心流程：
```
GUI (Pylon)  →   spawn agent  →  initialize
              →   session/new  →  sessionId
              →   session/prompt  →  streaming session/update notifications
              →   session/close
```

## 协作

[`docs/api-reference.md`](docs/api-reference.md) 记录了前后端接口契约，包括所有 Tauri command 的参数/返回值、事件 payload 结构、Session 数据结构。

## License

MIT
