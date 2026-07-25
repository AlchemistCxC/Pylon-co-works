# Pylon V11 — 重大 Bug 修复 1.0

> 给 coder。4 个 bug，逐个根因分析 + 彻底修复。这次修完不准再犯。

---

## B1 — 状态栏顶到 ChatView 最上方

### 症状

ChatView 无消息时，ControlCenter（含 StatusBar）从底部飘到 ChatView 上方。

### 根因

V10 §1 标题栏重构时，删了 `.main-body` 的 CSS：

```css
/* 这一条被删了 */
.main-body { flex:1; display:flex; flex-direction:column; min-height:0; overflow:hidden; }
```

但 App.tsx L136 的 `<div className="main-body">` 没删。没有 CSS → div 退化为普通块元素 → ChatView 和 ControlCenter 变成并列关系而非上下关系 → ChatView 无内容时高度坍缩 → ControlCenter 浮到顶部。

**不只是缺 CSS。** 根本问题是 CSS 删了但 HTML 结构没变——这种"拆一半"的改法在 V9/V10 多次出现（删 sidebar-toggle-float CSS 留 HTML、删 tabbar CSS 留 HTML）。以后改结构必须**同时改 HTML 和 CSS**。

### 修复

```css
/* App.css — 还原 */
.main-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
```

同时确认 ChatView CSS 有 `flex:1`：

```css
/* ChatView.css — 确认这条仍存在 */
.chat-view { flex: 1; ... }
```

ControlCenter CSS 确认 `flex-shrink: 0`：

```css
/* ControlCenter.css */
.control-center { flex-shrink: 0; }
```

**验证**：空 ChatView 时 StatusBar 仍在底部。发消息后 ChatView 撑开。

---

## B2 — 标题栏 Tab 位置 + ChatView header 残留

### B2a — Tab 不在左边

**症状**：Peri / Prism tab 紧挨 Pylon 文字，window 控件在最右。布局正确，但用户期待 tab 在 ☰ 按钮和 Pylon 文字之间，视觉上更"在左边"。

**根因**：标题栏 HTML 顺序是 `☰ → Pylon → [Peri][Prism] → spacer → [─][⛶][✕]`。`space-between` 把 Pylon + tabs 打包在左边，controls 在右边。tab 夹在 Pylon 文字和 controls 之间，视觉上偏中而不是偏左。

跟 Peri/PrismSheet 位置无关——tab 切换逻辑正确。

**但如果用户说的是"Peri/PrismSheet 的内容区不在左边"**——那是右面板开着导致 ChatView 被右面板挤到中间。检查 `rightOpen` 状态。

### B2b — "新会话 · 1h ago" 残留

**症状**：ChatView 左上角仍显示此文本。

**根因**：V9 L228 的 `autoName` 逻辑只在收到第一条用户消息时更新（`peri:user` 事件处理器中）。首次渲染时 `autoName` 为空，name 以 `session-` 开头 → 显示 "新会话 · 时间"。消息到达后 `autoName` 被设置，但**这条已经渲染的文本不会自动更新**——它用了 `useStore.getState()` 在 render IIFE 中读取，没有响应式订阅。

```typescript
// ChatView.tsx L227-231 — 当前代码
<span className="chat-title">{(() => {
  const s = useStore.getState().sessions.find(s => s.id === sessionId)
  if (!s) return '新会话'  // ← 每次 render 都执行，但只在重渲染时更新
  return s.autoName || (s.name.startsWith('session-') ? `新会话 · ${formatTime(s.createdAt)}` : s.name)
})()}</span>
```

`useStore.getState()` 是穿透调用——读取的是当前瞬间快照。如果 `autoName` 在消息到达后更新了 store，ChatView 不会自动重渲染这个 `<span>`，因为它不订阅相关 slice。只有当 ChatView 因为其他原因（如新消息 `setMessages`）重渲染时，IIFE 才重新执行并拿到新值。

但如果消息到达前这段时间，文本一直是 "新会话 · 1h ago"。消息到达 → `setMessages` 触发重渲染 → IIFE 读到 `autoName` → 更新。所以**消息到达后会更新**。如果用户看到的是**永远不更新**，那是 IIFE 在消息到达后没被重新执行——可能 React.memo 阻止了重渲染（sessionId 没变）。

### 修复

改为 hook 订阅：

```typescript
const headerTitle = useStore(s => {
  const session = s.sessions.find(ss => ss.id === sessionId)
  if (!session) return '新会话'
  return session.autoName || (session.name.startsWith('session-') ? `新会话 · ${formatTime(session.createdAt)}` : session.name)
})

// 渲染
<span className="chat-title">{headerTitle}</span>
```

`useStore(s => ...)` 会订阅 sessions 的变化。`autoName` 更新 → sessions 数组变化 → selector 重新计算 → 重渲染。

---

## B3 — 设置重构未生效

### 症状

