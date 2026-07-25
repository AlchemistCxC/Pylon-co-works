# Pylon Bug 清单（核验版 + 方案）

---

## 🟡 P1 — 待修

### B3 — 折叠按钮被侧栏遮挡

**修复**：`sidebar-toggle-float` 移到 `.main` 内部左上角，或改 `left` 为 `-20px` 浮在侧栏边缘外侧。或改为在 ChatView 左上角渲染。

```tsx
// App.tsx — 移到 main 内部
<div className="main">
  <button className="sidebar-toggle-float" ... />
  ...
</div>
```

CSS 改为 `position:absolute; left:-16px; z-index:20;`

---

### B8 — console.log 残留

**修复**：删 `ChatView.tsx` L166 整行。

---

### B9 — sparkles 自定义不生效

**修复**：`ChatView.tsx` L38 改为用 store 值：

```typescript
// 删 L14 的模块级 SPARKLES 常量
// L31 改名为 sparkles
const sparkles = (useStore(s => s.sparkles) || '✳✴✵✶✷✸✹✺✻✼❃❊').split('')
// L38 改为
const frame = sparkles[tickIdx % sparkles.length]
```

---

### B10 — Empty state "Prism Desktop"

**修复**：`ChatView.tsx` L219 → `Pylon`。

---

### B11 — formatTime 重复定义

**修复**：新建 `src/utils.ts`，导出一份。Sidebar 和 ChatView 均 import：

```typescript
// utils.ts
export function formatTime(ts: number | undefined): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff/60000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff/3600000)}h ago`
  return `${Math.floor(diff/86400000)}d ago`
}
```

Sidebar.tsx 和 ChatView.tsx 删各自定义，改 `import { formatTime } from '../../utils'`。

---

### B12 — Titlebar "Prism Desktop"

**修复**：`App.tsx` L116 → `Pylon`。
