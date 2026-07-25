# Pylon V8 设计书 — ECG 行波 + UI 残项

> 给 coder。7 项。全修完这轮就只剩 polish。

---

## 一、ECG 行波重构（P0）

### 问题

当前波形像固定动画循环——offset 只模 75px，波在原地振动。噪声也分不清健康/紧张。

### 目标

永续行波。波从左边不断生成往右涌，clipPath 在动端点处裁切——cut 左边是活波，右边是死的。上下文越满 cut 越左移→活波区越窄→波被挤压越剧烈。

### 实现

```typescript
// ── wave() 生成 2×W 宽的波形 ──
function wave(w: number, h: number, intensity: number, offset: number, ampMax: number, noiseScale: number): string {
  const mid = h / 2
  const amp = 3 + intensity * ampMax
  const totalW = w * 2
  const pts = [`0,${mid}`]
  const cycleW = 70 + (1 - intensity) * 40
  const cycles = Math.max(4, Math.ceil(totalW / cycleW * 2)) * 2
  const phases = [
    { start:0.00, end:0.08, type:'p' }, { start:0.08, end:0.20, type:'flat' },
    { start:0.20, end:0.23, type:'q' }, { start:0.23, end:0.26, type:'r' },
    { start:0.26, end:0.30, type:'s' }, { start:0.30, end:0.45, type:'flat' },
    { start:0.45, end:0.65, type:'t' }, { start:0.65, end:1.00, type:'flat' },
  ]
  for (let ci = -2; ci < cycles; ci++) {
    for (const ph of phases) {
      const steps = Math.max(2, Math.floor((ph.end - ph.start) * cycleW / 3))
      for (let s = 0; s <= steps; s++) {
        const t = s / Math.max(1, steps)
        const phaseT = ph.start + t * (ph.end - ph.start)
        // x: 从 -W 到 +W，offset 持续右移
        const x = (ci + phaseT) / (cycles * 0.7) * totalW - w + offset
        let y = mid
        switch (ph.type) {
          case 'p': y = mid - Math.sin(t * Math.PI) * amp * 0.35; break
          case 'flat': y = mid; break
          case 'q': y = mid + t * amp * 0.5; break
          case 'r': y = mid + amp * 0.5 - Math.sin(t * Math.PI) * amp * 1.8; break
          case 's': y = mid + amp * 0.5 + Math.sin(t * Math.PI) * amp * 1.2; break
          case 't': y = mid - Math.sin(t * Math.PI) * amp * 0.6; break
        }
        y += (Math.random() - 0.5) * 2 * noiseScale
        pts.push(`${x.toFixed(1)},${y.toFixed(2)}`)
      }
    }
  }
  return pts.join(' ')
}
```

### 分段噪声

```typescript
// StatusBar 组件内
const used = tokensMax > 0 ? tokensUsed / tokensMax : 0
const noiseScale = used < 0.50
  ? 0.1 + Math.sin(tick * 0.1) * 0.05        // 绿: 微呼吸
  : used < 0.80
    ? 0.3 + intensity * 0.8                    // 黄: 可见抖动
    : 0.6 + intensity * 1.5                    // 红: 剧烈颤抖
```

绿色用慢正弦——不是随机爆炸，保留 ECG 形态的微呼吸感。

### offset 永续右移

```typescript
const offset = (tick * offsetSpeed) % (W * 4)  // 模够大防溢出
```

clipPath 已有——`<rect width={cut}>` 裁切动端点右边，不需要额外处理。

---

## 二、UI 残项（P0）

### 2.1 侧栏真隐藏

`Sidebar.css` `.collapsed`: `width: 0; min-width: 0; overflow: hidden; border: none;`（当前仍是 `width:48px`，按钮被遮住）

浮动折叠按钮 `.sidebar-toggle-float` 已有 CSS，位置正确。width 改为 0 后它自然可见。

### 2.2 ChatView 左右撑宽

```css
.chat-view { overflow-x: hidden; }
```

### 2.3 Chat header 友好名

`ChatView.tsx` 已实现 autoName 逻辑，但首次渲染时（无消息）显示 raw ID。改为：

```tsx
const s = useStore.getState().sessions.find(s => s.source === sessionId)
const displayName = !s ? sessionId
  : s.autoName || (s.name.startsWith('session-') ? `新会话 · ${formatTime(s.createdAt)}` : s.name)
```

`formatTime` 函数已在 Sidebar.tsx 中，需 export 后在 ChatView 复用。

### 2.4 CLI 视觉风格（双横线 + > 前缀）

```tsx
// InputBar.tsx — style 属性根据 inputStyle 切换
const inputStyle = useStore(s => s.inputStyle) // 'default' | 'cli'
// cli 风格:
// - textarea 前加 <span className="cli-prefix">{'>'}</span>
// - textarea 透明背景、无边框、等宽
// - 双横线由 .cli-mode ::before/::after CSS 提供
```

CSS：

```css
.cli-prefix {
  color: var(--accent); font-family: var(--mono);
  font-size: var(--input-font-size, 17px); margin-right: 6px;
  user-select: none;
}
```

按钮显隐由中控区控件开关控制，不另设 CSS。

### 2.5 中控区拖拽排序

`@dnd-kit/core` + `@dnd-kit/sortable` 已在 package.json。ControlCenter 的控件用 `useSortable` 包裹，提供拖拽把手重排 `ccLayout`。

最低实现：一行水平排列 + 拖拽。高级：Settings → 中控区 → 可视化编辑（后续）。

---

## 三、给 coder

1. ECG 行波是核心——先做这个，效果立竿见影
2. 侧栏 width:0 一行改
3. CLI 风格纯 CSS + 一个 `<span>></span>`
4. 拖拽排序最低实现即可
5. commit 分批，不 build
