# Prism Desktop V3 设计书 — 状态栏重构 + 功能接线

> 给 coder。工作流程同 V2：写完 commit（不 build）→ 我审计 → REVIEW-v3.md → 修 → build。

---

## 一、总体范围

| 优先级 | 模块 | 内容 |
|:--|:--|:--|
| P0 | 状态栏数据验证 | 确认 `usage_update` 事件到达前端 |
| P0 | 心电图行为重构 | 端点左移、动态强度、基线/波/端点分层 |
| P0 | 心电图样式自定义 | Settings 加字段，CSS 变量对接 |
| P1 | 状态栏功能接线 | onCompact、onPrismToggle 实际生效 |
| P1 | 左侧栏收起 | Sidebar toggle 已有 UI，加 state |
| P1 | Agent 列表 + 切换 | StatusBar 显示 agent、前端调 `list_agents`/`switch_agent` |
| P2 | 命令透传 | 解析 ACP `available_commands_update`，InputBar 动态命令列表 |
| P2 | 输入栏 CLI 双横线 | CSS 伪元素 + Settings 可配 |
| P2 | 会话导出/恢复/压缩接线 | 前端接已有后端 command |

---

## 二、P0-1：状态栏数据验证

### 目标
确认 Peri 发送的 `usage_update` 事件经过 `acp.rs` → `lib.rs` → ChatView listen → `setLiveStats` → StatusBar props 这条链路是否通畅。

### 验证方法
ChatView.tsx 的 `usage_update` case 加 `console.log`（临时），打开 exe 发一条消息，看控制台输出：

```typescript
// ChatView.tsx — usage_update case 内
case 'usage_update': {
    console.log('[DEBUG usage_update]', upd);  // ← 临时加
    const used = upd.value || ...;
    // ...
}
```

如果没输出 → ACP 事件格式不对，需要抓 Peri 原始 stdout 比对。
如果有输出但 StatusBar 不动 → `setLiveStats` → props 传递链有问题。

### 参考
- `ChatView.tsx` L142-152 — usage_update 处理
- `lib.rs` L98-102 — session/update → emit `peri:update` 的 source 注入逻辑
- `acp.rs` L89-95 — RawMessage 解析
- Peri ACP 事件格式：`F:\A-I\Agent\Peri\peri-acp\src\dispatch\session_replay.rs`

---

## 三、P0-2：心电图行为重构

### 新行为（与当前相反）

```
当前: cut = W × used%     端点右移，左侧彩色=已用，右侧灰色=剩余
新:   cut = W × (1-used%) 端点左移，左侧彩色=剩余，右侧灰色=已消耗

used=0%:    ─────────────────────── cut=W   全绿，波慢，振幅低
used=50%:   ───────────▓▓▓▓▓▓▓▓▓▓  cut=W/2 半黄，波加速，振幅升高
used=80%:   ────▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  cut=W/5 红，波剧烈
used=100%:  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  cut=0   全灰（但不会到100%，Peri 有 max token）
```

### SVG 层序（从底到顶）

```
1. 渐变基线   x1=0   x2=W          单根线，<linearGradient> 在 cut 处断色：
                                    [0,cut] 彩色（随 used），[cut,W] 灰色
2. 波形       x1=0   x2=cut        clipPath 裁切，只在剩余空间渲染
3. 左定端点   x=0                  strokeWidth=3，高度 ±10px，灰色
4. 右定端点   x=W                  strokeWidth=3，高度 ±10px，灰色
5. 动端点     x=cut                strokeWidth=3.5，高度 ±12px，颜色随 used 变
```

基线用 `<linearGradient>` 实现变色，不需要两根线：

```tsx
<defs>
  <linearGradient id="baseline-grad" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stopColor={color} />
    <stop offset={cut / W} stopColor={color} />
    <stop offset={cut / W} stopColor="rgba(0,0,0,0.08)" />
    <stop offset="1" stopColor="rgba(0,0,0,0.08)" />
  </linearGradient>
</defs>
<line x1="0" y1={mid} x2={W} y2={mid}
      stroke="url(#baseline-grad)" strokeWidth={lineWidth} />
```

### 颜色和强度

