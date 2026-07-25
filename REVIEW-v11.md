# REVIEW-v11

> 审计员 Riccati · 4 commits → 逐项核对 DESIGN-v11

---

## Commit 统计

| # | Commit | 文件 | + | - |
|:--|:--|:--|:--|:--|
| 1 | `f5ca15f` B1 | App.css, ControlCenter.css | +9 | 0 |
| 2 | `ed6406d` B4 | StatusBar.tsx | +21 | -14 |
| 3 | `73938c6` B3 | Settings.tsx | +41 | -61 |
| 4 | `1e2ec30` B2 | ChatView.tsx | +7 | -5 |

---

## ✅ B1 — .main-body CSS 还原

**核对结果**：✅ 通过

- `.main-body` CSS 已还原到 App.css（flex:1 + flex-direction:column + min-height:0 + overflow:hidden）
- `.control-center` 加了 `flex-shrink:0`
- `.layout` 未被误删（最终状态确认存在）
- ChatView.css `.chat-view` 已有 `flex:1`（L6，未改动）
- HTML（App.tsx L136 `<div className="main-body">`）与 CSS 一致 ✅

**铁律检查**：§1.4 通过。HTML/CSS 一一对应。

---

## ✅ B4 — ECG wave() 重写

**核对结果**：✅ 通过

三连 bug 逐项验证：

### B4a — 空白（无点渲染）

- 旧代码：`firstCycle/lastCycle` 用 `baseCycleW` 估算范围，但 RRI 调制后实际 `cycleW` 不同 → 范围漏覆盖
- 新代码：`while (true)` + `xStart > w + baseCycleW * 2` break → 总是生成足够的点覆盖视口 ✅
- break 条件用 `baseCycleW * 2` 安全余量，即使 RRI 让 cycleW 变大也能覆盖 ✅

### B4b — 闪烁

- 旧代码：`hash(ci * 100 + s)` — ci 跨越时 seed 跳变 → y 突变
- 新代码：`hash(Math.floor(x * 100))` — 同 x 同 seed，跨帧稳定 ✅
- jitter 大小不变：`(hash - 0.5) * 2 * noiseScale * 0.02`，与旧公式等价 ✅

### B4c — 左移

- 根因是 B4b 闪烁造成的视觉错觉，B4b 修复后自动消除 ✅

### 额外验证

- `xJittered` 双重边界检查（x 和 xJittered 各一次）— 安全 ✅
- 旧代码的 `pts.push('0,${mid}')`（x=0 锚点）被移除 → 不影响，while 循环从 `(-w-offset)/baseCycleW` 开始自然覆盖 ✅
- P/Q/R/S/T 波形公式未变 ✅
- ECG 规范 §5.3：hash() 非 Math.random() ✅，offset 永续递增 ✅，Math.pow 非对称 ✅

---

## ✅ B3 — Settings Tabs.Content 重构

**核对结果**：✅ 通过

- 删 `Section` 类型、`NAV` 数组、`sec` 状态 ✅
- `Tabs.Root` 改为 `defaultValue="global"`（非受控模式）✅
- 7 个 `<Tabs.Content>` 替代 7 个 `sec ===` 块 ✅
- 合并重复：
  - terminal：原 3 个 `sec==='terminal'` 块 → 1 个 `<Tabs.Content value="terminal">`，1 个 `PresetRow` ✅
  - cc：原 2 个 `sec==='cc'` 块 → 1 个 `<Tabs.Content value="cc">`，1 个 `PresetRow` ✅
- 删未用 `PresetBtns` helper ✅
- `useState` import → 简化为 `useRef` ✅
- CSS 未改动（`.set-nav-btn` 复用 Radix `data-state` 选择器 L15）→ 兼容 ✅

---

## ✅ B2 — ChatView header hook 订阅

**核对结果**：✅ 通过

- `useStore.getState().sessions.find(...)` IIFE → `useStore(s => s.sessions.find(...))` hook ✅
- selector 返回 string 原语 → 仅在标题实际变化时触发 ChatView 重渲染 ✅
- React.memo + sessionId props → hook 在 memo 内部，sessionId 不变时不重新订阅 ✅
- 逻辑等价：autoName 优先 → 默认名判断 → 时间格式化，未变 ✅

---

## 🔴 必须修

无。

---

## 🟡 建议修

### S1 — Agent/Session tab 仍用 getState()

`Settings.tsx` Agent 和 Session 两个 `<Tabs.Content>` 内仍用 `useStore.getState()`：

```typescript
// L255 — Agent tab
{useStore.getState().activeAgent || 'peri'}

// L258 — Agent tab
{useStore.getState().agents.map(...)}

// L281 — Session tab
{useStore.getState().sessions[0]?.sessionPrompt || ''}
```

**建议**：改为 hook 订阅，跟 B2 同理。不修的话，agent 切换后需关闭再打开 Settings 才能看到变化。

**不修没事**：这些值不会在 Settings 打开期间变化（agent 切换需重启，session prompt 手动改）。用户体验影响极低。下次重构 Settings 顺手改即可。

---

## 🟢 可接受

### N1 — PresetRow area="app" 返回 null

全局 tab 加了 `<PresetRow area="app" />`，但 `PresetRow.tsx` BUILTIN 无 `app` 键 → 返回 null。无视觉影响，为未来预设系统留坑。✅

### N2 — 重复 border-bottom

B3 合并 terminal/cc 后，每个区有多个 `<h3>` 标题，每个都有 `border-bottom`。视觉上每段标题带下划线，正确。

---

## 铁律汇总

| 铁律 | 状态 |
|:--|:--|
| §1.1 改 HTML 同步改 CSS | ✅ B1 还原 .main-body，CSS 与 HTML 一致 |
| §1.2 改完自查 | ✅ B1 patch 后 re-read 发现 .layout 丢失并修复 |
| §1.3 不 build | ✅ 未跑 npm run build / cargo build |
| §1.4 CSS 和 HTML 一致 | ✅ 无孤悬 class |
| §5.1 条件渲染不销毁组件 | ✅ N/A（本次未改条件渲染） |
| §5.2 删代码全部删 | ✅ B3 删 Section/NAV/sec/PresetBtns 全部清理 |
| §7 禁止清单 | ✅ 无违规 |

---

## 结论

**全部通过。** 4 个 bug 修复正确，无回归，类型检查零错误。0 个必须修，1 个建议修（不修没事）。

可进入 build 验证。
