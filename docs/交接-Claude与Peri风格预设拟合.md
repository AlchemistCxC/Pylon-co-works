# Claude + Peri 风格预设拟合交接

> 项目：Pylon / Prism Desktop
> 路径：`G:\Project\prism-desktop`
> 文档类型：前端视觉/交互交接，不是实现记录
> 编写基线：2026-07-30
> 当前职责：下一位前端 Coder 接管实现

## 1. 任务目标

在保留 Pylon 现有自定义框架的前提下，把其中一套预设拟合为“Claude + Peri”风格。

这不是把 Pylon 改成固定不可配置的 Claude Code 仿品，也不是删除 Control Center 的 Widget、slot、position、scale、variant、preset、custom preset 能力。

目标是：

- 保留 Pylon 的高度自定义能力。
- 默认参数、视觉层级、信息排列、输入区和状态区拟合 Claude Code + Peri TUI。
- 用户仍可以继续调整中控控件、颜色、字号、布局、隐藏项和其他预设。
- 不修改后端，不碰 `src-tauri/`。
- 预设名称从当前 `Claude Code` 改为 `Claude 风格`。
- 内部稳定 ID 建议继续保留 `claude`，避免破坏已有 localStorage、custom preset、migration 和代码判断。

## 2. 重要范围判断

当前 Pylon 的自定义框架本身不是问题，不应重写为固定布局。

现有框架已经提供：

- `ControlCenter` Widget registry。
- `ccLayout`、slot、order、offset、scale。
- `ccHidden`、`ccVariant`、`ccStyle`。
- 全局预设、zone preset、custom preset。
- CLI 输入模式和独立命令提示。
- Right Panel 独立 overlay。

本任务应做“默认参数与渲染层级拟合”，而不是移除这些能力。

## 3. 参考真值

### 3.1 Claude Code 源码

用户提供的源码镜像：

`https://github.com/DURUII/claude-code-sourcemap/tree/main/restored-src`

已将源码拉取到项目内部，后续优先读取本地副本，避免反复查询 GitHub：

`G:\Project\prism-desktop\references\claude-code-sourcemap\restored-src\src`

本地副本当前 Git HEAD：

```text
063df9298dcd99b1823fdfe1f89ccf123d238464
```

本地副本使用 sparse checkout，仅保留 `restored-src/src`；仓库元数据仍位于：

`G:\Project\prism-desktop\references\claude-code-sourcemap\.git`

如需更新源码，进入该目录执行：

```bash
git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 pull --ff-only
git sparse-checkout set restored-src/src
```

本地副本是只读参考资产，不属于 Pylon 业务源码；禁止在其中实现功能或提交修改。

本轮已经通过 GitHub API 读取的关键文件：

- `restored-src/src/components/PromptInput/PromptInput.tsx`
- `restored-src/src/components/PromptInput/PromptInputFooter.tsx`
- `restored-src/src/components/PromptInput/PromptInputFooterLeftSide.tsx`
- `restored-src/src/components/PromptInput/PromptInputModeIndicator.tsx`
- `restored-src/src/components/BaseTextInput.tsx`
- `restored-src/src/components/Message.tsx`
- `restored-src/src/components/messages/UserPromptMessage.tsx`
- `restored-src/src/components/messages/AssistantTextMessage.tsx`
- `restored-src/src/components/messages/AssistantToolUseMessage.tsx`
- `restored-src/src/components/messages/AssistantThinkingMessage.tsx`
- `restored-src/src/components/MessageResponse.tsx`
- `restored-src/src/components/StatusLine.tsx`
- `restored-src/src/components/design-system/Byline.tsx`
- `restored-src/src/components/design-system/KeyboardShortcutHint.tsx`
- `restored-src/src/utils/theme.ts`

Claude Code 暗色主题关键 token：

```text
text                 rgb(255,255,255)  #FFFFFF
inactive             rgb(153,153,153)  #999999
subtle               rgb(80,80,80)      #505050
promptBorder         rgb(136,136,136)  #888888
claude               rgb(215,119,87)    #D77757
success              rgb(78,186,101)    #4EBA65
error                rgb(255,107,128)   #FF6B80
warning              rgb(255,193,7)     #FFC107
permission           rgb(177,185,249)   #B1B9F9
userMessageBackground rgb(55,55,55)     #373737
```

Claude Code 的字体是终端继承字体，没有网页像素字号。Pylon 映射建议：

```text
聊天正文、用户消息、Assistant、Tool：15px monospace
InputBar 正文：15px monospace
Footer / 状态 / 快捷键：14px monospace
Sidebar 等外围区域：保留 Pylon 当前字号，不强行改成 Claude Code
```

### 3.2 Peri TUI 源码

路径：`F:\A-I\Agent\Peri`

关键文件：

- `peri-tui/src/kit/input_area.rs`
- `peri-tui/src/kit/status_bar.rs`
- `peri-tui/src/kit/layout.rs`
- `peri-tui/locales/zh-CN/main.ftl`
- `peri-theme/themes/dark.json`
- `peri-theme/src/builtin.rs`

Peri 输入区真值：

```text
上边框
 ❯ 输入内容
下边框
状态信息
快捷键提示
```

Peri 的输入区使用一个 composer block，概念上是：

```rust
Block::default().borders(Borders::TOP | Borders::BOTTOM)
```

不是两个会脱离内容布局的装饰线。

Peri 状态栏真值：

- Row 1：权限模式、cwd、provider/model、资源状态、后台任务、上下文使用。
- Row 2：右对齐快捷键提示。
- 宽屏左右分布，窄屏纵向收敛。
- 主提示文案：`/: 命令 | Shift+Enter: 换行 | Shift+Tab: 模式`。

截图事实：

- 截图路径：`C:\Users\AlchemistCxC\Desktop\O~}]JGCOI1D{_E64~%{%5TT.png`
- 尺寸：1129×635。
- 两条横线包住输入区，而不是把命令提示拆成两行。
- 第一条横线约在 y=495，第二条约在 y=533。
- 横线左右有约 16px 内缩。
- 输入 prompt 与左侧状态从约 26px 开始。
- 第二条横线之后才是状态/信息区域。
- 命令提示为一整行，靠右排列。

## 4. 当前实现基线

当前 HEAD：

```text
5ffdf69 feat: 重做前端预设与命令提示布局
```

该 commit 已提交一批前端预设与 Settings 改动，但之后工作区仍有未提交前端改动，且同时存在后端/文档外部改动。

当前与本任务直接相关的未提交前端文件：

- `src/App.tsx`
- `src/components/ControlCenter.tsx`
- `src/components/ControlCenter.css`
- `src/components/chat/InputBar.css`
- `src/presets.ts`
- `scripts/test-control-center-responsive.mts`
- `scripts/test-preset-design.mts`

当前工作区还有不属于本任务的改动，接手时必须保留：

- `src-tauri/**`
- `docs/功能开发清单（后端）.md`
- `docs/验收清单.md`
- `docs/视觉重整.md`
- `src-tauri/loader-error.txt`

禁止使用 `git add .`、`git add -A`、reset、restore、stash、clean 覆盖或吞掉这些改动。

### 当前未提交改动的事实