```typescript
const used = tokensMax > 0 ? tokensUsed / tokensMax : 0
const cut = W * Math.max(0, Math.min(1, 1 - used))

// 颜色阈值
const color = used < 0.50 ? ekgGreen : used < 0.80 ? ekgYellow : ekgRed

// 强度驱动波速和振幅
const intensity = Math.min(1, used * 1.5)
const amp = 3 + intensity * 10       // 振幅 3px → 13px
const offsetSpeed = 0.5 + intensity * 2.0  // tick 速度
```

### wave() 函数改动

```typescript
function wave(w: number, h: number, intensity: number, offset: number): string {
  const mid = h / 2
  const amp = 3 + intensity * 10
  const cycleW = 70 + (1 - intensity) * 40  // 频率随 intensity 增大
  // ... 其余 ECG 各段（P-Q-R-S-T）逻辑不变
}
```

### 基线宽度

当前 `strokeWidth="2.5"`。V3 改为 3px（CSS 变量 `--ekg-line-width`，默认 3）。

### 端点参数

| 端点 | 高度 | 线宽 | 颜色 |
|:--|:--|:--|:--|
| 左定端点 | ±8px（总 16px） | 2.5 | 灰色 |
| 右定端点 | ±8px（总 16px） | 2.5 | 灰色 |
| 动端点 | ±10px（总 20px） | 3 | 随 used 变色 |

动端点比定端点稍高，视觉微突出。

### 心电图旁数据

StatusBar 已有百分比和 token 计数（`ekg-pct` + `pill-mono`），V3 确认这两项紧贴 SVG 右侧且格式统一：

```
[SVG 150×30]  42%  12.5k/128k  [hit%]  [Prism]  [model]  [mode]
```

- **SVG 尺寸**: 默认 150×30px（`--ekg-w` CSS 变量，Settings→状态栏→心电图宽度可调，范围 100–300）
- **百分比**: `ekg-pct`，字号 16px，颜色随 used 同步变化（绿/黄/红）
- **token 计数**: `pill-mono`，格式 `fmtSize(used)/fmtSize(max)`，字号 14px
- **hit%**: cache 命中率，只在 >0 时显示

### 上下文显示模式切换

新增 `tokenDisplay` 设置项（`'ekg'` | `'numeric'`，默认 `'ekg'`）：

- **ekg 模式**: 渲染 SVG 心电图 + 百分比 + token 计数（当前行为）
- **numeric 模式**: 不渲染 SVG，只显示纯数字百分比（绿色/黄色/红色） + token 计数，极简风格

```tsx
// StatusBar.tsx
const displayMode = useStore(s => s.tokenDisplay)
// ...
{displayMode === 'ekg' ? (
  <svg viewBox={`0 0 ${W} ${H}`} className="ekg-svg">...</svg>
) : null}
<span className="ekg-pct" style={{ color }}>{pct}%</span>
<span className="pill-mono">{fmtSize(tokensUsed)}/{fmtSize(tokensMax)}</span>
```

Settings UI：状态栏 section → Group "上下文显示" → Sel `tokenDisplay` options=['ekg','numeric']

### 参考
- `StatusBar.tsx` L5-38 — wave() 函数
- `StatusBar.tsx` L80-104 — SVG 渲染
- `StatusBar.css` L1-9 — EKG 样式
- `store.ts` L40-46 — DEFAULTS 中的 ekgGreen/Yellow/Red

---

## 四、P0-3：心电图样式自定义

### Settings 新增字段

在 `ThemeSettings` 接口和 `DEFAULTS` 中加：

```typescript
ekgLineWidth: number        // 基线宽度，默认 3
ekgAmplitudeMax: number     // 最大振幅，默认 10
ekgSpeedBase: number        // 基础波速，默认 0.5
ekgSpeedMax: number         // 最大波速，默认 2.0
ekgLeftColor: string        // 定端点颜色，默认 rgba(0,0,0,0.35)
ekgMovingColor: string      // 动端点颜色（可覆盖自动阈值色），默认 ''(空=自动)
ekgConsumedColor: string    // 已消耗区基线颜色，默认 rgba(0,0,0,0.08)
tokenDisplay: string        // 'ekg' | 'numeric'，默认 'ekg'
```

### CSS 变量映射

App.tsx `cssVars` useMemo 中新增：

```typescript
'--ekg-line-width': `${theme.ekgLineWidth}px`,
'--ekg-amp-max': `${theme.ekgAmplitudeMax}px`,
// ... 其余
```

### Settings UI

`Settings.tsx` → `status` section → 新 Group "心电图样式"：

