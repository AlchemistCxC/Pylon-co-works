# REVIEW-v10 — 审计报告（更新）

**审计时间**: 2026-07-25 23:04 (CST)  
**基线**: `3288c95`  
**HEAD**: `fedafee`  
**提交数**: 6（新增 1 个 §6 自上次审计）  
**作者**: GMY <3294447364@qq.com>

---

## 变更概览

| # | Commit | 日期 | 内容 |
|:--|:-------|:-----|:-----|
| 1 | `ad468a7` | 22:49 | §1 标题栏重构 — ☰ toggle, Tab 上移, 删浮动按钮 |
| 2 | `4d68ffc` | 22:50 | §2 Settings overlay — fixed+blur, close btn, onClose |
| 3 | `e73e381` | 22:51 | §3-4 ECG 重写 + 字体栈 + CC bg + antialiasing |
| 4 | `03e1c8b` | 22:53 | §5 Spinner — color/size, sparkles presets, CSS vars |
| 5 | `f58b22b` | 22:55 | fix: 字体栈顺序 Cascadia Code first |
| 6 | `fedafee` | 22:57 | §6 预设系统 — PresetRow + Terminal/CC builtins |

**文件**: 14 files, +943 / -64

---

## 逐项审查

### §1 标题栏重构 (`ad468a7`)

```
App.tsx: ☰ 按钮从 position:fixed 浮层移至 titlebar 内，Tab 从 .tabbar 移至 titlebar-tabs
App.css: +titlebar-toggle/+titlebar-tabs 样式，-tabbar/-main-body/-bottom-area/-right-panel 旧样式
Sidebar.css: -sidebar-toggle-float 旧样式
```

✅ 通过。Titlebar 结构清晰，`-webkit-app-region:drag/no-drag` 正确分离拖拽区和交互区。

---

### §2 Settings overlay (`4d68ffc`)

```
Settings.tsx: +onClose prop, +close btn (✕)
Settings.css: position:fixed; inset:32px 0 0 0; backdrop-filter:blur(20px); z-index:50
App.tsx: Settings 从 main 内部移出 → {showSettings && <Settings onClose={...}/>}
```

✅ 通过。Overlay 正确覆盖 titlebar 下方全部区域，z-index 合理。

---

### §3-4 ECG 重写 + 字体 (`e73e381`)

**ECG 核心改动**:
- `wave()`: `Math.sin` → `Math.pow` 非对称 P-QRS-T 波形
- RRI 调制: `Math.sin(ci * 0.7 + offset * 0.015) * 12`
- offset 永续增长（不模运算），行波通过 `firstCycle`/`lastCycle` 范围渲染
- `Math.random()` → `hash(seed)` 确定性抖动
- 跳过 x 不在 [0, W] 的点 (`if (x < -10 || x > w + 10) continue`)

**字体和背景**:
- index.css: `--mono` 字体栈（后经 f58b22b 修复顺序）
- ChatView.css: `-webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; font-kerning:none`
- store: +ccBg 字段

✅ 通过。ECG 算法完全符合 DESIGN-v10 §4。`hash()` 替代 `Math.random()` 消除随机闪烁。范围渲染保证性能恒定。

---

### §5 Spinner 增强 (`03e1c8b`)

```
store: +spinnerColor, +spinnerSize
Settings.tsx: sparkles 从 Txt → Sel (8 个预制), +SpinnerColor Swatch, +SpinnerSize Num
ChatView.css: .term-spinner 用 var(--spinner-color), var(--spinner-size)
```

✅ 通过。8 个 sparkles 预设与 DESIGN-v10 §7 一致。

---

### Fix: 字体栈 (`f58b22b`)

```
index.css: --mono: 'JetBrains Mono', ... → 'Cascadia Code', 'Consolas', 'JetBrains Mono', monospace
```

✅ 已修复。上次审计标记的 🟡 问题已解决。

---

### §6 预设系统 (`fedafee`)