当前曾尝试过以下方向，但不要直接视为最终设计：

- 通过 `rightOpen/rightWidth` 给 ControlCenter 注入 `--cc-right-inset`，避免 Right Panel 覆盖底部内容。
- CLI 输入行使用独立 `border-top` / `border-bottom`，并增加 `box-sizing:border-box`。
- CLI 模式中控最小高度被提高到 96px，试图避免双横线被 `overflow:hidden` 裁剪。
- 命令提示已恢复为单行：`/: 命令 | Shift+Enter: 换行 | Shift+Tab: 模式`。
- 其他预设的中控高度、字号、CLI line width/padding 已被统一调整为更紧凑的终端参数。

这些是问题排查过程中的工作区状态，不代表已经完成 Claude + Peri 拟合。下一位必须基于当前源码和浏览器 DOM 重新收敛，不得只沿用历史描述。

## 5. 已确认的 Claude Code 信息栏规律

### 5.1 用户消息

Claude Code `UserPromptMessage.tsx`：

```tsx
<Box
  flexDirection="column"
  marginTop={addMargin ? 1 : 0}
  backgroundColor="userMessageBackground"
  paddingRight={1}
>
  <HighlightedThinkingText ... />
</Box>
```

视觉结论：

- 用户消息可使用整行灰色背景 `#373737`。
- 不需要圆角气泡。
- 不需要卡片描边。
- 消息之间用一行间距。
- `>` 作为用户消息前缀是允许的产品选择，但应由 Pylon 的 `msgStyle` / preset 参数控制，不能硬编码所有主题。
- Claude Code 源码本身不要求 Pylon 删除用户消息前缀自定义能力。

### 5.2 Assistant 消息

Claude Code Assistant 文本使用：

- 左侧可选状态点，约 2ch 固定空间。
- Markdown 正文从统一列开始。
- 不使用大卡片背景。
- 不显示固定的 Assistant 标签或头像。
- 消息之间留一行。
- 正文为高对比主文本，约等于 Pylon 15px monospace。

### 5.3 Tool 信息

Claude Code 工具调用头的排列：

```text
状态点/Spinner + 粗体工具名 + 紧随其后的括号摘要
```

示例：

```text
● Read (src/main.ts)
● Edit (src/App.tsx)
```

约束：

- 工具名粗体。
- 摘要紧跟工具名，不要把工具名和摘要分别推到左右两端。
- 工具标题一行内排列，尾部允许 truncate。
- 未完成/等待权限/分类器检查等状态使用 dim 文本。
- 工具详细输出可在下方展开，但不应默认变成厚重卡片。
- Pylon 现有 tool connector、tool indicator、summary、output、collapse 能力必须保留。

### 5.4 Thinking

Claude Code 使用：

```text
∴ Thinking…
```

样式：

- dim。
- italic。
- 展开正文左缩进约 2ch。
- 标题与正文之间约一行间距。
- 不使用醒目的卡片边框。

Pylon 现有 reasoning/spinner/custom marker 能力继续保留，默认视觉应拟合这个层级。

### 5.5 Footer / 信息栏

Claude Code `PromptInputFooter.tsx` 与 `PromptInputFooterLeftSide.tsx`：

宽屏：

```text
左侧：StatusLine / 权限模式 / 后台任务
右侧：Notifications / Bridge 状态
```

对应 Ink 结构：

```tsx
<Box
  flexDirection="row"
  justifyContent="space-between"
  paddingX={2}
  gap={1}
>
```

窄屏：

```text
flexDirection="column"
justifyContent="flex-start"
```

分隔符来自 `Byline.tsx`：

```tsx
<Text dimColor> · </Text>
```

不是把每个状态都放进 pill，也不是强制用竖线分隔。

快捷键提示来自 `KeyboardShortcutHint.tsx`：

```text
? for shortcuts
esc to interrupt
shift+tab to cycle
ctrl+t to toggle tasks
```

Claude Code 默认 Footer 不等于固定显示 Peri 中文主提示；本项目的目标是 Claude + Peri，因此建议：

- 保留 Peri 的中文主提示能力。
- 采用 Claude Code 的 Footer 层级和动态状态切换。
- `full` 模式显示完整 Peri 文案。
- 生成中根据状态显示停止/取消提示。
- 空闲无额外状态时允许显示 `? for shortcuts` 风格的短提示。
- 不把固定提示拆成两行；两行应由“状态 Row 1 + 快捷键 Row 2”组成。

## 6. 预设命名方案

### 6.1 稳定 ID

保持：

```ts
name: 'claude'
```

原因：

- 旧 localStorage 可能保存 `activePreset: 'claude'`。
- 自定义 preset、migration、测试和代码可能依赖内部 ID。
- 这次只是显示名重命名，不应制造迁移风险。

### 6.2 显示名

将：

```text
Claude Code
```

改为：

```text
Claude 风格
```

建议测试断言同步更新，但不要把内部 name 改成中文。

### 6.3 其他预设

本任务不要求删除 Glass Light、Nord Frost、Tokyo Night、Solarized Light、Amber CRT。

它们应继续作为自定义框架的对照预设存在。后续若要更名，必须另开产品决策，不要在本任务里顺手改掉所有 preset ID。

## 7. 推荐实现任务拆分

### C-PRESET-01：预设显示名与稳定 ID

目标：显示名改为 `Claude 风格`，内部 ID 仍为 `claude`。

允许读取：

- `src/presets.ts`
- `src/customPresets.ts`
- `src/store.ts`
- `scripts/test-preset-design.mts`
- 所有 preset selector/render 入口

允许修改：

- `src/presets.ts`
- 直接断言 preset label 的前端测试

禁止：

- 修改后端。
- 删除旧 ID migration。
- 大范围重命名其他 preset。

完成标准：

- UI 显示 `Claude 风格`。
- `name: 'claude'` 保持。
- 旧持久化 `activePreset: 'claude'` 仍能应用。
- 测试不再硬编码旧显示名。

### C-INFO-02：消息文本层级拟合

目标：在保留现有 Tool/Markdown/Spinner/Connector 自定义能力的情况下，默认拟合 Claude 信息排列。

重点读取：

- `src/components/chat/ChatView.tsx`
- `src/components/chat/ChatView.css`
- `src/components/chat/GenerationFooter.tsx`
- `src/components/chat/StatusBar.tsx`
- `src/components/chat/StatusBar.css`
- `src/components/chat/ToolCallView.tsx`（若当前存在）
- `src/store.ts` 中 msg/tool/connector 字段
- Claude Code 的 `Message.tsx`、`UserPromptMessage.tsx`、`AssistantTextMessage.tsx`、`AssistantToolUseMessage.tsx`、`AssistantThinkingMessage.tsx`

目标参数/结构：

- 正文 15px monospace。
- Assistant 无厚重默认卡片。
- 用户消息允许 `>` 前缀，作为 preset 可配置项保留。
- 用户背景默认为 Claude 风格 `#373737`，但仍走现有 `userTagBg` / `msg` token 链路。
- Tool 标题默认状态点 + 粗体工具名 + 括号摘要。
- Tool 输出、折叠、connector、错误色和运行态继续由 Pylon 自定义字段控制。
- Thinking 默认 dim italic，标题/正文间距接近 Claude。
- 消息块之间使用一行级别间距，不叠加多层 card padding。

