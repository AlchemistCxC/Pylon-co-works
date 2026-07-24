# Prism Desktop V5 设计书 — UI 完善 + 图标 + 心电图增强

> 给 coder。13 项需求。按优先级分三组。

---

## 一、Bug 修复（P0）

### 1.1 应用图标不生效

`src-tauri/icons/icon.ico` 存在但 exe 不显示。`tauri_build::build()` 默认只在 `tauri.conf.json` 里配了 `bundle.icon` 时才嵌入。

`tauri.conf.json` 加：

```json
"bundle": {
  "icon": ["icons/icon.ico"]
}
```

或者确认 icons 目录在 tauri.conf.json 同级的正确位置。re-build 后 exe 和标题栏会有图标。

### 1.2 全屏不生效

`toggleMaximize()` 是最大化，不是全屏。加真正的全屏：

```tsx
// App.tsx — 标题栏按钮或双击标题栏
<button onClick={() => appWindow.setFullscreen(true)}>⛶</button>
```

需要 `core:window:allow-set-fullscreen` 权限加到 `capabilities/default.json`。

### 1.3 回到底部按钮 UI 错位

`ChatView.css` 的 `.scroll-bottom-btn` 需要固定定位：

```css
.scroll-bottom-btn {
  position: fixed; bottom: 100px; right: 24px;
  width: 36px; height: 36px; border-radius: 50%;
  background: var(--bg-panel); border: 1px solid var(--border);
  color: var(--text-dim); cursor: pointer; z-index: 10;
  display: flex; align-items: center; justify-content: center;
  font-size: 16px;
}
```

### 1.4 左侧栏折叠按钮不可见

折叠按钮（`▸/▾`）已存在但用户没注意到。需要更显眼——改成图标或者移到 profile bar 上面。或者当 collapsed 时侧栏只显示 48px 宽的竖条，中间放展开按钮。

---

## 二、心电图增强（P0）

### 2.1 行波循环

当前 `wave()` 函数从 `ci=-2` 开始生成点，但 `offset` 模运算导致每帧位移很小，看起来像原地振动。改为真正的行波——让波形从右向左流动，左侧新波形持续进入：

```typescript
const wfAnimated = useMemo(() => {
  // 生成足够长的波形（3×W），然后取 offset 偏移后的窗口
  const full = wave(W * 3, H, intensity, 0, ampMax, speedMax)
  // offset 在 [0, W) 循环，取 [offset, offset+W] 窗口
  // 实际做法：在 wave() 内部用 offset 参数平移所有点的 x
  return wave(W, H, intensity, offset % W, ampMax, speedMax)
}, [intensity, tick, ampMax, speedMax])
```

关键：`offset` 每 tick 增加 `offsetSpeed`，模 `W`。波形从右侧流出、左侧进入。

### 2.2 随机变化

在 ECG 各段的 y 值上加 `Math.random() * noiseScale` 微扰动。噪声强度根据上下文使用量：

```typescript
const noiseScale = 0.1 + intensity * 0.5  // 0.1 → 0.6
// 在 wave() 中每个点
y += (Math.random() - 0.5) * 2 * noiseScale
```

`useMemo` 依赖 `tick` 所以每帧重新生成——噪声自然变化。

### 2.3 上下文信息不生效

验证 `usage_update` 数据链路：

1. `ChatView.tsx` L152-162 — 是否有 `console.log` 输出？（之前删了 debug log）
2. 加回来验证：`console.log('[usage_update]', upd.value, upd.size, upd._meta)`
3. 检查 `setLiveStats` 是否调用
4. 检查 StatusBar props `tokensUsed/tokensMax` 是否在更新

如果没有 `usage_update` 事件到达 → Peri 没发 → 检查 Peri 版本。

---

## 三、UI 完善（P1）

### 3.1 面板透明度/模糊可调

Settings → 全局外观 → 已有 `--t`（透明度）和 `--blur`（模糊）。为三个面板单独加：

```typescript
// ThemeSettings 新增
sidebarTransparency: number   // 默认 1
sidebarBlur: number           // 默认 0
chatTransparency: number      // 默认 1
chatBlur: number              // 默认 0
rightTransparency: number     // 默认 1
rightBlur: number             // 默认 0
```

CSS：

```css
.sidebar {
  opacity: var(--sidebar-transparency, 1);
  backdrop-filter: blur(var(--sidebar-blur, 0px));
}
```

### 3.2 状态栏重新排布

当前顺序：`[SVG] [pct] [tokens] [hit] [agent] [Prism] [model] [mode]`

问题：`[model]` 和 `[mode]` 靠右但 `agent` 混在中间，`Prism` 按钮意义不明。

改为：

```
[SVG] [pct] [tokens]  |  [agent] [model] [mode]  |  [Prism ON/OFF]
```

使用 `margin-left: auto` 或 `flex: 1` 分离左右组。agent/model/mode 归一组。

