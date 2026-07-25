# Pylon V10 设计书 — UI 重构 + ECG 重写

> 给 coder。这是大的。分批 commit，不 build。

---

## 一、标题栏重构

### 1.1 Tab 上移

tabbar 从 `.main` 内移到 titlebar，跟 "Pylon" 同行：

```
┌ ☰ Pylon  [Peri] [Prism]         ─ ⛶ ✕ ┐
│ 侧栏 │ ChatView                        │
│      │                                 │
│      ├─ ControlCenter ────────────────┤
└──────┴─────────────────────────────────┘
```

App.tsx 改动：

```tsx
<div className="titlebar" data-tauri-drag-region>
  <button className="titlebar-toggle" onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>☰</button>
  <span className="titlebar-text">Pylon</span>
  <div className="titlebar-tabs">
    <button className={`tab ${activeTab==='peri'?'active':''}`} onClick={() => setActiveTab('peri')}>Peri</button>
    <button className={`tab ${activeTab==='prism'?'active':''}`} onClick={() => setActiveTab('prism')}>Prism</button>
  </div>
  <div className="titlebar-controls">...</div>
</div>
```

删 `.sidebar-toggle-float`（浮动按钮），删 `.main` 内的 tabbar。

CSS：

```css
.titlebar-tabs { display:flex; gap:4px; margin-left:12px; }
.titlebar-tabs .tab { padding:2px 12px; border-radius:4px; border:none; background:transparent; color:var(--text-dim); cursor:pointer; font-size:13px; }
.titlebar-tabs .tab.active { background:var(--bg-panel); color:var(--text); }
.titlebar-toggle { background:none; border:none; color:var(--text-dim); cursor:pointer; font-size:16px; padding:0 8px; }
```

---

## 二、Settings 改 overlay（补 V9 缺口）

App.tsx L138: `{showSettings ? <Settings /> : ...}` → Settings 保持独立渲染，浮在 ChatView 上方：

```tsx
<div className="main-body">
  {activeTab === 'prism' ? <PrismSheet /> : <>
    <ChatView sessionId={activeSession} />
    <ControlCenter sessionId={activeSession} />
  </>}
</div>
{showSettings && <Settings onClose={() => setShowSettings(false)} />}
```

Settings 自身用 `position:fixed; inset:0; z-index:50; background:var(--bg-panel); backdrop-filter:blur(20px)`。

---

## 三、Settings 导航 → Radix Tabs

安装：`npm install @radix-ui/react-tabs`

删手写 NAV，改 Radix：

```tsx
import * as Tabs from '@radix-ui/react-tabs'

<Tabs.Root defaultValue="global">
  <Tabs.List className="settings-tabs">
    <Tabs.Trigger value="global">全局</Tabs.Trigger>
    <Tabs.Trigger value="cc">中控区</Tabs.Trigger>
    <Tabs.Trigger value="terminal">终端</Tabs.Trigger>
    <Tabs.Trigger value="sidebar">左栏</Tabs.Trigger>
    <Tabs.Trigger value="right">右栏</Tabs.Trigger>
  </Tabs.List>
  <Tabs.Content value="global">...</Tabs.Content>
  ...
</Tabs.Root>
```

删 `Session` 标签（入口在侧栏）。删 `Agent` 标签（合并到全局的 Agent 选择）。

---

## 四、ECG 波形重写

### 4.1 非对称 P-QRS-T

`Math.sin(t * PI)` → `Math.pow` 不对称曲线：

```typescript
case 'p': y = mid - Math.pow(t,2) * Math.pow(1-t,0.6) * amp * 0.8; break
case 'r':
  if (t<0.5) y = mid + t*2*amp*2.0
  else       y = mid + (1-t)*2*amp*1.6
  break
case 't': y = mid - Math.pow(t,0.7)*Math.pow(1-t,1.5)*amp*1.2; break
```

### 4.2 R-R 间期调制

每个心跳的 cycleW 不同：