不要：

- 删除现有 Tool 状态机。
- 删除 Markdown sanitizer/highlight。
- 把所有主题强行变成黑底。
- 把 `>` 写死在 ChatView 里。

完成标准：

- Claude 风格默认值接近 Claude Code，但自定义 preset 能覆盖。
- A/B session 的消息状态和现有事件路由不变。
- 纯 CSS/结构测试覆盖默认 class、token 消费和排列边界。

### C-FOOTER-03：状态栏与快捷键信息层级

目标：把当前 Control Center 的信息区改成 Claude + Peri 的 Footer 层级，不删除 Widget 框架。

重点读取：

- `src/components/ControlCenter.tsx`
- `src/components/ControlCenter.css`
- `src/components/chat/StatusBar.tsx`
- `src/components/chat/StatusBar.css`
- `src/components/chat/InputBar.tsx`
- `src/components/chat/InputBar.css`
- Claude Code `PromptInputFooter.tsx`
- Claude Code `PromptInputFooterLeftSide.tsx`
- Peri `status_bar.rs`

目标结构：

```text
上：InputBar composer（上下双横线包住）
下：Footer Row 1 + Row 2
  Row 1：左侧状态/模式/模型/Token，右侧通知/扩展状态
  Row 2：右对齐快捷键提示
```

注意：

- `/: 命令 | Shift+Enter: 换行 | Shift+Tab: 模式` 是一整行。
- 不要把这句文案拆成两行。
- 双横线属于 InputBar 自身的 composer shell，不属于 Footer。
- 右栏打开时，Footer 和 InputBar 都要通过真实可测的 content inset 避让 Right Panel。
- 不要只移动 `.cc-command-hint`，否则其他状态仍会被右栏覆盖。
- 状态分隔符优先使用 ` · `，不要默认每个 widget 加 pill。
- 宽屏左右分布，窄屏纵向收敛。

完成标准：

- 浏览器 DOM 中 InputBar 上/下 border 均可见且位于 Control Center 内容盒内。
- Footer 命令提示单行、右对齐，位于第二条横线下方。
- Right Panel 打开时无遮蔽。
- Widget 仍可隐藏、拖动、调整 slot/order/scale。
- 自定义 `ccLayout` 不会因默认 Claude 布局被覆盖。

### C-PRESET-04：Claude 风格默认参数

目标：把 Claude + Peri 的视觉参数集中到 `claude` 预设，其他 preset 不强制继承。

建议默认值，不是硬编码强制值：

```ts
label: 'Claude 风格'
uiScheme: 'dark'
globalBgColor: '#000000'
chatBg: '#000000'
chatTextColor: '#FFFFFF'
chatFont: 'mono'
chatFontSize: 15
chatLineHeight: 1.5
msgFont: 'mono'
msgTextColor: '#FFFFFF'
msgLineHeight: 1.5
userTagBg: '#373737'
userTagText: '#FFFFFF'
toolSummaryColor: '#999999'
toolConnectorColor: '#505050'
inputFontSize: 15
cliLineWidth: 1
cliLineColor: '#888888'
cliTextColor: '#FFFFFF'
cliPromptColor: '#999999'
cliLinePadding: 3
cliContentOffsetY: 0
cliHintMode: 'full'
ccStatusFontSize: 14
```

注意：

- 目前 `ccHeight: 96` 是为当前 DOM 结构临时避免裁剪的参数，不能单独当作 Claude 真值。
- 最终高度应在完成 Footer/InputBar 结构收敛后，通过浏览器几何重新确定。
- 不能用一个固定 `min-height:96px` 作为所有 preset 的普遍规则。
- Claude Code 的 prompt border token 更接近 `#888888`，不要继续把 `#999999` 当作唯一真值。

### C-VERIFY-05：浏览器视觉与几何验收

目标：用真实浏览器 DOM 验证 Claude 风格，而不是只跑源码字符串测试。

必须覆盖：

1. Claude 风格预设应用后：
   - `.control-center`
   - `.cc-body`
   - `.cc-input-slot`
   - `.input-bar.cli-mode`
   - `.input-row`
   - `.cli-prefix`
   - `.input-textarea`
   - `.cc-status-row`
   - `.cc-command-hint`
2. `getBoundingClientRect()`：
   - 输入区上/下 border 是否均在 Control Center 内容盒内。
   - Footer 是否在第二条 border 下方。
   - 命令提示是否保持单行。
   - 右栏打开前后 content width/inset 是否正确。
3. `getComputedStyle()`：
   - border-top/border-bottom。
   - prompt/text color。
   - font-family/font-size/line-height。
   - user/tool/thinking token 消费。
   - overflow、box-sizing、flex/grid 关系。
4. 状态场景：
   - 空闲。
   - 输入文本。
   - 多行输入。
   - command palette 打开。
   - 生成中。
   - Right Panel 打开。
   - 窄窗口。
   - 预设切换后回到 Claude 风格。

浏览器缺少 Tauri runtime 的 `invoke/listen` 报错必须单独记录为环境边界，不能归因视觉组件。

## 8. 当前未解决问题

- 当前未提交 CLI/Control Center 改动仍是排查过程中的混合状态，必须先以浏览器 DOM 重新确认，再决定保留哪些。
- Claude Code 双横线不能继续靠单纯提高 `ccHeight` 解决；应该让 InputBar 自身成为 composer shell，并自然参与 Control Center 布局。
- 当前 Pylon 命令提示曾被错误拆成两行；目标应恢复为单行提示。
- Right Panel 是绝对定位 overlay，当前需要统一的 bottom content inset，不能只给某个 hint 加 padding。
- 现有 `test-control-center-responsive.mts` 是字符串结构测试，不能替代浏览器几何验收；后续应增加或更新独立浏览器证据脚本。
- 现有 `test-preset-design.mts` 仍断言旧 preset label 和当前临时参数，预设重命名/默认参数收敛后需要同步更新。
- 当前前端任务清单已经把 Control Center 标为“已实现，布局旧断言需清理”，本任务完成后应追加 Claude + Peri 拟合状态，不要把已有 P0/P1 运行时待验收改成已完成。

## 9. 工作边界与验证纪律

- 只修改 `src/`、允许的 `scripts/`、本交接文档；禁止修改 `src-tauri/`。
- 开工先重新执行：

```bash
git status --short --branch
git diff --stat
git diff -- src/App.tsx src/components/ControlCenter.tsx src/components/ControlCenter.css src/components/chat/InputBar.css src/presets.ts
```

- 不得直接相信本交接文档中的旧行号或旧验证输出。
- 任何后台 worker 结果都必须重新读取实际文件并检查限定 diff。
- 修改共享 `ControlCenter.tsx`、`store.ts`、`presets.ts` 时串行处理。
- 每个独立根因单独验证，不要把视觉、消息结构、预设命名和 Right Panel inset 混成不可回滚的大改动。
- 先完成源码闭环，再执行专项 Node 测试、`npm run build`、限定 `git diff --check`。
- 源码、测试或本交接文档再次 patch 后，之前验证证据全部视为 stale，必须最后重新执行。
- 未经用户明确授权，不 commit。

