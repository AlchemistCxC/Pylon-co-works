REVIEW-v7 — V7 审计
══════════════

4 commits, 12 files, +665/-81。

✅ 已实现

  ControlCenter.tsx          新组件，合并 InputBar + StatusBar
  SessionSettings.tsx        新组件，⚙ 弹窗，platform/workdir/prompt/skills/hooks
  ECG 基线 5px               双竖线定端点 + 单竖线动端点
  session-gear CSS           hover 显示
  delete clears active       切换会话时清理
  App.tsx 精简               用 ControlCenter 替代独立 InputBar+StatusBar
  pylon localStorage key     prism-sessions → pylon-sessions

❌ 未实现 / 回归

  R1. cacheHit 仍无效
      acp.rs initialize capabilities: {} 未改。
      应为 {"tokenStats": true}。一行。

  R2. 侧栏折叠仍是 48px 不是 0
      Sidebar.css .collapsed: width:48px → width:0, min-width:0

  R3. CLI 视觉风格未实现双横线 + > 前缀
      输入栏只有 default 圆角框。需加 cli 风格：双横线(::before/::after)
      + 左侧 '>' 前缀 + 等宽字体 + 透明背景。
      按钮/控件显隐由中控区开关控制，不另设 CSS。

  R4. 上下文显示变体（bar/numeric）未实现
      store 无 ekgStyle/ccStyle 字段，StatusBar 无 bar 渲染

  R5. Settings 未重组
      仍是旧的 8 分类结构，未合并为中控区/终端的 5 分类

  R6. chat header 友好名
      ChatView.tsx 仍显示 session.name（raw ID），未用 autoName fallback

🟢 小问题
  - ControlCenter.tsx L16: `as React.CSSProperties` 非空断言多余
  - SessionSettings 无 Agent 兼容性 fallback 注释