```
Row label="基线宽度"     Num value={t.ekgLineWidth} min={2} max={20}
Row label="最大振幅"     Num value={t.ekgAmplitudeMax} min={5} max={30}
Row label="基础波速"     Num value={t.ekgSpeedBase} min={0.1} max={3} step={0.1}
Row label="最大波速"     Num value={t.ekgSpeedMax} min={0.5} max={5} step={0.1}
Row label="定端点颜色"   Swatch value={t.ekgLeftColor}
Row label="动端点颜色"   Swatch value={t.ekgMovingColor}
Row label="消耗区颜色"   Swatch value={t.ekgConsumedColor}
```

### 参考
- `store.ts` L7-16 — ThemeSettings 接口
- `App.tsx` L27-81 — cssVars 映射
- `Settings.tsx` L167-187 — status section 当前内容
- `StatusBar.tsx` L50-61 — props 接口

---

## 五、P1-1：状态栏功能接线

### onCompact（点击 ECG 区域 → 压缩上下文）

```tsx
// App.tsx — 传入 onCompact
<StatusBar
  onCompact={() => {
    if (activeSession) {
      const persona = useStore.getState().profiles.find(
        p => p.id === useStore.getState().activeProfileId
      )?.persona || ''
      invoke('send_message', { source: activeSession, content: '/compact', persona })
    }
  }}
/>
```

### onPrismToggle（Prism 开关预留）

```tsx
onPrismToggle={() => {
  useStore.getState().setLiveStats({
    livePrismOn: !useStore.getState().livePrismOn
  })
  // TODO: 接 Prism REST API 后调 /state enable/disable
}}
```

### 模型列表从 agent 配置读取

当前 StatusBar 硬编码了 `['deepseek-v4-flash', 'deepseek-v4-pro']`。改为从 Profile 的 model 字段读取，或者新增 `list_models` command。

最低方案：StatusBar 调用 `list_agents`，显示当前 agent 名，模型从 agent 配置的 args 中解析 `--model` 参数。

### 参考
- `App.tsx` L108-123 — StatusBar props
- `StatusBar.tsx` L40-41 — 硬编码 MODELS
- `lib.rs` L146-161 — list_agents / switch_agent

---

## 六、P1-2：左侧栏收起

Sidebar 已有折叠按钮（Sidebar.tsx L65）和 `.collapsed` CSS 类。当前只是隐藏了会话列表，侧栏仍占宽度。

### 改动

```typescript
// Sidebar.tsx
const [collapsed, setCollapsed] = useState(false)
// 已有 ↑

// CSS 补充
.sidebar.collapsed {
  width: 48px;
  min-width: 48px;
}
.sidebar.collapsed .search-input,
.sidebar.collapsed .session-list,
.sidebar.collapsed .profile-avatar:not(.active),
.sidebar.collapsed .profile-edit { display: none; }
```

收起时只显示当前 profile 头像和展开按钮。

### 参考
- `Sidebar.tsx` L13, L61-67 — collapsed state + 按钮
- `Sidebar.css` L1-7 — .sidebar 宽度

---

## 七、P2-1：命令透传

### ACP 协议

Peri 在 `session/new` 和 `session/load` 返回后通过 `session/update` 通知发送 `AvailableCommandsUpdate`。格式（从 `F:\A-I\Agent\Peri\peri-tui\src\acp_stdio\commands.rs` 推断）：

```json
{
  "method": "session/update",
  "params": {
    "sessionUpdate": "available_commands_update",
    "commands": [
      {"name": "help", "description": "List available commands"},
      {"name": "model", "description": "Show or switch models", "input_hint": "model name"}
    ]
  }
}
```

### Rust 端：已有 broadcast 通道，不需要改

`lib.rs` L98-102 已经 emit 所有 `session/update` → `peri:update`。`available_commands_update` 会自然到达前端。

### 前端：ChatView.tsx 新增 case

```typescript
// ChatView.tsx — peri:update listener, switch 语句内
case 'available_commands_update': {
  const commands = upd.commands || []
  // 合并到 store
  useStore.getState().setLiveStats({ availableCommands: commands })
  break
}
```

### store.ts 新增

```typescript
liveCommands: { name: string; description: string; input_hint?: string }[]
// setLiveStats 支持 liveCommands
```

### InputBar.tsx 改动

```typescript
// 当前硬编码
const COMMANDS = [...]

// 改为从 store 读取
const liveCommands = useStore(s => s.liveCommands)
const COMMANDS = liveCommands.length > 0 ? liveCommands : FALLBACK_COMMANDS
```