## 10. 建议交付顺序

```text
C-PRESET-01  预设显示名改为“Claude 风格”，保留内部 ID
C-INFO-02    用户/Assistant/Tool/Thinking 信息层级默认拟合
C-FOOTER-03  InputBar + Footer 结构和右栏避让收敛
C-PRESET-04  Claude + Peri 默认参数集中整理
C-VERIFY-05  浏览器几何/视觉证据与自动测试收口
```

建议每个任务完成后都保留：

```text
源码实现：
修改文件：
纯测试：
build：
diff check：
浏览器后置验收：
Tauri/ACP 后置验收：
未覆盖风险：
```

## 11. 非目标

- 不重写 Pylon Control Center 为 Claude Code 固定组件。
- 不删除 Widget 自定义、布局拖拽、slot、order、scale、variant、hidden。
- 不删除用户消息 `>` 的可能性；只把它变成可配置的 Claude 风格默认选择。
- 不删除现有其他主题 preset。
- 不把 Peri 的 TUI 代码复制进 Pylon。
- 不修改 Claude Code 本地参考副本或上游源码镜像。
- 下一位优先读取 `references/claude-code-sourcemap/restored-src/src`，GitHub 只用于明确更新参考副本。
- 不修改 Rust、Tauri、ACP、Peri 后端或 API 契约。
- 不把浏览器 mock 验收写成真实 Tauri/ACP 验收。

## 12. 接手人的第一步

先不要继续改 CSS。

先读取本文件第 3、5、7、8 节，再对当前 Pylon 页面做一次浏览器 DOM 基线采集，记录：

- Claude 风格当前实际显示名。
- Control Center 实际高度。
- InputBar 上/下 border 的实际 rect 和 computed style。
- Footer Row 1 / Row 2 的实际 rect。
- Right Panel 打开前后的 content width。
- 用户消息、Assistant、Tool、Thinking 的 class、字号、颜色、间距。

确认基线后再按 C-PRESET-01 → C-INFO-02 → C-FOOTER-03 → C-PRESET-04 → C-VERIFY-05 顺序执行，不要从单个颜色或单条横线开始猜测性微调。

## 13. 2026-07-30 本轮实现记录

### C-PRESET-01

- 显示名已改为 `Claude 风格`。
- 内部稳定 ID 仍为 `claude`。
- `scripts/test-preset-design.mts` 已同步显示名断言。

### C-INFO-02

- App 根节点新增受限的 `data-active-preset`，只有 global/chat/cc 三个 zone 均为未 dirty 的 `claude` 时启用 Claude 专属信息层级；自定义字段后不会继续强套 Claude CSS。
- Claude 风格用户消息使用 `#373737` token 整行背景，不改其他 preset。
- Claude 风格消息块使用约一行间距，Assistant 左缩进约 `2ch`。
- Thinking 标题改为 `∴ Thinking…`，保留折叠能力并增加 `aria-expanded`；展开正文约 `2ch` 缩进。
- Tool 仍保持状态点 + 粗体工具名 + 紧随括号摘要，未改现有状态机、折叠、sanitizer 或 connector。

### C-FOOTER-03

- InputBar 双横线继续由 `.input-row` 自身负责，`box-sizing:border-box` 保证边框进入几何高度。
- 快捷键提示保持单一 DOM 行：`/: 命令 | Shift+Enter: 换行 | Shift+Tab: 模式`。
- Right Panel inset 作用于整个 `.cc-body`，浏览器实测 InputBar 与提示的 right 均为 `1648`，Right Panel left 为 `1660`，无覆盖。
- Claude 预设恢复为 `76px` Control Center；CLI CSS 不再全局强制所有 preset 最低 `96px`。

### C-PRESET-04

Claude 预设当前关键参数：

```text
label              Claude 风格
name               claude
chat/input font    15px monospace
footer font        14px monospace
ccHeight           76
ccBgHeight         76
cliLineWidth       1
cliLineColor       #888888
cliPromptColor     #999999
cliTextColor       #FFFFFF
cliLinePadding     3
cliHintMode        full
userTagBg          #373737
```

### C-VERIFY-05 已执行证据

浏览器环境：`http://127.0.0.1:5173/`，浏览器 dev 模式。

Claude 风格应用后实测：

```text
Control Center rect      top 813 / bottom 889 / height 76
Input border rect        top 809.859 / bottom 838.859 / height 29
Input border             1px solid rgb(136,136,136)，上下均存在
Footer status rect       top 844.859 / bottom 883
Shortcut hint rect       top 866.75 / bottom 883
Shortcut hint            nowrap / right aligned
User background          rgb(55,55,55)
User padding             8px 12px
Assistant padding-left   18px（2ch）
Thinking                 13.95px / dim / italic
Tool                     15px monospace
```

说明：`.input-row` 比 `.cc-body` 顶部高约 `3.14px`，是旧 `ccLayout` 中 input widget 的 `offsetY` 持久化值导致；双横线完整可见且未被 `overflow:hidden` 裁剪。本轮没有覆盖用户已有 Widget 自定义位置。若产品要求严格满足 `inputRow.top >= ccBody.top`，应由用户在中控编辑中重置位置，或另开 migration 决策，不能静默吞掉现有布局。

自动验证：

```text
node --experimental-strip-types scripts/test-chat-info-layer.mts       通过
node --experimental-strip-types scripts/test-preset-design.mts         通过
node --experimental-strip-types scripts/test-control-center-responsive.mts 通过
npm run build                                                        通过
限定路径 git diff --check                                            通过
```

浏览器 console 的 7 条错误来自无 Tauri runtime 的 `invoke/listen` 边界，未作为视觉组件错误处理。真实 Tauri/ACP 验收本轮未执行。

## 14. 横线不显示问题复核与修正

上一轮对横线问题的根因判断不准确。实际原因不是 Widget 的 `offsetY`，而是 CLI 底部内容总高度超过了 `76px` Control Center：

```text
旧 Input slot       32px
旧 flex gap          6px
旧 status row       44.14px
旧上下 padding      4px + 6px
合计                 92.14px > 76px
```

`.cc-body` 使用 `justify-content:flex-end`，内容超高后会从容器顶部向上溢出，导致 `.input-row` 的上边框落在 `.cc-body` 外部并被 `overflow:hidden` 裁掉。此前记录为“旧 localStorage offsetY 导致”是错误结论。

修正：

- CLI `.cc-body` 改为 `padding-top:0; padding-bottom:3px`。
- CLI gap 从 `6px` 调整为 `5px`。
- CLI `.cc-status-row` 设置 `row-gap:0`，避免空状态/换行额外撑高。
- 保留 `.cc-body { overflow:hidden }`，不通过放开溢出掩盖布局错误。

修正后浏览器实测：

```text
cc-body       top 813 / bottom 889 / height 76
input-row     top 816.859 / bottom 845.859 / height 29
status-row    top 850.859 / bottom 886 / height 35.14
```

上下横线均已位于 `.cc-body` 内部，不再被裁剪。

## 15. 后续强化方案：保留布局自由度的参数化契约

### 15.1 核心原则