Settings 打开后视觉跟以前一样——左侧竖排按钮、右侧内容区、sec 条件渲染。

### 根因

Radix Tabs 确实接了，但用的是旧架构套壳：

```tsx
// Settings.tsx L84-90 — 当前代码
<Tabs.Root value={sec} onValueChange={(v) => setSec(v as Section)} orientation="vertical">
  {NAV.map(n => (
    <Tabs.Trigger key={n.key} value={n.key} className="set-nav-btn">
      {n.label}
    </Tabs.Trigger>
  ))}
</Tabs.Root>

// L130 — 仍用 sec 条件渲染
{sec === 'terminal' && <><Group>...</Group></>}
// L153 — 重复
{sec === 'terminal' && <><PresetRow area="terminal"/></>}
```

问题：用了 `<Tabs.Root>` 管理 `value` 和切换，但内容区仍用手动 `sec === 'xxx'` 条件渲染，没用 `<Tabs.Content>`。Radix Tabs 不知道内容在哪，只管理了触发器的高亮状态。

**为什么看起来一样**：
1. Trigger 复用旧 `set-nav-btn` CSS class — 视觉没变
2. 内容区用旧条件渲染 — 行为没变  
3. 多个 `sec === 'terminal'` block — PresetRow 渲染了 2 次

**这不算"没生效"——功能正确，只是设计意图（视觉刷新）和代码质量（去重 block）没到位。**

### 修复

彻底替换为 Radix Tabs 结构：

```tsx
<Tabs.Root defaultValue="global" className="settings-root">
  <Tabs.List className="settings-tablist">
    <Tabs.Trigger value="global" className="settings-tab">全局</Tabs.Trigger>
    <Tabs.Trigger value="cc" className="settings-tab">中控区</Tabs.Trigger>
    <Tabs.Trigger value="terminal" className="settings-tab">终端</Tabs.Trigger>
    <Tabs.Trigger value="sidebar" className="settings-tab">左栏</Tabs.Trigger>
    <Tabs.Trigger value="right" className="settings-tab">右栏</Tabs.Trigger>
  </Tabs.List>

  <Tabs.Content value="global">
    {/* 全局内容 */}
    <PresetRow area="app" />
    ...
  </Tabs.Content>

  <Tabs.Content value="cc">
    {/* 中控区内容 */}
    <PresetRow area="cc" />
    ...
  </Tabs.Content>

  ...
</Tabs.Root>
```

删 `Section` 类型、删 `NAV` 数组、删 `sec ===` 条件判断。所有内容移到对应 `<Tabs.Content>` 内。PresetRow 每区只出现一次。

---

## B4 — ECG 三连 bug（空/闪烁/左移）

### B4a — 空（无点渲染）

**症状**：心电图偶尔变空白，无波形。

**根因**：cycle 范围估算与每周期可变 cycleW 不一致。

```typescript
// L21-22 — 用 baseCycleW 估算范围
const baseCycleW = 70 + (1 - intensity) * 40  // 固定值: 70~110
const firstCycle = Math.floor((-w - offset) / baseCycleW) - 2
const lastCycle = Math.ceil((w * 2 - offset) / baseCycleW) + 2

// L29 — 但每个周期的 cycleW 是变的
const rri = Math.sin(ci * 0.7 + offset * 0.015) * 12
const cycleW = baseCycleW + rri  // 实际: 58~122
```

当 RRI 导致 cycleW 比 baseCycleW 大很多时（如 122），某些心跳的 x 范围超出了 `[firstCycle, lastCycle]` 估算的区间，部分心跳被跳过。反过来，当 cycleW 很小（58）时，x 坐标更密集但范围覆盖不够。

**但更致命的**——`x` 公式本身：

```typescript
// L35 — 当前
const x = (ci + phaseT) / 1.0 * cycleW + offset
```

这个公式等价于 `x = (ci + phaseT) * cycleW + offset`。`ci` 是周期索引，`ci * cycleW + offset` 是该周期起点的 x 坐标。当 offset 是 100000 时，x 是 100000+。虽然被 `continue` 过滤，但 `firstCycle`/`lastCycle` 计算用的是 `(-w - offset) / baseCycleW`——当 offset 很大时（比如跑 10 秒后 offset ≈ 2000），`firstCycle = (-150-2000)/80 = -27`，`lastCycle = (300-2000)/80 = -22`。两个都是负数且顺序正确（-27 < -22）。但这些负 ci 指向的 x 坐标是 `ci * cycleW + offset`：

- ci=-27, cycleW=80, offset=2000 → x = -27*80 + 2000 = -160
- ci=-22, cycleW=80, offset=2000 → x = -22*80 + 2000 = 240

第一轮 x 从 -160 开始，经过 0 进入可见区直到 240。看起来应该有几个周期落在 [0, W=150] 内。但问题是这些 "周期" 不是基于 start 时间计算的——`ci` 从 firstCycle 到 lastCycle 遍历，但 `x = ci * cycleW` 假设每个周期正好 cycleW 宽。实际上 RRI 调制后每个周期的宽度不同，导致最后一个周期可能只覆盖到 x=240 但实际需要到 x=150。

