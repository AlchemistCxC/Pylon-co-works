你是宫木云的全栈开发助手，用 GPT-5.6-sol。当前项目：Pylon——ACP 通用 GUI 客户端（Tauri v2 + React 19 + Rust）。

---

## 首次任务：审计项目

**先不要改任何代码。** 做以下事情：

1. 完整阅读 `G:\Project\prism-desktop\` 下所有源代码（`.tsx` `.css` `.rs` `.yaml`），不读 md 文件
2. 整理你发现的问题，按严重程度排序：🔴 功能性 bug / 🟡 体验问题 / ⚪ 代码质量
3. 汇报给我，等我确认后再动手修

项目根目录：`G:\Project\prism-desktop`
ACP 协议以 Peri 源码为准——**ACP-SPEC.md 可能是错的，不要参考。** 直接看 Peri 源码：
- `F:\A-I\Agent\Peri\peri-tui\src\acp_stdio\` — ACP stdin/stdout 服务端（session/create、prompt、config、notification）
- `F:\A-I\Agent\Peri\peri-tui\src\acp_server\` — 请求路由 + 通知发送
- `F:\A-I\Agent\Peri\acp-hub\` — ACP hub/router
前后端 API 契约：`docs/api-reference.md`

下面是我已知的问题清单（可能不完整，你审计后补充）：

---

## 项目结构

```
G:\Project\prism-desktop\
├── src/                       # React 前端（15 TSX + 13 CSS）
│   ├── App.tsx                # 根组件 + CSS 变量注入
│   ├── store.ts               # Zustand store（ThemeSettings + Session + persist）
│   ├── presets.ts             # 三套全局预设
│   ├── components/
│   │   ├── chat/              # ChatView / InputBar / StatusBar / 各 Widget
│   │   ├── ControlCenter.tsx  # 中控区 widget 画布（557 行）
│   │   ├── Settings.tsx       # 设置面板 + 实时预览（426 行）
│   │   ├── Sidebar.tsx        # 会话列表
│   │   ├── ProfileEditor.tsx  # Profile 编辑
│   │   └── ...
│   └── index.css              # 全局 CSS 变量
├── src-tauri/                 # Rust 后端（6 源文件）
│   └── src/
│       ├── lib.rs             # Tauri commands（17 个），AppState
│       ├── acp.rs             # AcpClient：spawn agent + JSON-RPC
│       ├── agent_config.rs    # agents.yaml 解析
│       ├── error.rs           # PylonError 枚举
│       └── pet.rs             # 终端宠物
├── agents.yaml                # Agent 注册
├── docs/
│   ├── COWORK.md              # 协作协议
│   └── api-reference.md       # API 契约
└── README.md
```

---

## 当前问题

### 1. 消息发送后 session.source/id 混淆
- **文件**：`src/components/chat/InputBar.tsx` (send/cancel/全局热键)
- **现象**：`sessionId` 是 session 的 `id`（"s123abc"），但后端和 ChatView 用 `source`（"local:session-xxx"）做匹配。传错值导致事件被过滤。
- **现状**：已部分修复——InputBar 现在先查 session 再取 `s.source`。但 ChatView 的 `peri:user` 监听器在某些场景仍不触发消息渲染。

### 2. 重启后会话上下文丢失
- **文件**：`src-tauri/src/lib.rs` (load_persisted_session)，`src/components/chat/ChatView.tsx`
- **现象**：App 重启后 Peri 的 session 已消失，`session/load` 失败 → 新 session 无历史。
- **现状**：已加消息 localStorage 持久化（`pylon-msgs-${id}`），但 Peri 端重放逻辑已回退到原始空实现。

### 3. 设置面板颜色未完全生效
- **文件**：`src/App.tsx` (cssVars)
- **现象**：`spinnerColor`/`spinnerSize` 未注入 CSS 变量。已修复。但 `ccBg`/`ccBgImage` 等 CC 变量仅在 ControlCenter inline style 设置，全局 cssVars 未覆盖。

### 4. AI 回复列表偏左
- **文件**：`src/components/chat/ChatView.css`
- **现象**：ReactMarkdown 的 `<ol>/<ul>` 无左缩进。
- **现状**：已加 `.term-assistant ol/ul/li` 样式。需验证 `padding-left` 是否足够。

### 5. Spinner 字符切换时颤抖
- **文件**：`src/components/chat/ChatView.css` (`.spinner-frame`)
- **现状**：已加 `min-width + text-align:center + display:inline-block` 固定宽度。需验证在等宽/非等宽字体下是否都稳定。

---

## Commit 规范

1. **中文** commit message
2. **一个模块一个 commit**——不要混改多个文件
3. Push 前 `npm run build`（前端）或 `cargo check`（后端）必须通过
4. 直接推 `main`，不用 PR

```
✅ 好的：
feat: ProfileEditor UI重写，暗色/浅色双模式
fix: InputBar用session.source查对，send/cancel统一
chore: 清理未用 imports

❌ 坏的：
fix bugs
update
WIP
```

---

## 分工

- **宫木云**：`src-tauri/` 除 gateway 外全部 + `src/` 全部前端
- **月殇**：`src-tauri/src/gateway/`（纯新模块，外部平台接入）

不要碰月殇的文件。需要改共享文件（`lib.rs`、`agents.yaml`、`Cargo.toml`）先喊宫木云。

---

## 技术约束

- 纯 CSS，无 Tailwind
- CSS 变量驱动主题（`var(--xxx)`），不要硬编码颜色
- ACP 协议走 `acp.rs` 的 `AcpClient`，不复造 JSON-RPC
- Zustand v5：多字段 selector 必须 `useShallow`，否则无限重渲染
- Tauri API（`getCurrentWindow` 等）浏览器 dev 模式会抛异常，需 try-catch mock
- Windows GNU 工具链，编译需 `windres` 在 PATH
- `agents.yaml` 不写 API key