后续强化不能把 Pylon 重写为固定 Claude/Peri 布局。必须继续保留：

- Widget registry。
- slot / order。
- offsetX / offsetY。
- scale。
- hidden。
- variant。
- custom preset。
- 每个预设独立的默认组合。

强化目标是消除裁剪、固定高度冲突和预设结构耦合，而不是删除用户的布局能力。

### 15.2 推荐新增的布局模式字段

建议把视觉结构从 preset 名称中解耦，增加明确主题字段：

```ts
messageLayout: 'classic' | 'claude' | 'bubble'
footerLayout: 'free' | 'peri'
cliOverflowMode: 'fixed-scroll' | 'grow' | 'overlay'
```

Claude 风格推荐默认值：

```ts
messageLayout: 'claude'
footerLayout: 'peri'
cliOverflowMode: 'fixed-scroll'
```

字段语义：

- `messageLayout`：只控制 User / Assistant / Tool / Thinking 的信息层级，不绑定颜色 preset。
- `footerLayout: free`：维持现有自由排列模式。
- `footerLayout: peri`：固定 Input composer → Footer Row 1 → Footer Row 2 的信息层级，但 Row 1 内 Widget 仍可排序、偏移、缩放、隐藏和切换 variant。
- `fixed-scroll`：中控高度固定，多行 textarea 内部滚动，最适合保留当前画布构图。
- `grow`：`ccHeight` 作为最小高度，多行输入时自然增高。
- `overlay`：中控高度固定，扩展输入区向上浮层展开。

这样可以组合：

```text
Glass 颜色 + Claude 消息布局 + Peri Footer
Tokyo 颜色 + bubble 消息 + free Footer
Claude 颜色 + classic 消息
```

### 15.3 Footer 结构强化边界

当前 Footer 仍依赖 `.cc-status-row` 的 `flex-wrap` 和 hint 的 `flex-basis:100%` 形成两行。后续 `footerLayout: peri` 应显式拆为：

```tsx
<div className="cc-footer">
  <div className="cc-footer-status">
    <div className="cc-status-primary" />
    <div className="cc-status-secondary" />
    <div className="cc-actions" />
  </div>
  <div className="cc-footer-hint" />
</div>
```

约束：

- 只固定快捷键提示属于 Footer Row 2。
- Row 1 内的 model / mode / token / actions 继续走现有 Widget placement。
- `free` 模式保留当前自由布局，不强制 Peri 两行。
- 不把快捷键提示注册成普通可拖拽 Widget；它属于布局结构。

### 15.4 高度约束不能写死

当前存在契约冲突：Claude preset 是 `ccHeight:76`，但 `setCcHeight()` 最低钳制为 `80`。后续应建立统一高度真值，Settings、拖动 action、migration 和 CSS 共用。

不要全局硬编码 CLI 最低 `76px`。最低高度应根据当前能力计算：

```ts
resolveCcMinHeight({
  inputMode,
  footerLayout,
  hintMode,
  visibleStatusWidgets,
  cliOverflowMode,
})
```

示例语义：

```text
无 Footer、无状态 Widget：允许更小高度
Peri Footer + full hint：最低需要完整容纳 composer + 两行 Footer
fixed-scroll：保持固定画布
Grow：ccHeight 仅作为最小高度
```

用户仍可把高度调大到任意合法范围，不统一覆盖各 preset 的密度。

### 15.5 activePreset 不应承担布局语义

当前 `data-active-preset="claude"` 依赖 global/chat/cc zone 都是未 dirty 的 Claude。用户只改一个颜色就会失去 Claude 消息结构，这是临时接线，不应成为最终架构。

后续改为：

```tsx
<div
  data-message-layout={messageLayout}
  data-footer-layout={footerLayout}
/>
```

用户修改颜色、字号或横线色时，不应自动丢失消息层级和 Footer 结构。布局字段本身被修改时才切换结构。

### 15.6 Right Panel inset 单一真值

当前 ChatView、ControlCenter、PetCompanion 分别处理 Right Panel 宽度。建议在 `.main-body` 注入统一变量：

```tsx
style={{
  '--right-panel-inset': rightOpen ? `${rightWidth}px` : '0px',
}}
```

Chat、Control Center、回底按钮和 Pet 统一消费，避免不同模块产生 8px/12px 等漂移。此修改不影响用户调整 Right Panel 宽度。

### 15.7 几何测试必须替代字符串假阳性

后续增加 Playwright 几何回归，至少验证：

```ts
inputRow.top >= ccBody.top
inputRow.bottom <= ccBody.bottom
borderTopWidth > 0
borderBottomWidth > 0
hint.right <= rightPanel.left
```

验收矩阵：

```text
Claude / Glass
Right Panel 开 / 关
空输入 / 单行 / 三行 / 十行
full / compact / hidden hint
宽屏 / 900px / 640px
command palette 开 / 关
free / peri Footer
fixed-scroll / grow / overlay
```

源码字符串测试只负责字段和 class 防漏，不能再用于宣称横线视觉正确。

### 15.8 响应式与可访问性

- 窄屏保持快捷键单行，通过隐藏低优先级片段收敛，不改成错误的两行文案。
- Thinking 与 Tool 折叠按钮补齐 `aria-expanded`、`aria-controls`。
- InputBar 使用 `aria-describedby` 指向快捷键提示。
- 增加 `prefers-reduced-motion`，关闭消息位移动画、非必要 transition 和 EKG 动画。

这些能力不影响 Widget 布局自由度。

### 15.9 推荐任务顺序

```text
C-ENHANCE-01  新增 messageLayout / footerLayout / cliOverflowMode 字段闭环
C-ENHANCE-02  footerLayout=peri 显式 Row 1 / Row 2，保留 Row 1 Widget 自定义
C-ENHANCE-03  统一动态最低高度与 Settings/拖动/migration 契约
C-ENHANCE-04  fixed-scroll / grow / overlay 多行输入策略
C-ENHANCE-05  activePreset 与布局语义解耦
C-ENHANCE-06  Right Panel 共享 inset
C-ENHANCE-07  Playwright 几何回归矩阵
C-ENHANCE-08  窄屏、ARIA、reduced motion
```

实施时每项独立闭环，不把共享 `store.ts`、`App.tsx`、`ControlCenter.tsx` 的任务并行修改；未经用户授权不 commit，不修改 `src-tauri/`。

## 16. 2026-07-30 第二轮接手交接快照

本节是本轮接手后的最新快照，优先级高于前文历史状态。交接文档中的旧行号、旧 HEAD 和旧验证输出均不得直接作为当前事实。

### 16.1 当前 Git 基线

```text
项目：G:\Project\prism-desktop
分支：main
HEAD：d1568f17dd1bc23bcc7d196bba7365100c2e4e01
HEAD 摘要：docs(backend): 完成 Pylon 后端全量交接
```

已提交的本轮相关前端 commit：

```text
fbfae2b feat(chat): 完善 Thinking 完成态显示
a8c863f feat(ui): 建立参数化 Footer 布局契约
```

当前工作区不是干净状态。必须保留、不得覆盖或纳入前端提交的外部改动：