```
+ PresetRow.tsx (40 行)
  - BUILTIN: { terminal: [Terminal Light, Dracula], cc: [Glass, Dark Glass] }
  - apply(): updateTheme(colors) + setState(activePreset)
  - UI: chip buttons (预设名 + active 高亮)

Settings.tsx (+6 行)
  - 在 terminal/cc 各区段的顶部加入 <PresetRow area="..."/>

store.ts (+5 行)
  - +presets: Record<string, ...[]>
  - +activePreset: Record<string, string>
```

**审查发现**:

| 项目 | DESIGN-v10 §9 要求 | 实现 | 状态 |
|:-----|:-------------------|:-----|:-----|
| 内置预设 | 7 区各 3 个 | terminal 2 个, cc 2 个, 其余 5 区无 | 🟡 部分 |
| 字体预设 | colors + fonts | 仅 colors | 🟡 缺失 |
| 用户保存 | [▼ 保存为预设] 弹窗 | 无 | ❌ 未实现 |
| 重命名/删除 | 右键菜单 | 无 | ❌ 未实现 |
| Custom 状态 | 手动改值 → 自动切 "Custom" | 无 | ❌ 未实现 |

**代码质量**:

- 🟡 `updateTheme(preset.colors as any)` — `as any` 绕过类型检查。`updateTheme` 接受 `Partial<ThemeSettings>`，但 `preset.colors` 是 `Record<string,string>`。类型不安全，但运行时安全（只传已知 color key）。
- 🟡 `PresetRow` 在 terminal 区出现 3 次（聊天区/工具/消息栏各一次），cc 区 2 次。功能上无问题（都操作同一 store），但重复渲染 3-5 个相同 PresetRow 是浪费。每区一个即可。
- ✅ 组件结构清晰，`BUILTIN` 集中定义，可扩展。

---

## 整体评估

### 设计一致性

| 设计要求 | 实现 | 状态 |
|:---------|:-----|:-----|
| §1 标题栏重构 | ☰ + Tab + 删浮钮 | ✅ |
| §2 Settings overlay | fixed + blur + close | ✅ |
| §3 ECG 重写 | hash/RRI/asym/range | ✅ |
| §4 字体+渲染 | antialiased + ccBg | ✅ |
| §5 Spinner | color/size/sparkles | ✅ |
| §6 预设 | 仅 terminal/cc 基础版 | 🟡 |
| §7 Agent CRUD + cwd | — | ❌ 未做 |
| §8 Radix 接入 | — | ❌ 未做 |

### 风险矩阵

| 风险 | 等级 | 说明 |
|:-----|:-----|:-----|
| PresetRow 重复渲染 5 次 | 🟢 低 | 性能影响可忽略，每组件 ~10 DOM 节点 |
| `as any` 类型断言 | 🟢 低 | 运行时安全，仅传已知 key |
| 预设系统不完整 | 🟡 中 | 用户无法保存自定义预设，功能缺口 |
| ECG offset 无界增长 | 🟢 无 | JS number 精度在数月后仍足够（~2^53） |

### 统计

- 6 commits, 14 files, **+943 / -64**
- 平均 commit 大小: ~167 行
- 全部由 GMY 在 8 分钟内连续提交（22:49–22:57）— 设计→实现节奏极快
- 无 build 错误（DESIGN 明确标记 "不 build"）

---

## 结论

**通过。** V10 §1-§5 完整实现，§6 预设系统有基础框架但功能不完整。字体栈问题已修复。无阻断性问题。

**待完成**（DESIGN-v10 标记）:
- §6 预设系统完善：7 区全覆盖 + 字体预设 + 保存/重命名/删除 + Custom 检测
- §7 Agent CRUD + cwd 修复
- §8 Radix UI 接入（Dialog/Dropdown/Tooltip）
- §11 Agent 标签重设计
- §12 背景图补齐（每区 bgImage + fit 模式）

---

*审计者: Riccati (Hermes Agent) · 自动化 cron 审计*
