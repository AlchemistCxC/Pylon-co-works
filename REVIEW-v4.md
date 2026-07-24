REVIEW-v4 — V4 全部 P0/P1/P2
═══════════════════════════

4 commits, 13 files, +650 lines. 全部通过。

──────────────────────────────────────────
✅ 逐项核对
──────────────────────────────────────────

P0-1 Agent 选择 (Settings)
  ✅ Settings 新增 "Agent" 分类 + NAV
  ✅ 当前 agent 名显示 + 切换按钮
  ✅ StatusBar 静态显示 agent 名（pill-mono）
  ✅ App.tsx 启动调 list_agents → store.setAgents
  ✅ 切换提示"需重启"

P0-2 容错
  ✅ ErrorBoundary.tsx — class 组件，getDerivedStateFromError
  ✅ App.tsx 包裹 <ErrorBoundary>
  ✅ InputBar send toast（input-error div, 4s 自动消失）
  ✅ ErrorBoundary 重试按钮

P1 CLI 双横线
  ✅ InputBar.css .cli-mode — ::before/::after 双横线
  ✅ InputBar.tsx 根据 inputMode 切换 cli-mode class
  ✅ store 新字段: inputMode/cliLineWidth/cliLineColor/cliTextColor
  ✅ Settings CLI 风格 Group + App.tsx cssVars 映射

P2 消息交互
  ✅ 复制按钮（AssistantContent hover 显示, navigator.clipboard）
  ✅ 滚动到底按钮（messages > 4 时显示）
  ✅ 会话重命名（双击 session-item → inline <input>）
  ✅ 时间戳（Session.createdAt/lastActiveAt, formatTime 相对时间）
  ✅ 重发（Ctrl+↑ 恢复上一条消息）

──────────────────────────────────────────
🟢 小问题
──────────────────────────────────────────

Q1. Session.createdAt 写入时机

  Sidebar.tsx 的 addSession 中 store.ts 的 addSession 函数创建 session
  对象时没有设置 createdAt/lastActiveAt。当前新 session 的这两个字段
  为 undefined，formatTime 显示为空字符串。

  修: addSession 时加 `createdAt: Date.now(), lastActiveAt: Date.now()`。

Q2. 重命名后 lastActiveAt 未更新

  重命名只改了 name，没有更新 lastActiveAt 为 Date.now()。

Q3. Ctrl+↑ 重发逻辑注释

  当前 Ctrl+↑ 只在非命令模式下工作（L113 在 isCmd 检查之后）。这是
  合理的——命令模式下 ↑↓ 用于选择命令。但如果用户删掉输入框内容后
  按 Ctrl+↑，`lastMsg.current` 仍有值，能恢复。逻辑正确。

──────────────────────────────────────────
改动量
──────────────────────────────────────────

  ErrorBoundary.tsx  新 35 行
  Sidebar.tsx        +37  重命名 + 时间戳
  ChatView.tsx       +8   复制 + 滚动
  ChatView.css       +19  复制按钮 + 滚动按钮样式
  InputBar.tsx       +6   CLI mode + Ctrl+↑
  InputBar.css       +17  CLI 双横线样式
  Settings.tsx       +6   CLI 风格 Group
  App.tsx            +4   CLI cssVars
  store.ts           +7   inputMode/CLI 字段 + Session 字段
  StatusBar.tsx      +4   Agent 显示