```text
src-tauri/build.rs
src-tauri/src/agent_config.rs
src-tauri/src/agent_runtime.rs
src-tauri/src/lib.rs
src-tauri/tests-harness/windows-test-manifest.rc
src-tauri/tests/windows-test-manifest.rc
src-tauri/loader-error.txt
docs/功能开发清单（后端）.md
docs/验收清单.md
docs/视觉重整.md
docs/后端交接清单.md
docs/后端功能任务清单.md
references/
```

禁止使用：

```text
git add .
git add -A
reset
restore
stash
clean
```

### 16.2 本轮已完成并提交

#### C-PRESET-01 / C-INFO-02 / C-FOOTER-03 / C-PRESET-04

前文第 13、14 节记录的实现已存在于当前提交历史，主要包括：

- Claude 显示名为 `Claude 风格`，内部 ID 仍为 `claude`。
- Claude 默认用户消息背景已改为透明。
- Thinking 运行中显示 `Thinking…`，结束后显示 `Thought for N chars`。
- Claude 消息默认层级、Tool 标题、Thinking 折叠和 Footer 基础结构已接入。
- InputBar 上下双横线继续由 InputBar 自身负责。

Thinking 完成态当前按 `Array.from(text).length` 计算字符数；这是真实当前实现，不是规划状态。

#### C-ENHANCE-01：布局模式字段闭环

已完成并包含在 commit `a8c863f`：

```ts
messageLayout: 'classic' | 'claude' | 'bubble'
footerLayout: 'free' | 'peri'
cliOverflowMode: 'fixed-scroll' | 'grow' | 'overlay'
```

已接入：

- `ThemeSettings`
- `DEFAULTS`
- migration normalize
- `ZONE_FIELDS`
- custom preset 白名单
- 内建预设
- App 根节点 `data-message-layout` / `data-footer-layout` / `data-cli-overflow-mode`
- Settings 控件

Claude 默认值：

```ts
messageLayout: 'claude'
footerLayout: 'peri'
cliOverflowMode: 'fixed-scroll'
```

#### C-ENHANCE-02：Peri Footer 显式行结构

已完成并包含在 commit `a8c863f`：

- `footerLayout=peri` 使用显式 `cc-footer`。
- InputBar 为 composer 区。
- `cc-footer-status-row` 为 Footer Row 1。
- 快捷键提示为 Footer Row 2。
- Row 1 继续复用 Widget registry、slot、order、offset、hidden、variant 和 scale。
- `footerLayout=free` 保留原有布局路径。

#### C-ENHANCE-03：动态最低高度

已完成并包含在 commit `a8c863f`：

新增：

```text
src/ccHeightState.ts
```

纯函数：

```ts
resolveVisibleStatusWidgetCount(...)
resolveCcMinHeight(...)
clampCcHeight(...)
```

已接入 ControlCenter、Settings、`setCcHeight()` 和 persist migration。当前最低高度不再由单一固定 `64px` / `76px` / `80px` 猜测，而由输入模式、Footer、hint、可见 Widget 和 overflow 模式共同决定。

### 16.3 已完成但尚未提交：C-ENHANCE-04

目标：实现三种多行输入策略。

当前未提交文件：

```text
src/components/chat/InputBar.tsx
src/components/chat/InputBar.css
src/components/chat/inputOverflowState.ts
src/components/ControlCenter.css
scripts/test-input-overflow-state.mts
scripts/test-layout-mode-contract.mts
```

当前行为：

```text
fixed-scroll
- 输入区固定单行高度。
- 多行内容在 textarea 内部滚动。
- 中控高度保持固定。

grow
- textarea 随内容增长，最大 200px。
- 超过 200px 后 textarea 内部滚动。
- Control Center 高度允许自动增长。

overlay
- 中控主体保持固定。
- 多行 textarea 向上浮层展开。
- 不推挤 Footer 和其他控件。
```

纯状态模块：

```text
src/components/chat/inputOverflowState.ts
```

当前已执行并通过：

```text
node --experimental-strip-types scripts/test-input-overflow-state.mts
node --experimental-strip-types scripts/test-layout-mode-contract.mts
node --experimental-strip-types scripts/test-cc-height-state.mts
node --experimental-strip-types scripts/test-preset-design.mts
node --experimental-strip-types scripts/test-zone-fields.mts
npm run build
git diff --check -- src/components/chat/inputOverflowState.ts src/components/chat/InputBar.tsx src/components/chat/InputBar.css src/components/ControlCenter.css scripts/test-input-overflow-state.mts scripts/test-layout-mode-contract.mts
```

上述命令已在本节交接文档写入后重新执行并通过。C-ENHANCE-04 仍不得写成已提交。

### 16.4 尚未实施任务

#### C-ENHANCE-05：activePreset 与布局语义解耦

当前仍存在临时接线：

```tsx
data-active-preset={activeVisualPreset}
```

`activeVisualPreset` 依赖 global/chat/cc 三个 zone 同时是 Claude 且全部未 dirty。需要改为布局字段直接驱动：

```tsx
data-message-layout={messageLayout}
data-footer-layout={footerLayout}
```

消息 CSS 应从 `.app[data-active-preset="claude"]` 迁移到 `data-message-layout="claude"`；Footer CSS 应由 `data-footer-layout="peri"` 驱动。用户修改颜色、字号或横线颜色时，不应因此丢失 Claude 消息层级或 Peri Footer 结构。

#### C-ENHANCE-06：Right Panel 共享 inset

当前 ChatView、ControlCenter、PetCompanion 仍有各自的右栏偏移处理。需要在 `.main-body` 建立统一 CSS 变量：

```tsx
'--right-panel-inset': rightOpen ? `${rightWidth}px` : '0px'
```

Chat、Control Center、回底按钮和 Pet 统一消费。需要分别验证 Right Panel 关闭和打开状态，不能只验证某一个 hint 的 `right`。

#### C-ENHANCE-07：Playwright 几何回归矩阵

当前 Node 脚本只能验证源码结构和纯函数，不能替代浏览器视觉验收。需要新增真实 DOM/geometry 验收，至少覆盖：

```text
Claude / Glass
Right Panel 开 / 关
空输入 / 单行 / 三行 / 十行
full / compact / hidden hint
宽屏 / 900px / 640px
command palette 开 / 关
free / peri Footer
fixed-scroll / grow / overlay
```

必须测量：

```text
.control-center
.cc-body
.cc-input-slot
.input-bar.cli-mode
.input-row
.cli-prefix
.input-textarea
.cc-footer-status-row
.cc-command-hint
.right-panel
```

最低几何不变量：

```text
inputRow.top >= ccBody.top
inputRow.bottom <= ccBody.bottom
borderTopWidth > 0
borderBottomWidth > 0
hint.right <= rightPanel.left（右栏打开时）
```

仅 `getComputedStyle().borderTopWidth > 0` 不能关闭横线验收；必须同时证明边框位于容器内且未被 `overflow:hidden` 裁剪。

#### C-ENHANCE-08：窄屏、ARIA、reduced motion

尚未实施：

- 窄屏快捷键提示单行收敛和低优先级片段隐藏。
- Thinking 折叠按钮补稳定 `aria-controls`。
- Tool 折叠按钮补稳定 `aria-controls`。
- InputBar 使用 `aria-describedby` 指向命令提示。
- `prefers-reduced-motion` 下关闭消息位移动画、非必要 transition 和 EKG 动画。