### 参考
- `ChatView.tsx` L82-153 — sessionUpdate switch
- `InputBar.tsx` L11-18 — 硬编码 COMMANDS
- `store.ts` L79-84 — setLiveStats
- `F:\A-I\Agent\Peri\peri-tui\src\acp_stdio\commands.rs`

---

## 八、P2-2：输入栏 CLI 双横线

### CSS

```css
/* InputBar.css — 新增 */
.input-bar.cli-mode {
  border: none;
  background: transparent;
}
.input-bar.cli-mode .input-row {
  position: relative;
  padding: 12px 0;
}
.input-bar.cli-mode .input-row::before,
.input-bar.cli-mode .input-row::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: var(--cli-line-width, 2px);
  background: var(--cli-line-color, var(--accent));
}
.input-bar.cli-mode .input-row::before { top: 0; opacity: 0.5; }
.input-bar.cli-mode .input-row::after { bottom: 0; opacity: 0.8; }
.input-bar.cli-mode .input-textarea {
  background: transparent;
  border: none;
  padding: 8px 0;
  border-radius: 0;
  color: var(--cli-text-color, var(--text));
}
.input-bar.cli-mode .input-textarea:focus {
  outline: none;
  border: none;
}
```

### Settings 新增字段

```typescript
inputMode: string            // 'default' | 'cli', 默认 'default'
cliLineWidth: number         // 双横线宽度，默认 2
cliLineColor: string         // 双横线颜色，默认 var(--accent)
cliTextColor: string         // CLI 模式文字颜色
```

### InputBar.tsx 改动

```tsx
const inputMode = useStore(s => s.inputMode)
// ...
<div className={`input-bar ${inputMode === 'cli' ? 'cli-mode' : ''}`}>
```

### 参考
- `InputBar.css` L1-28 — 当前样式
- `Settings.tsx` L151-165 — input section

---

## 九、P2-3：会话导出/恢复/压缩接线

### 导出按钮

ChatView 顶部加导出按钮，调 `export_session`：

```tsx
// ChatView.tsx
import { save } from '@tauri-apps/plugin-dialog'

const handleExport = async () => {
  const s = useStore.getState().sessions.find(s => s.source === sessionId)
  if (!s?.periId) return
  const path = await save({ filters: [{ name: 'Markdown', extensions: ['md'] }] })
  if (path) await invoke('export_session', { periId: s.periId, format: 'markdown', outputPath: path })
}
```

### /export slash command

```typescript
// InputBar.tsx — execCommand
case '/export': {
  const s = useStore.getState().sessions.find(s => s.source === sessionId)
  if (s?.periId) {
    const path = `session-${s.periId}.md`
    await invoke('export_session', { periId: s.periId, format: 'markdown', outputPath: path })
  }
  break
}
```

### 会话恢复

Sidebar 已在 `handleSelect` 中调 `load_persisted_session`。需补充：启动时调 `list_persisted_sessions` 读取 Peri 端会话列表，merge 进 store。

```typescript
// Sidebar.tsx — useEffect 启动恢复
useEffect(() => {
  // 1. 读 localStorage
  const saved = restoreSessions()
  // 2. 读 Peri 持久化会话
  invoke('list_persisted_sessions').then((periSessions: any) => {
    // merge into store.sessions
  }).catch(() => {})
  // 3. setState
}, [])
```

### 参考
- `lib.rs` L165-178 — load_persisted_session
- `lib.rs` L180-185 — list_persisted_sessions
- `lib.rs` L189-204 — export_session
- `Sidebar.tsx` L47-61 — handleSelect

---

## 十、给 coder 的话

1. **P0 优先**——先验证数据链路（加 console.log 看 usage_update 有没有到），再做心电图重构。数据不通，心电图画得再好也没用。
2. **每完成一个 P 就 commit**——不要全部做完一起交。4 个 commit 比 1 个巨型 commit 好审计。
3. 心电图重构时，`wave()` 函数逻辑不变——只改 offset 速度和 color/intensity 传参。SVG 层序按第三节来。
4. 状态栏功能接线（P1-1）是纯前端——不需要改 Rust。
5. 命令透传（P2-1）需要验证 Peri 实际发送的 `available_commands_update` 格式——先用 console.log dump 出来再写 case。
6. **不 build。写完 commit。** 我会开 cron 盯着。
