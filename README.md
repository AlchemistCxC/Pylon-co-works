# Pylon — ACP 通用聊天终端

基于 Tauri v2 + React 19 的桌面 AI 聊天终端，通过 [ACP 协议](ACP-SPEC.md) 连接 Peri agent。

## 功能

- **ACP 协议** — stdin/stdout JSON-RPC，连接 Peri 子进程
- **多 Agent** — `agents.yaml` 配置，支持切换不同 agent
- **实时流式** — agent 回复逐 token 渲染，工具调用展开/折叠
- **CLI 模式** — `❯` 双线终端风格输入，命令面板 `/model` `/mode` `/clear` 等
- **中控区** — 可拖拽/缩放的 widget 画布，用量条/模型/模式一目了然
- **三套预设** — Claude 风格 / Glass Light / Nord Frost，一键切换主题
- **会话管理** — 分组、搜索、重命名、删除，消息持久化到 localStorage
- **终端宠物** — ASCII 螃蟹豆豆，双轴成长，事件气泡

## 技术栈

| 层 | 技术 |
|:--|:--|
| 框架 | Tauri v2 |
| 前端 | React 19 + TypeScript + Zustand + Vite |
| 后端 | Rust (stable-x86_64-pc-windows-gnu) |
| 样式 | 纯 CSS（CSS 变量驱动主题） |
| UI 库 | Radix UI（dialog / dropdown-menu / tabs） |
| Markdown | react-markdown + remark-gfm + starry-night |
| 字体 | JetBrains Mono（npm @fontsource） |

## 构建

### 前置

- Rust (GNU toolchain) + `windres`（MinGW binutils）
- Node.js 18+
- WebView2 运行时（Win10+ 自带）

### 命令

```bash
npm install
npm run build          # 前端
cargo build --release  # 后端（src-tauri/）
npx tauri build        # 打包 exe
```

输出：`src-tauri/target/release/pylon.exe`

## 项目结构

```
├── src/                  # React 前端
│   ├── components/
│   │   ├── chat/         # ChatView / InputBar / StatusBar / Widgets
│   │   ├── Settings.tsx  # 设置面板 + 实时预览
│   │   ├── ControlCenter.tsx  # 中控区 widget 画布
│   │   ├── Sidebar.tsx   # 会话列表
│   │   └── ...
│   ├── store.ts          # Zustand store
│   ├── presets.ts        # 三套全局预设
│   └── main.tsx          # 入口
├── src-tauri/            # Rust 后端
│   ├── src/
│   │   ├── lib.rs        # Tauri commands
│   │   ├── acp.rs        # ACP 客户端
│   │   ├── agent_config.rs
│   │   ├── error.rs
│   │   └── pet.rs        # 终端宠物
│   ├── Cargo.toml
│   └── tauri.conf.json
├── agents.yaml           # Agent 配置
├── ACP-SPEC.md           # ACP 协议规范
└── docs/
    └── api-reference.md  # API 参考
```

## 配置

编辑 `agents.yaml`：

```yaml
agents:
  peri:
    name: Peri
    transport: subprocess
    exe: F:\A-I\Agent\Peri\target\release\peri.exe
    args: ["acp", "--model", "deepseek-v4-flash"]
    cwd: G:\Project\prism
```

## License

MIT