```typescript
const rri = Math.sin(ci * 0.7 + tick * 0.015) * 12
const cycleW = baseCycleW + rri
```

### 4.3 行波——只渲染 [0, W]

offset 永续增长，不模运算。`wave()` 用 `hash(ci)` 替代 `Math.random()`：

```typescript
function hash(seed: number): number {
  return ((Math.sin(seed * 127.1) * 43758.5453) % 1 + 1) % 1
}
```

只算 `firstCycle` 到 `lastCycle` 内 x ∈ [0, W] 的点。点数恒 ~400，不受 offset 增长影响。

### 4.4 端点

定端点双竖线（间距 3px，高 ±10px），动端点单竖线（±10px），基线 5px。分段噪声不变。

---

## 五、字体栈 + 渲染

`src/index.css`：

```css
--mono: 'Cascadia Code', 'Consolas', 'JetBrains Mono', monospace;
```

`ChatView.css` `.term` 加：

```css
-webkit-font-smoothing: antialiased;
text-rendering: optimizeLegibility;
font-kerning: none;
```

---

## 六、中控区背景色

store 加 `ccBg: string`，DEFAULTS 设 `'transparent'`。App.tsx cssVars 加 `'--cc-bg': theme.ccBg`。

---

## 七、Spinner 增强

store 新增字段：

```typescript
spinnerColor: string   // 默认 'var(--text-dim)'
spinnerSize: number    // 默认 14
sparkles: string       // 已有，加预制选项
```

Settings → 终端 → 工具，`sparkles` 从 `Txt` 改为 `Sel` + 自定义：

| 值 | 标签 | 字符集 |
|:--|:--|:--|
| `'✳✴✵✶✷✸✹✺✻✼❃❊'` | 星芒 | 当前默认 |
| `'◴◷◶◵'` | 转弧 | 经典 loading |
| `'·○◎●◉◎○'` | 脉冲 | 心跳呼吸 |
| `'←↖↑↗→↘↓↙'` | 指针 | 旋转箭头 |
| `'▖▗▘▝▗▖▝▘'` | 棋盘 | 四角轮转 |
| `'▁▂▃▄▅▆▇█▇▆▅▄▃'` | 水滴 | 涨落 |
| `'┌┐┘└'` | 断框 | 逆时针画框 |
| `'⠁⠂⠄⡀⢀⠠⠐⠈'` | 点阵 | Braille |
| custom | 自定义 | Txt 输入 |

新增 Row：

```tsx
<Row label="Spinner 颜色"><Swatch value={t.spinnerColor} onChange={v=>u({spinnerColor:v})}/></Row>
<Row label="Spinner 大小"><Num value={t.spinnerSize} onChange={v=>u({spinnerSize:v})} min={10} max={32}/></Row>
```

App.tsx cssVars 加：

```typescript
'--spinner-color': theme.spinnerColor || undefined,
'--spinner-size': `${theme.spinnerSize || 14}px`,
```

ChatView.css：

```css
.term-spinner { color: var(--spinner-color, var(--text-dim)); font-size: var(--spinner-size, 14px); }
```

---

## 八、安装依赖

```bash
npm install @radix-ui/react-tabs @radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-tooltip
```

---

## 九、预设系统

每区独立预设。3 内置（不可删）+ 用户自定义（可重命名/删除）。

### 9.1 Store

```typescript
// store.ts 新增
presets: Record<string, { name: string; colors: Record<string,string>; fonts: Record<string,string|number> }[]>
activePreset: Record<string, string>  // area → preset name

// DEFAULTS 里 7 个区的 3 内置预设
// presets.terminal: [Terminal Light, Terminal Dark, Dracula]
// presets.cc:       [Glass, Dark Glass, Clear]
// ...每区有自己的内置
```

### 9.2 流程

1. 选预设 → 批量覆盖该区 colors + fonts → activePreset[name]
2. 手动改任何值 → activePreset 自动切 "Custom"
3. 点 [▼ 保存为预设] → 弹窗输入名字 → push 到 presets[area]
4. 右键预设名 → 重命名 / 删除

