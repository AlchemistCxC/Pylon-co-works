# Pylon — ACP 通用 GUI 客户端

Pylon 是 [ACP（Agent Communication Protocol）](https://agentclientprotocol.com) 协议的桌面参考 GUI 实现。基于 Tauri v2 + React 19 + Rust，通过 stdin/stdout JSON-RPC 2.0 连接任意 ACP 兼容 agent——不绑定特定后端，Peri、Hermes 或任何符合 ACP 的 agent 均可接入。

```
GUI (Pylon) → spawn agent → initialize
            → session/new → sessionId
            → session/prompt → streaming session/update notifications
            → session/close
```

---

## 特性

### 协议与可靠性
- **ACP 官方 schema 类型化**（`agent-client-protocol-schema` v1.4，v1+v2 类型全集），消除手写参数构造；MCP stdio/http 双模式，Hermes 差异适配
- **崩溃自动重连**：指数退避 5 次（2s→32s，~62s 后放弃），防重入；自动重连保留会话映射 + generation 迁移，崩溃前会话可续聊
- **Session Inspector**：`session_inspector` 一站式聚合 agent 状态、会话统计（tokens/活跃数）与明细
- **会话路由隔离**：通知按 client_generation 路由，stale 会话与旧客户端事件拒绝，无双写歧义

### 会话与聊天
- 多会话并行，按平台分组（本地 / QQ 群聊 / QQ 私聊 / 终端）
- Agent 回复实时流式渲染；思考块（reasoning）折叠/展开
- 工具调用卡片：状态指示、竖线连接、输入/输出预览
- 代码块 starry-night 语法高亮 + `│` gutter（对齐 Peri TUI）；Bash 输出 ANSI 渲染
- 会话持久化，重启自动恢复

### 中控区（Control Center）
- 自由拖拽/缩放 widget 画布，8 个独立控件
- 输入栏：默认文本框 + CLI `❯` 双线模式
- 用量仪表：ECG 波形 / 柱状条 / 百分比 / Token 数
- 模型选择器、权限模式（bypass / auto / edit / default）

### 主题系统
- CSS 变量驱动，明暗双模，三套全局预设，五区独立（global / sidebar / chat / cc / right）
- **Claude 风格** — 暗色 mono CLI，铜金 `#D77757` 终端美学
- **Glass Light** — 高透毛玻璃，靛蓝 `#6366f1` 轻透风
- **Nord Frost** — Nord 极光冷色，冰蓝 `#88c0d0` 终端风

### 终端宠物
- 像素生物五阶进化：微光种 → 初生体 → 漫游体 → 陪伴体 → 长明体（token 量 + 工具成功率双轴成长）
- 七情绪渲染：idle / curious / focused / excited / happy / error / sleepy
- 事件感知：发送 / 首 token / 完成 / 失败 / 工具调用 / 戳 / 喂 / 自动入睡 / Agent 连接 / 崩溃
- 记忆里程碑 + `nostalgia` 回忆气泡；状态落盘跨重启不丢
- 前端行为：自由拖拽固定、双击恢复漫游、嗅/吃代码、平板敲码

### Prism 集成
- Prism 上下文注入引擎网关，40 个命令：场景 / 源 / 块 CRUD、注入、Chronicle 历史、LLM 测试

---

## 快速开始

### 前置条件

| 依赖 | 说明 |
|:--|:--|
| Rust | stable-x86_64-pc-windows-gnu 工具链（需 `windres`，MinGW binutils 提供） |
| Node.js | 18+ |
| WebView2 | Windows 10+ 自带，Win7 需手动安装 |
| Agent | 任一 ACP 兼容 agent（如 Peri、Hermes），在 `agents.yaml` 注册 |

### 构建

```bash
# 前端类型检查 + 打包
npm run build          # tsc -b && vite build

# 后端类型检查 + 测试
cd src-tauri && cargo check && cargo test --lib

# 完整打包（前端 + 后端 → exe）
npx tauri build
```

输出：`src-tauri/target/release/pylon.exe`（需分发 `WebView2Loader.dll`、`resources/fonts/`）。

### 开发模式

```bash
npm run dev            # Vite HMR 开发服务器（仅前端，无 Tauri 后端）
```

浏览器预览展示 mock 数据，供样式调试。

---

## 配置 Agent

编辑根目录 `agents.yaml`，支持任意 ACP 兼容 agent：

```yaml
agents:
  peri:
    name: Peri
    transport: subprocess
    exe: F:\A-I\Agent\Peri\target\release\peri.exe
    args: ["acp", "--model", "deepseek-v4-flash"]
    cwd: G:\Project\prism
    env:                        # 可选：注入环境变量
      API_KEY: "sk-xxx"

  hermes:
    name: Hermes
    transport: subprocess
    exe: hermes
    args: ["acp"]
    cwd: .
    default: true               # 设为默认 agent
```

| 字段 | 说明 |
|:--|:--|
| `transport` | 当前仅支持 `subprocess`（stdin/stdout 子进程） |
| `exe` | agent 可执行文件路径（PATH 搜索或绝对路径） |
| `args` | 命令行参数 |
| `cwd` | 工作目录 |
| `env` | 注入环境变量（可选） |

---

## 架构

### 运行时

```
┌─────────────────────────────────────────────────────┐
│ Tauri v2 (Rust, tokio)                              │
│  ┌─────────────┐  ┌──────────────────────────────┐  │
│  │ AcpClient   │  │ 通知 dispatcher              │  │
│  │  spawn      │  │  · generation 路由           │  │
│  │  JSON-RPC   │→ │  · session 映射解析          │  │
│  │  fake 测试  │  │  · 崩溃检测 + 自动重连       │  │
│  └─────────────┘  └──────────────────────────────┘  │
│  · SessionInfo 映射   · MCP 配置   · Prism 网关     │
│  · 宠物状态机          · 运行时日志 · Workspace      │
└───────────────┬─────────────────────────────────────┘
                │ IPC（Tauri commands / events）
┌───────────────┴─────────────────────────────────────┐
│ React 19 + Zustand                                  │
│  ChatView · ControlCenter · Sidebar · RightPanel    │
│  PrismSheet · PetCompanion · workspace-sheets       │
└─────────────────────────────────────────────────────┘
```

### 可靠性设计

- **generation 机制**：每次客户端替换（switch/reconnect/自动重连）`client_generation` +1；dispatcher 与 session 映射均按代际匹配，旧客户端事件自动拒绝
- **自动重连**：崩溃 → 指数退避重试（最多 5 次）→ `keep_sessions=true` 替换客户端并迁移 generation；手动 switch/reconnect 保持清空语义
- **锁外 RPC**：prompt 发送与等待在锁外执行，Peri 卡顿不阻塞其他命令

---

## 项目结构

```
pylon/
├── src/                       # React 前端
│   ├── main.tsx / App.tsx     # 入口 + CSS 变量注入
│   ├── store.ts               # Zustand store（Sessions + ThemeSettings + persist）
│   ├── presets.ts             # 主题预设 + 五区字段映射
│   ├── components/
│   │   ├── chat/              # 聊天区：消息渲染管线、InputBar、工具卡片等
│   │   ├── ControlCenter.tsx  # 中控区 widget 画布 + PropertyPanel
│   │   ├── Sidebar.tsx        # 会话列表
│   │   ├── Settings.tsx       # 设置面板（实时预览）
│   │   ├── RightPanel.tsx     # 右侧面板
│   │   ├── PrismSheet.tsx     # Prism 管理面板
│   │   ├── PetCompanion.tsx   # 终端宠物（含 petBehavior/petMotion/petPersistence）
│   │   └── ...                # ProfileEditor、ErrorBoundary 等
│   ├── workspace-sheets/      # Workspace Sheet 组件
│   └── index.css              # 全局样式 + CSS 变量
│
├── src-tauri/                 # Rust 后端
│   ├── src/
│   │   ├── lib.rs             # Tauri commands、通知 dispatcher、自动重连、Session Inspector
│   │   ├── acp.rs             # AcpClient：spawn agent + JSON-RPC（官方 schema + fake 测试基建）
│   │   ├── agent_config.rs    # agents.yaml 解析
│   │   ├── agent_runtime.rs   # 生命周期状态 + 重连退避常量
│   │   ├── mcp.rs             # MCP 配置校验/序列化
│   │   ├── pet.rs             # 宠物适配层 + 落盘持久化
│   │   ├── prism.rs           # Prism 网关客户端
│   │   ├── runtime_log.rs     # 运行时日志中心
│   │   ├── workspace.rs       # 工作区只读接口
│   │   └── error.rs           # PylonError
│   ├── pet-core/              # 宠物状态机独立 crate（事件驱动 + 单测）
│   ├── build.rs               # windres 注入 comctl32 v6 manifest
│   └── resources/fonts/       # Iosevka 等宽字体
│
├── agents.yaml                # Agent 注册配置
└── docs/
    ├── 后端开发与交接手册.md    # Tauri command/事件契约、验证清单
    ├── 前端开发与交接手册.md
    └── Workspace Sheet与右栏设计书（前端）.md
```

---

## 开发与测试

- **测试**：后端 78+ 单元/集成测试（`cargo test --lib`），含 fake ACP 子进程、tauri mock window 崩溃重连集成测试；宠物核心独立 crate 8 测试
- **验收铁律**：一条一 commit、cargo check 通过再 commit、不提前 build、不跳级
- **契约文档**：Tauri command、事件 payload 与 ACP 映射见 `docs/后端开发与交接手册.md`

## License

MIT