### 3.3 侧栏搜索/按钮突兀

当前侧栏顶部有 `[搜索框] [+ 新建] [▾ 折叠]` 三个挤在一起。改为：

```
[▸ 折叠] [搜索框.....................] [+]
```

折叠按钮放在最左边。新建按钮移到搜索结果区域或者变成底部 profile bar 的一部分。

### 3.4 删除会话防误触

当前 hover 显示 `✕`，单击直接删。改为：

```tsx
// 双击 ✕ 才删除，或者弹出确认
<button onClick={e => {
  e.stopPropagation()
  if (confirm('删除会话？')) handleDelete(s.id)
}}>✕</button>
```

或者改为右键菜单。

### 3.5 工具链竖线连接

ToolCard 之间用竖线连接 `●` 指示器：

```css
.term-tool + .term-tool::before {
  content: '';
  position: absolute;
  left: 3px;  /* 对齐 ● 的圆心 */
  top: -8px;
  bottom: 50%;
  width: 2px;
  background: var(--border);
}
```

每个 `●` 下方有竖线连接到下一个 `●`，形成工具调用链的视觉线索。

### 3.6 自定义 Spinner 和 Tool 指示器

Settings → 工具颜色 → 新增：

```
Row label="指示器形状" Sel value={t.toolIndicator} options={['●','◆','■','▲','▶']}
Row label="指示器颜色" Swatch value={t.toolOk}  // 已有
```

Spinner 火花字符可自定义：

```typescript
sparkles: string   // 默认 '✳✴✵✶✷✸✹✺✻✼❃❊'，用户可输入自定义字符集
```

---

## 四、自定义增强（P2）

### 4.1 自定义用户 ID 和颜色

Sidebar 底部或 Settings → 终端 section 新增：

```
Row label="用户显示名" Txt  // 替换 source ID
Row label="用户名前缀" Txt  // 默认 '❯'
Row label="用户名颜色" Swatch
```

store.ts 加 `userName: string, userPrefix: string, userColor: string`。

`UserLine` 组件从 store 读取而非从 `getUser(source)` —— 当后端没给真实用户名时用自定义值。

### 4.2 会话列表增强

当前只显示 `session.name` 和 `source`。加：

```
[会话名]
session-abc123            ← 原样
3h ago · 12 messages      ← 时间 + 消息数
```

Session 接口加 `msgCount: number`，ChatView 每次 add message 时更新。

### 4.3 设置不全面

Settings → 新增分类 "消息栏"：

```
Row label="消息栏风格"   Sel options=['terminal','bubble']
Row label="消息栏字体"   Sel options=['mono','system']
Row label="AI 文字颜色"  Swatch
Row label="行间距"       Num
```

---

## 五、给 coder 的话

1. P0 组（图标/全屏/折叠/心电图/上下文）必须修。
2. P1 组选 3 项先做。
3. 每完成一组 commit。不 build。

---

## 六、追加：文件上传与长文本压缩（P1）

### 6.1 当前问题

`InputBar.tsx` attachFile 把文件内容读出来塞进 textarea 代码块。大文件截断到 512KB。
问题：① 文件路径信息丢失 ② 大文本撑爆输入框 ③ 不是"上传"语义——是"复制粘贴"。

### 6.2 改为引用式附件

不读内容。只记文件路径和元信息，发送时单独传递：

```typescript
interface AttachedFile {
  path: string
  name: string
  size: number
  mime?: string
}

const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
```

发送时把文件列表作为额外参数传给 `send_message`（Rust 端读文件并注入 prompt）。ACP 协议支持 `ResourceContentBlock`（Hermes 有，Peri 大概率也支持）。

最低实现：Rust `send_message` 接受 `attachments: Vec<String>`（文件路径列表），在 user message 前拼 `[Attached: file1.txt (12KB)]` 标记，实际内容由 Peri 侧读。

### 6.3 长文本自动压缩

当输入框内容超过阈值（默认 4000 字符），发送前弹提示：

```
"消息较长（4,200 字符）。是否压缩为 .txt 附件发送？"
[作为文本发送] [压缩为附件] [取消]
```

"压缩为附件"：把文本写入临时文件，发送时作为文件附件传递。

```typescript
const LONG_TEXT_THRESHOLD = 4000

const send = async () => {
  const text = value.trim()
  if (text.length > LONG_TEXT_THRESHOLD && attachedFiles.length === 0) {
    // 弹确认
    const compress = await confirm('压缩为附件？')
    if (compress) {
      // 写入临时 .txt，加入 attachedFiles
    }
  }
  // ...
}
```

### 参考

- `InputBar.tsx` L98-110 — 当前 attachFile
- `lib.rs` L39-45 — send_message 签名
- Hermes ACP ResourceContentBlock: `F:\Hermes\hermes-agent\acp_adapter\server.py` L216-312