### 16.5 当前验证证据分层

本轮最后一次源码验证结果：

```text
纯函数/结构回归：通过
- test-input-overflow-state.mts
- test-layout-mode-contract.mts
- test-cc-height-state.mts
- test-preset-design.mts
- test-zone-fields.mts

npm run build：通过
```

Build 中仍有既有 warning：

- `@tauri-apps/plugin-dialog` 同时被 dynamic import 和 static import。
- Vite 报有 chunk 超过 500 kB。

这些 warning 不影响本次 build exit 0，但未作为本任务修复范围。

尚未完成：

```text
浏览器 Playwright 几何验收：未执行
真实 Tauri 验收：未执行
ACP/Peri runtime 联调：未执行
```

Node 回归和 `npm run build` 只能证明前端源码闭环，不能宣称真实 Tauri、ACP、Peri 运行时已验收。

### 16.6 下一位 Coder 的接手顺序

```text
1. 先精确提交 C-ENHANCE-04，不纳入 src-tauri、既有 docs、references 或其他外部文件。
2. 重新执行 C-ENHANCE-04 全部专项测试、npm run build、限定 git diff --check。
3. C-ENHANCE-05：activePreset 与 messageLayout/footerLayout 解耦。
4. C-ENHANCE-06：Right Panel 共享 inset。
5. C-ENHANCE-07：Playwright 几何矩阵。
6. C-ENHANCE-08：窄屏、ARIA、reduced motion。
7. 所有源码、测试和交接文档最后 patch 后，重新执行全部相关专项测试、npm run build、限定 git diff --check 和 git status。
```

每个任务独立验证、独立提交；共享 `store.ts`、`App.tsx`、`ControlCenter.tsx` 和本交接文档必须串行。未经用户明确授权，不修改 `src-tauri/`，不把浏览器结果写成真实 Tauri/ACP 验收。

## 17. 2026-07-30 第三轮连续开发快照

本节记录当前工作树中的最新前端实现，优先于第 16 节的“尚未实施”状态。当前改动尚未 commit。

### 17.1 C-ENHANCE-04：多行输入策略

已在当前工作树实现：

- `fixed-scroll`：textarea 固定单行高度，长内容内部滚动，中控高度固定。
- `grow`：textarea 随内容增长，最大 200px，Control Center 自然增高。
- `overlay`：多行 textarea 向上浮层展开，不推挤 Footer。
- 纯状态模块：`src/components/chat/inputOverflowState.ts`。
- 回归：`scripts/test-input-overflow-state.mts` 与 `scripts/test-layout-mode-contract.mts`。

### 17.2 C-ENHANCE-05：布局语义与 preset 解耦

已在当前工作树实现：

- 删除 `activeVisualPreset` 与根节点 `data-active-preset`。
- Claude 消息层级改由 `data-message-layout="claude"` 直接驱动。
- Footer 继续由 `data-footer-layout="peri"` 驱动。
- 用户只修改颜色、字号或横线色时，不再因 zone dirty 自动丢失 Claude 消息层级。
- `scripts/test-chat-info-layer.mts` 已锁定旧临时接线不再存在。

### 17.3 C-ENHANCE-06：Right Panel 共享 inset

已在当前工作树实现：

- `.main-body` 注入单一 `--right-panel-inset`。
- Control Center、InputBar/Footer、回底按钮和 Pet 统一消费该变量。
- 删除组件私有 `--cc-right-inset`、`--chat-right-offset` 及重复 `rightOpen/rightWidth` props。
- 浏览器实测右栏打开时 InputBar、hint、回底按钮与 Pet 均满足 `right <= rightPanel.left`。

### 17.4 动态最低高度浏览器校正

浏览器发现旧纯函数低估真实 DOM 高度：Claude + Peri + full hint 的 `ccHeight:76` 会令 Input 上横线超出 `.cc-body`。

当前高度预算已按实测校正：

```text
composer      30px
footer gap     5px
status row    25px
hint row      21px
bottom padding 3px
```

Claude + Peri + full hint、4 个可见状态 Widget 的动态最低高度现为 `84px`。浏览器实测：

```text
cc-body   top 861 / bottom 945 / height 84
input-row top 862.109 / bottom 892.109 / height 30
```

`inputRow.top >= ccBody.top`、`inputRow.bottom <= ccBody.bottom`，上下 `1px` 边框均完整可见。

### 17.5 C-ENHANCE-07：浏览器几何矩阵

已使用真实浏览器 DOM 执行 63 个场景，覆盖：

```text
Claude：1200 / 900 / 640
fixed-scroll / grow / overlay
Right Panel 开 / 关
1 / 3 / 10 行输入
full / compact / hidden hint
command palette 打开

Classic/free 对照：1200 / 900 / 640，Right Panel 开 / 关
```

检查不变量：

```text
InputBar 位于 cc-body 内
上下边框非零且未被裁剪
快捷键提示 nowrap
InputBar / hint / 回底按钮 / Pet 避让 Right Panel
```

首轮 30 个失败全部集中于“未定位 Pet 在右栏首次打开时未立即避让”。修复后 reduced-motion 浏览器实测：

```text
Right Panel left 380
Pet left 264 / right 380
petAvoidsPanel true
```

矩阵属于本轮 Playwright MCP 运行证据，尚未新增项目内 Playwright 依赖或 npm script；项目当前没有 `playwright`、`playwright-core`、`@playwright/test` 依赖。

### 17.6 C-ENHANCE-08：窄屏、ARIA、reduced motion

已在当前工作树实现：

- `>900px`：显示完整单行 `/: 命令 | Shift+Enter: 换行 | Shift+Tab: 模式`。
- `721～900px`：隐藏 Shift+Tab 低优先级片段。
- `<=720px`：只保留 `/: 命令`，仍保持单一 DOM 行和 `nowrap`。
- ControlCenter 用 `useId()` 生成 hint ID；InputBar textarea 通过 `aria-describedby` 关联。
- Thinking 与 Tool 折叠按钮增加稳定 `aria-controls`，正文使用对应 ID。
- Chat 消息使用 `useReducedMotion()`；reduced motion 下关闭消息初始位移与过渡。
- Chat cursor、按钮 transition、EKG transition 纳入 `prefers-reduced-motion`。
- Pet 原有 reduced-motion 规则继续生效。

浏览器实测 `640px + prefers-reduced-motion:reduce`：

```text
messageLayout claude
footerLayout peri
InputBar 位于 cc-body 内
上下边框 1px
hint secondary display none
hint tertiary display none
textarea aria-describedby == hint id
Pet transition-duration 0s
Right Panel 打开后 Pet right == panel left
```

### 17.7 当前验证证据

当前工作树最后一轮执行并通过：

