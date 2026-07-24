REVIEW-v6 — 审计监工
═══════════════════════

基线: 28e6c59
HEAD: 852dcaf  "fix: V6 P0-1 window permissions, context loss, chat header friendly name"
工作区: src/store.ts dirty（未提交）

─────────────────────────────────────────────
一、已提交变更（1 commit，5 files，+246/-5）
─────────────────────────────────────────────

■ DESIGN-v6.md（新增，197 行）
  V6 完整设计书，分四组：
  P0 Bug 修复：窗口按钮权限、上下文丢失、聊天头部 raw ID
  P0 会话重做：Session 接口扩展（platform/workdir/sessionPrompt/skills/hooks/autoName）、platform 分组、自动命名、会话级配置
  P1 UI 精修：工具链竖线连续化、ECG 行波、思考块靠右、右面板 drag-resize 禁用、侧栏折叠优化、背景图拖拽上传+适应模式、输入栏重排、状态栏精简
  跨 Agent 兼容性条款明确

■ REVIEW-v5-final.md（新增，23 行）
  V5 终审：14 项全部完成，3 commits / 18 files / +444/-33
  备注 gen/schemas/capabilities.json 为 auto-generated dirty

■ src-tauri/capabilities/default.json
  +5 权限：
    core:window:allow-minimize
    core:window:allow-maximize
    core:window:allow-unmaximize
    core:window:allow-close
    core:window:allow-destroy

■ src-tauri/gen/schemas/capabilities.json（auto-generated）
  ⚠️ 内容回归简化版（含 allow-set-fullscreen，丢失 allow-close/minimize/maximize 等）
  与 default.json 不一致——说明未重新生成，或生成后又被旧版覆盖
  建议：commit 后重新生成并确认

■ src/components/chat/ChatView.tsx（+24/-5）
  ① 上下文丢失修复：
     旧：useEffect(() => { setMessages([]) }, [sessionId])
         → sessionId 短暂 null 会清空
     新：只在 sessionId 真实变化且非 null 时清空，追加 prevSessionRef 守卫
  ② 聊天头部友好名：
     旧：直接显示 sessionId（如 session-lxv2f）
     新：name 以 "session-" 开头 → "新会话 · 刚刚/3m ago"，否则显示 name
  ③ 新增 formatTime() 工具函数（刚刚 / Nm ago / Nh ago / Nd ago）

─────────────────────────────────────────────
二、工作区未提交变更
─────────────────────────────────────────────

■ src/store.ts（Session 接口扩展）

  Session 新增字段：
    platform: string        // 'local' | 'qq-group' | 'qq-dm' | 'terminal'
    workdir: string          // 工作目录
    sessionPrompt: string    // 会话级 system prompt
    skills: string[]         // 会话级 skill 列表
    hooks: string[]          // 会话级 hook 列表
    autoName: string         // 自动生成名称

  addSession() 初始化默认值：
    platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: ''

  状态：仅接口+初始化，尚未有消费端代码（Sidebar 分组、Settings 会话设置页等）

─────────────────────────────────────────────
三、评估
─────────────────────────────────────────────

✅ V6 P0-1 三项已修：
   窗口权限 → default.json 权限到位（但 gen schema 待同步）
   上下文丢失 → ChatView 守卫逻辑正确
   聊天头部 → 友好名逻辑正确

⚠️ 待关注：
  1. capabilities.json 与 default.json 不一致——rebuild 后可能丢失权限
  2. store.ts 的 Session 扩展未提交——占 V6 P0-2 的工作量，后续 Sidebar/Settings/ChatView 都依赖这些字段
  3. V6 P1（8 项 UI 精修）尚未开始