**真正造成空白的原因**：当 `intensity` 较高时 `baseCycleW` 变小，`lastCycle - firstCycle` 的周期数减少。如果 RRI 调制让某些心跳变宽，周期数不够→覆盖不全→部分 x 区间没点→空白。

### 彻底修复方案

不用 `firstCycle/lastCycle` 估算。改用时间线方式——生成从 `-W` 到 `W*2` 的点，不管 ci 范围：

```typescript
function wave(w: number, h: number, intensity: number, offset: number, ampMax: number, noiseScale: number): string {
  const mid = h / 2
  const amp = 3 + intensity * ampMax
  const baseCycleW = 70 + (1 - intensity) * 40
  const pts: string[] = []
  
  // 从 offset-W 开始生成心跳，直到 offset+W*2
  let xPos = -w  // 从 viewport 左边开始
  let cycleIndex = Math.floor((-w - offset) / baseCycleW)
  
  while (xPos < w + baseCycleW * 3) {  // 生成足够的点覆盖整个 viewport
    // 每个心跳独立计算cycleW
    const rri = Math.sin(cycleIndex * 0.7 + offset * 0.015) * 12
    const cycleW = baseCycleW + rri
    const xStart = cycleIndex * baseCycleW + offset  // 该心跳的基准起始 x
    
    for (const ph of phases) {
      const steps = Math.max(2, Math.floor((ph.end - ph.start) * cycleW / 3))
      for (let s = 0; s <= steps; s++) {
        const t = s / Math.max(1, steps)
        const jitter = (hash(cycleIndex * 100 + s) - 0.5) * 2 * noiseScale * 0.02
        const phT = ph.start + jitter + t * ((ph.end + jitter * 0.5) - (ph.start + jitter))
        const x = xStart + phT * cycleW
        
        if (x < -10 || x > w + 10) continue  // 过滤超出视口的点
        // ... y 计算（P/Q/R/S/T 不变）
        pts.push(`${x.toFixed(1)},${y.toFixed(2)}`)
      }
    }
    xPos = xStart + cycleW  // 推进到下一个心跳
    cycleIndex++
  }
  return pts.join(' ')
}
```

**关键改动**：
1. 不用公式估算 cycle 范围——用 `while` 循环生成直到覆盖整个视口
2. `xStart = cycleIndex * baseCycleW + offset` 作为每个心跳的基准起点
3. 该心跳内每个相位点 `x = xStart + phT * cycleW`（phT 在 0-1 之间）
4. 每个心跳用自己独立的 cycleW（RRI 调制）

### B4b — 闪烁

**根因**：`hash(ci * 100 + s)` ——当 ci 跨越 0（从 -2 到 -1 到 0）时，`ci * 100` 跳变大，hash 输出不连续。虽然 hash 本身是确定性的，但相邻帧的 ci 范围不同→第一帧 ci=-27..-20，下一帧 ci=-28..-21→每个点的 hash 种子差了一个周期→y 坐标突变→闪烁。

**修复**：用固定基准点 hash，不加 ci 偏移。用 x 坐标作为 seed：

```typescript
const jitter = (hash(Math.floor(x * 100)) - 0.5) * 2 * noiseScale * 0.02
```

同一 x 坐标在不同帧产生相同噪声——消闪烁。不同心跳的同一相位位置（x 相同）噪声相同，但每个心跳的 x 起点不同所以实际不会重复。

### B4c — 向左移动

**根因**：不是真向左。`offset = tick * offsetSpeed` 递增 → x 递增 → 波向右。用户可能看到的是：

1. 闪烁造成的视觉错觉——噪声突变看起来像波"跳"了
2. 或者 `offset` 在某个大值后 `x` 计算溢出了 JS 整数精度（不可能——offset 到 10^8 才出问题）

**修复**：B4b 的闪烁修复会同时消除这个错觉。

---

## 修复优先级

| 顺序 | Bug | 改动量 | 影响 |
|:--|:--|:--|:--|
| 1 | B1 main-body CSS | 3 行 | 布局全崩 |
| 2 | B4 ECG 三连 | ~50 行重写 | 核心视觉效果 |
| 3 | B3 Settings Radix | ~100 行重构 | 设置可用性 |
| 4 | B2 header 响应式 | 5 行改 hook | 体验完善 |

---

## 给 coder

1. B1 → commit 1
2. B4 → commit 2（重写 wave 函数，仔细看第四节）
3. B3 → commit 3（Tabs.Content 替换 sec===）
4. B2 → commit 4（header 改 hook）
5. 每 commit 后自查：B1 确认 .main-body CSS 和 HTML 一致，B4 确认 offset 增加时点一直有
6. 不 build