```text
node --experimental-strip-types scripts/test-chat-info-layer.mts
node --experimental-strip-types scripts/test-scroll-bottom-offset.mts
node --experimental-strip-types scripts/test-control-center-responsive.mts
node --experimental-strip-types scripts/test-pet-transparent-shell.mts
node --experimental-strip-types scripts/test-pet-motion.mts
node --experimental-strip-types scripts/test-input-overflow-state.mts
node --experimental-strip-types scripts/test-layout-mode-contract.mts
node --experimental-strip-types scripts/test-cc-height-state.mts
node --experimental-strip-types scripts/test-preset-design.mts
node --experimental-strip-types scripts/test-zone-fields.mts
npm run build
git diff --check -- src scripts
```

Build exit 0。仍有既有 warning：`plugin-dialog` 同时 dynamic/static import，以及主 chunk 超过 500 kB。

尚未执行：

```text
真实 Tauri runtime 验收
ACP / Peri 联调
commit
```

当前工作区仍含独立后端、docs 与 `references/` 改动。后续提交必须使用显式路径或 task-only index，禁止 `git add .` / `git add -A`，不得纳入 `src-tauri/**` 和无关文档。

## 18. 紧急修复：Claude 信息栏中点分隔恢复

### 18.1 用户现象

Claude 风格中控信息栏应当在每两个控件之间显示一个 ` · `，当前排列出现分隔不正确。

### 18.2 根因

`footerLayout=peri` 使用 `.cc-footer-status-row`，但旧组内分隔选择器只覆盖 `.cc-status-row .cc-widget + .cc-widget::before`。因此 Peri Footer 中同一 slot 内的相邻 Widget 没有中点；同时跨 slot 分隔仍依赖固定 `primary::before` / `secondary::after`，容易受 DOM 顺序和空组影响。

### 18.3 修复

- Peri/free 两条路径的 DOM 顺序统一为 `status-secondary → status-primary → actions`。
- 组内相邻 Widget 同时覆盖 `.cc-status-row` 与 `.cc-footer-status-row`。
- 跨 slot 使用“后续非空组”的通用 sibling 选择器，只在两个实际非空组之间生成一个中点。
- 删除旧的固定 `secondary::after` / `primary::before` / `actions::before` 规则，避免重复或缺失。
- 更新 `scripts/test-control-center-responsive.mts` 锁定 DOM 顺序、新分隔选择器和旧规则删除。

### 18.4 浏览器实测

Claude + Peri 当前实际控件：

```text
model · mode · pct · tokens
```

伪元素来源：

```text
model  before none
mode   before " · "
primary group before " · "
pct    before none
tokens before " · "
```

因此每两个实际控件之间恰好一个中点，空 actions 组不产生额外分隔。

### 18.5 修改文件

```text
src/components/ControlCenter.tsx
src/components/ControlCenter.css
scripts/test-control-center-responsive.mts
docs/交接-Claude与Peri风格预设拟合.md
```

### 18.6 最终验证

紧急修复和本交接文档更新后实际执行并通过：

```text
node --experimental-strip-types scripts/test-control-center-responsive.mts
node --experimental-strip-types scripts/test-layout-mode-contract.mts
node --experimental-strip-types scripts/test-cc-height-state.mts
node --experimental-strip-types scripts/test-chat-info-layer.mts
node --experimental-strip-types scripts/test-scroll-bottom-offset.mts
npm run build
git diff --check -- src scripts docs/交接-Claude与Peri风格预设拟合.md
```

`npm run build` exit 0。仍有既有 warning：`plugin-dialog` 同时 dynamic/static import，以及主 chunk 超过 500 kB。

## 19. 最终交接入口

本节是当前最终交接入口，优先于第 16 节的历史快照和旧接手顺序。

### 19.1 当前 Git 基线

```text
项目：G:\Project\prism-desktop
分支：main
HEAD：b19ef07
HEAD 摘要：docs(backend): 标记交接提交边界
相对 origin/main：ahead 12
```

本批 Claude + Peri 前端改动仍未 commit。

### 19.2 当前任务状态

```text
C-ENHANCE-04  已实现，未提交
C-ENHANCE-05  已实现，未提交
C-ENHANCE-06  已实现，未提交
C-ENHANCE-07  已执行浏览器几何矩阵，未建立项目内 Playwright runner
C-ENHANCE-08  已实现，未提交
紧急中点分隔修复  已实现，未提交
```

第 16.4 节的“尚未实施”和第 16.6 节的旧接手顺序仅是历史快照，不再代表当前下一步。

### 19.3 当前未提交前端范围

```text
src/App.tsx
src/ccHeightState.ts
src/components/ControlCenter.tsx
src/components/ControlCenter.css
src/components/PetCompanion.tsx
src/components/PetCompanion.css
src/components/chat/ChatView.tsx
src/components/chat/ChatView.css
src/components/chat/InputBar.tsx
src/components/chat/InputBar.css
src/components/chat/StatusBar.css
src/components/chat/inputOverflowState.ts

scripts/test-cc-height-state.mts
scripts/test-chat-info-layer.mts
scripts/test-control-center-responsive.mts
scripts/test-layout-mode-contract.mts
scripts/test-pet-transparent-shell.mts
scripts/test-scroll-bottom-offset.mts
scripts/test-input-overflow-state.mts

docs/交接-Claude与Peri风格预设拟合.md
```

### 19.4 必须保留的外部工作区改动

以下不属于本批前端任务，不得覆盖或纳入前端提交：

```text
src-tauri/build.rs
src-tauri/src/agent_config.rs
src-tauri/tests-harness/windows-test-manifest.rc
src-tauri/tests/windows-test-manifest.rc
src-tauri/loader-error.txt

docs/功能开发清单（后端）.md
docs/验收清单.md
docs/视觉重整.md
references/
```

禁止使用：

```text
git add .
git add -A
reset
restore
stash
clean
```

### 19.5 浏览器矩阵证据的精确结论

首次 63 场景矩阵：

```text
总数 63
通过 33
失败 30
```

30 个失败全部仅为 `petAvoidsPanel=false`，InputBar、Footer、上下横线、hint、回底按钮和三种 overflow 策略均通过。

修复 Pet 首次右栏避让后重跑：

```text
总数 63
通过 61
失败 2
```

剩余 2 项发生在矩阵打开 Right Panel 后约 30ms 立即采样，React effect 尚未完成位置收敛。独立时序探针确认约 100ms 后：

```text
Pet right == Right Panel left
petAvoidsPanel == true
```

因此当前浏览器证据证明 Pet 最终会正确避让，但项目尚未建立可重复执行的 Playwright npm runner。不得把本轮 MCP 矩阵描述为项目内自动测试 `63/63 green`。

### 19.6 下一位 Coder 的操作顺序

```text
1. 重新检查实时 HEAD、git status 和限定前端 diff。
2. 复核第 17、18、19 节对应源码和当前未提交文件。
3. 重新执行全部相关专项回归、npm run build 和限定 git diff --check。
4. 浏览器快速复核中点分隔、双横线、三种输入策略和 Right Panel 避让。
5. 只精确提交本批前端源码、测试和本交接文档。
6. 不纳入 src-tauri、其他 docs、references 或现有外部改动。
7. 后续进入真实 Tauri / ACP / Peri runtime 验收。
```

### 19.7 当前未完成项

```text
真实 Tauri runtime 验收：未执行
ACP / Peri 联调：未执行
项目内 Playwright 自动化 runner：未建立
本批前端改动：未 commit
```
