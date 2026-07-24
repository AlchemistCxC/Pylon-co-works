REVIEW-v3 — V3 状态栏重构 + 功能接线
══════════════════════════════════════════════

5 commits, 8 files, +564/-28. 整体方向正确，细节有几处遗漏。

──────────────────────────────────────────
✅ 正确实现
──────────────────────────────────────────

ECG 行为重构
  ✅ cut = W × (1-used) — 端点左移，左侧剩余彩色、右侧消耗灰色
  ✅ linearGradient 单根基线 cut 处断色
  ✅ 5 层 SVG：渐变基线 → 波形(clipPath) → 左定 → 右定 → 动
  ✅ 端点参数：定 ±8px(2.5) 动 ±10px(3)
  ✅ 基线 strokeWidth=3
  ✅ 颜色阈值 50%绿 / 80%黄 / 红
  ✅ ampMax/speedMax 从 store 可调
  ✅ tokenDisplay='numeric' 时隐藏 SVG

onCompact/onPrismToggle 接线
  ✅ App.tsx 传入 onCompact → 调 send_message('/compact')
  ✅ App.tsx 传入 onPrismToggle → 切换 livePrismOn

available_commands_update
  ✅ ChatView.tsx 新 case，存入 store.liveCommands
  ✅ InputBar 从 store 读动态命令，fallback 到硬编码 FALLBACK_COMMANDS
  ✅ /export 命令调 export_session

Sidebar 收起
  ✅ CSS .collapsed → width:48px，隐藏搜索/列表/非活跃头像

TypeScript 类型修补
  ✅ 最后一个 commit 修了 implicit any

──────────────────────────────────────────
🔴 必须修
──────────────────────────────────────────

R1. W 宽度未改

  StatusBar.tsx L84: `const W = 240` 仍是旧值。设计书指定默认 150px。
  改为 `const W = useStore(s => s.ekgWidth) || 150` 或者直接用 props 传入。
  同时 store.ts DEFAULTS 中 ekgWidth: 240 → 150。

R2. Settings UI 未更新

  新增了 7 个 EKG 字段到 store（ekgLineWidth/AmplitudeMax/SpeedBase/SpeedMax/
  LeftColor/MovingColor/ConsumedColor/tokenDisplay），但 Settings.tsx 没有对
  应的 UI 控件。用户在设置面板看不到这些选项。

  需在 Settings.tsx → status section 新增两个 Group：
  - "心电图样式"（EkG Line Width / Amplitude Max / Speed Base / Speed Max）
  - "上下文显示"（tokenDisplay: ekg / numeric）

  App.tsx cssVars 也缺这 7 个字段的映射。

──────────────────────────────────────────
🟡 建议修
──────────────────────────────────────────

S1. list_agents / switch_agent 未接入

  设计书 P1 列了这两项。Store 有 activeAgent 字段，但 StatusBar 的 agent
  指示器和切换 UI 没做。现在 StatusBar 仍显示硬编码模型列表。

S2. `as any` 类型规避

  InputBar.tsx L27: `(s as any).liveCommands`
  store.ts 的 ThemeState 接口里 liveCommands 字段没有显式声明类型。
  应加 `liveCommands: { name: string; input_hint?: string; description?: string }[]`

S3. debug log 保留

  ChatView.tsx L153: `console.log('[P0-1 DEBUG usage_update]', ...)`
  调试日志不应留在生产代码里。删掉或加 `if (import.meta.env.DEV)` 守卫。

S4. /clear 仍无 listener

  InputBar.tsx L73 dispatch CustomEvent('peri:clear') 但 ChatView 没有
  addEventListener 监听。清屏不会生效。

S5. ekgWidth range 未更新

  Settings.tsx 心电图宽度 range 120–400，但默认改 150 后，min 建议改到 80。

──────────────────────────────────────────
改动量
──────────────────────────────────────────

  StatusBar.tsx   +60/-28   ECG 重构核心
  App.tsx         +13       onCompact/onPrismToggle
  ChatView.tsx    +6        usage_update debug + available_commands
  InputBar.tsx    +19/-?    动态命令 + /export
  Sidebar.css     +7        收起样式
  store.ts        +6/-?     EKG 字段 + liveCommands
