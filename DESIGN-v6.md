# Prism Desktop V6 设计书 — 会话重做 + UI 精修

> 给 coder。15 项需求，分两组。工作流程同前。

---

## 一、Bug 修复（P0）

### 1.1 窗口按钮失效

代码正确但需验证：`minimize()` / `destroy()` 在 Tauri v2 + `decorations:false` 下权限可能不够。确认 `capabilities/default.json` 含 `core:window:allow-minimize` 和 `core:window:allow-destroy`。rebuild 后测试。

### 1.2 设置切换后上下文丢失

原因：`ChatView.tsx` L76 `useEffect(() => { setMessages([]) }, [sessionId])`。当 Settings 打开/关闭时如果组件重渲染且 `sessionId` 短暂变 null → 清空消息。

修复：改为只在 sessionId 真正变化时清空，不因 Settings 打开而清空。或者把 `messages` 状态提升到 store 里。

### 1.3 聊天头部显示 raw ID

`ChatView.tsx` L213：`session?.name || sessionId`。新建会话的 `name` 就是 ID（如 `session-lxv2f`）。改为：新会话显示 "新会话" + 时间，已重命名的显示名字。

---

## 二、会话管理重做（P0）

### 2.1 Session 接口扩展

```typescript
interface Session {
  id: string; periId?: string; name: string; source: string
  profileId: string; createdAt: number; lastActiveAt: number
  // 新增
  platform: 'local' | 'qq-group' | 'qq-dm' | 'terminal'
  workdir: string              // 工作目录（Peri cwd 参数）
  sessionPrompt: string        // 会话级 system prompt（覆盖 profile persona）
  skills: string[]             // 会话级 skill 列表
  hooks: string[]              // 会话级 hook 列表
  autoName: string             // 自动生成的名称（第一轮对话前 30 字）
}
```

### 2.2 Platform 分组

`Sidebar.tsx` 按 `platform` 分组，不再从 `source` 字符串解析：

```
▼ 本地
  ● 新会话 1              3m ago
  ● 调试会话              1h ago
▼ QQ 群聊
  ● 811B                  2m ago
▼ QQ 私聊
  ● 14CE                  5m ago
```

### 2.3 自动命名

首轮对话的 user message 前 30 个字符作为 `autoName`。`ChatView.tsx` 收到 `peri:user` 事件后，如果 session.name 仍是默认的 ID 格式 → 更新 name。

### 2.4 会话级 prompt/skill/hook

Settings → 新增 "会话设置" 页面，或 Sidebar 右键菜单 → 会话属性：

```
工作目录: [G:\Project\prism]
会话 Prompt: [textarea]
Skills: [/compact, /model]
Hooks: []
```

Peri `session/new` 支持 `cwd` 参数（已在用）。`sessionPrompt` 替代 profile persona。

为保证兼容性（Hermes 等其他 ACP）：如果 agent 不支持这些字段，前端 fallback 到基础模式。

### 2.5 ⚠️ 跨 Agent 兼容性要求

所有会话级扩展字段（`platform`、`workdir`、`sessionPrompt`、`skills`、`hooks`）必须对不支持它们的 agent 透明：

- `sessionPrompt`：agent 不支持时，回退到 Profile persona 注入（当前行为）
- `skills`/`hooks`：agent 不支持时，忽略
- `platform`：纯前端分组字段，不传给 agent
- `workdir`：Peri 用 `--cwd` 参数，Hermes 用 `hermes acp` 的工作目录。agent 不支持时 fallback 到 `agents.yaml` 中 agent 的 `cwd`

ACP `session/new` 的标准参数是 `{ cwd, mcpServers }`。不要假设 Peri 特有的参数。扩展通过 `session/set_config` 或 prompt preamble 注入。

### 2.5 删除按钮位置

当前 `✕` 在最右边，容易误触（特别是窄侧栏时）。改为：

- 默认隐藏（保持 hover 显示）
- 或者移到右键菜单
- 或者添加滑动删除

---

## 三、UI 精修（P1）

### 3.1 工具链竖线连续化

当前 `.term-tool + .term-tool::before` 只连相邻 tool。中间插入思考块就断。

修复：在 tool message 的容器上加 `.tool-chain` class（连续 tool 调用时），用左边框模拟竖线：

```css
.tool-chain {
  border-left: 2px solid var(--border);
  padding-left: 12px;
  margin-left: 3px;
}
```

### 3.2 ECG 行波

当前 `offset` 只平移窗口内的波形。改为真正的行波：

```typescript
// wave() 生成 3×W 长度的波形，offset 在 [0,W) 循环
// 每 tick 前进 offsetSpeed 像素
function wave(w: number, h: number, intensity: number, offset: number, ampMax: number, speedMax: number, noiseScale: number): string {
  // 生成 3 倍宽度，取 [offset, offset+w] 窗口
  const totalW = w * 3
  // 生成点...
  // x 坐标：从 -w 到 totalW+offset，取窗口后映射到 [0,w]
}
```

### 3.3 思考块靠右

`.term-reasoning-body` 已有 `padding: 0 0 4px 12px`。增大到 18px 更明显。

### 3.4 右面板 drag-resize 禁用

`App.css` 给 `.right-panel` 加 `min-width: var(--right-width)` 和 `flex-shrink: 0` 防止被压缩/拖拽。

### 3.5 侧栏折叠优化

收起时不设固定宽度，改为过渡动画 + 隐藏背景图：

```css
.sidebar { transition: width 0.25s; }
.sidebar.collapsed {
  width: 48px; min-width: 48px;
  background-image: none !important;
}
```

### 3.6 背景图拖拽上传 + 适应模式

Settings → 全局外观 → 背景图区域：

```tsx
<div className="bg-drop-zone"
  onDrop={e => { const file = e.dataTransfer.files[0]; /* 读取路径 */ }}
  onDragOver={e => e.preventDefault()}>
  拖拽图片到此处 / 点击选择
</div>
```

新增 `bgFit: string` 字段：`'cover' | 'contain' | 'stretch' | 'tile'`。

### 3.7 输入栏重排

默认模式：

```
[📎 附件标签] [textarea.....................................] [↑]
```

CLI 模式：

```
══════════════════════════════════════════════
[📎]  textarea...............................  [↑]
══════════════════════════════════════════════
```

`📎` 和 `↑` 在上下横线内侧、`textarea` 无边框。

### 3.8 状态栏精简

当前：`[SVG] [pct] [tokens] [agent] [Prism] [model] [mode]`

改为：`[SVG] [pct] [tokens]  |  [model▾] [mode↻]  |  [⚙]`

- Agent 名移到 Settings → Agent 页面（已做）
- Prism ON/OFF 移到 Settings → Prism 页面（未接，先隐藏或移到那里）
- Model 下拉和 Mode 切换保留，统一 pill 风格

---

## 四、给 coder

1. P0 组的会话管理重做是核心——其他都建立在正确的 session 结构上
2. 窗口按钮和上下文丢失先修
3. P1 组可以分批提交
4. 每完成一批 commit。不 build。