### 9.3 组件

```tsx
// PresetRow — 每区复用
function PresetRow({ area, options, active, onSelect, onSave, onDelete, onRename }) {
  return (
    <Row label="配色方案">
      <Sel value={active} options={options} onChange={onSelect} />
      <button onClick={onSave}>保存</button>
    </Row>
  )
}
```

7 区各一行 `<PresetRow>`。~200 行 JSX + 60 行 store。

### 9.4 各区内置预设

| 区 | 预设 1 | 预设 2 | 预设 3 |
|:--|:--|:--|:--|
| 终端 | Terminal Light | Terminal Dark | Dracula |
| 左栏 | 跟随终端 | 暗色 | 透明 |
| 右栏 | 跟随终端 | 暗色 | 透明 |
| 中控区 | 玻璃态 | 暗色 | 透明 |
| 输入栏 | Light | Dark | Glass |
| 状态栏 | Light | Dark | Glass |
| 应用（原全局） | Light | Dark | Sepia |

---

## 十、每区背景图（修正：应用背景合并）

删 `globalBgImage`——跟 `appBg` 合并。**.app** 统一作为应用最外层背景：

```
背景色    [■]    整个应用底色
背景图    [拖拽]  叠在底色上
适应模式  [▾ cover]
透明度    [═══○]
模糊      [═══○]
```

store 改：`globalBgImage` → `appBgImage`，新增 `appBg`。App.css `.app` 加 `background: var(--app-bg); background-image: var(--app-bg-image)`。删 index.css body 上的 `--global-bg-image`。

其余区保持不变：

当前部分区缺背景图入口。补齐：

| 区 | 字段 | 当前 |
|:--|:--|:--|
| 应用 | `appBgImage`（替换 globalBgImage） | 合并为 `.app` 统一背景 |
| 终端 | `chatBgImage` | 缺拖拽 |
| 左栏 | `sidebarBgImage` | 缺拖拽 |
| 右栏 | `rightBgImage` | 缺拖拽 |
| 中控区 | `ccBgImage`（新增） | 缺。统一覆盖输入栏+状态栏 |
| 输入栏 | — | 不独立设，跟中控区 |
| 状态栏 | — | 不独立设，跟中控区 |

每区再加适应模式 `fit: 'cover' | 'contain' | 'stretch' | 'tile'`，加 `bgFit` 字段或复用全局的。

---

## 给 coder

1. 标题栏重构 + 删浮动按钮 → commit 1
2. Settings overlay + Radix Tabs → commit 2
3. ECG 重写 → commit 3
4. 字体 + 中控背景 + 背景图补齐 → commit 4
5. Spinner 增强 → commit 5
6. 预设系统 + PresetRow 组件 → commit 6
7. Radix Dialog/Dropdown/Tooltip 后续接入
8. Agent 标签重设计 + 会话工作目录修复 → commit 7
9. 不 build

---

## 十一、Agent 标签重设计

当前只显示当前 agent 名 + 切换按钮。改为 CRUD：

| 参数 | 必填 | 默认 | 说明 |
|:--|:--|:--|:--|
| name | ✅ | — | Agent 显示名 |
| exe | ✅ | — | 可执行文件路径 |
| transport | ❌ | subprocess | 传输方式 |
| args | ❌ | ["acp"] | 命令行参数 |
| cwd | ❌ | "." | 默认工作目录 |
| env | ❌ | {} | 环境变量 |

agents.yaml 作为出厂预设。用户自定义 agent 存 localStorage `pylon-agents`。前端合并显示。

`new_session` 签名加 `cwd: Option<String>`——有则用会话级 workdir，无则用 agent 默认。当前会话级 workdir 已存 localStorage 但未传给 Rust。

## 十二、ACP 协议说明书

`ACP-SPEC.md` — 传输层、初始化、会话生命周期、通知变体、内容块、工具调用、Pylon 兼容性矩阵。
