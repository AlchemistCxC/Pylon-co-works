REVIEW-v6 — V6 全部
══════════════

2 commits, 10 files, +115/-20。工作区仅 REVIEW-v6.md 和 gen/schemas/capabilities.json dirty。

✅ 已实现

P0-1: 窗口权限, 上下文丢失修复, chat header 友好名
P0-2: Session 接口扩展 (platform/workdir/sessionPrompt/skills/hooks/autoName),
       PLATFORM_LABELS 分组, 跨 agent compat
P1:   推理块缩进, 侧栏动画, StatusBar 精简 (去 agent/Prism)

🟢 gen/schemas/capabilities.json 需 commit

───

🔔 项目改名: Pylon

  含义: 输电塔——消息从中流过，不生产只传递。
  ACP 通用终端，Prism 面板是附带。

  需改:
  - tauri.conf.json: "productName" → "Pylon"
  - Cargo.toml: name → "pylon"
  - package.json: name → "pylon"
  - index.html: <title> → "Pylon"
  - lib.rs set_title: "Prism Desktop" → "Pylon"

  图标: 菱形 ◇。icons/icon.ico 换掉。简单几何，象征输电塔/信号。