# Pylon 插件系统说明书（开发者版）

> 适用版本：Pylon 0.2.2
>
> 生产契约：Plugin API 1.0 / 1.1 / 1.2（最新 1.2），`pylon-plugin.json` schema 1

本文基于当前源码契约编写。旧 API 0.1 的 `trust`、`contributes`、`signature`、顶层 `entry`、CapabilityBroker、旧 Host/ExtensionPoint 均已删除，不得用于新插件。`capabilities` 与 `dangerousHooks` 自 API 1.2 起以新语义回归（见 §3.1）。API 1.3 定稿 Hook 锚点词表与事件 schema（见 §6.2）：新增 `permission.request`，移除 `agent.chunk`、`message.agent.committed`。

普通用户请阅读[用户版](Pylon-插件系统说明书-用户版.md)。

---

## 1. 架构

```text
KernelRoot / Recovery Surface
        │
        ▼
KernelBootstrap（starting / ready / degraded / safe-mode）
        │ 显式 bootstrap / retry
        ▼
pluginCompositionRoot（唯一产品 PluginRuntime authority）
├─ 七个第一方 Product Plugin definitions
└─ PackageInstallationService / PackagePluginRuntimeService
          ▲
          │
    插件源码/构建目录
    ├─ pylon-plugin.json
    ├─ web.entry / web.styles
    ├─ assets/resources
    └─ bin/<platform>/...
          │
          ▼
    Native Package Store
    packages / data / runtime / transactions / state.json
    ├─ pylon-plugin:// resource protocol
    └─ PluginPackageDescriptor
          │ import → prepare → activate → commit
          ▼
唯一 PluginRuntime + PluginScope + Shadow Transactions
├─ Application Registry
├─ Workspace Registry
├─ Renderer Registry
├─ Command Registry
├─ Hook Runtime
├─ Service Registry
├─ UI Surface Registry
├─ Presentation Profile / Font Registry
├─ Settings Page / Setting Options Registry
├─ Sidebar / Context Panel / File Workbench Registry
├─ Session Creation Contribution / Compiler / Artifact Handler Registry
├─ Session / Turn namespace
└─ Process Supervisor
```

关键原则：

1. package instance 与 runtime instance 分离；
2. 插件所有副作用必须归属于当前 `PluginScope`；
3. 更新先构造候选实例，成功后才原子切换；
4. 候选失败时旧实例、active pointer 和旧进程继续保留；
5. 外置资源不通过整包 JSON 搬运，使用 `pylon-plugin://` 与流式读取；
6. 单个插件失败不会阻止 Kernel Recovery Surface 出现；它的必需依赖方可能按契约被阻止；
7. Kernel bootstrap、外置 package、Hook `disable-plugin` 和设置页操作共享同一个 `PluginRuntime`，不得另建状态权威；
8. cleanup 只有在 deactivate hook 与全部 Scope resource 都成功释放后才算完成，部分失败必须保留并可重试。

---

## 2. 包结构

最小包：

```text
my-plugin/
├─ pylon-plugin.json
└─ index.js
```

完整包示例：

```text
my-plugin/
├─ pylon-plugin.json
├─ index.js
├─ styles/
│  └─ main.css
├─ assets/
│  ├─ logo.svg
│  └─ background.webp
├─ resources/
│  └─ defaults.json
├─ bin/
│  ├─ windows-x86_64/
│  │  └─ service.exe
│  ├─ linux-x86_64/
│  │  └─ service
│  └─ macos-aarch64/
│     └─ service
└─ migrations/
```

约束：

- 包根必须存在 `pylon-plugin.json`；
- `web.entry` 必须存在；
- 包内路径使用 `/`，禁止绝对路径、`..`、反斜杠和 NUL；
- 符号链接和非常规文件被拒绝；
- package 总大小上限当前为 1 GiB；
- `plugin_package_read_text` 的文本读取上限为 8 MiB；大资源应走 stream / Range；
- 包入口通过 `pylon-plugin://` 动态 import；第一版应把入口打成单 JS bundle，不依赖运行时相对 chunk import。

---

## 3. Manifest

```json
{
  "schema": 1,
  "id": "service.example",
  "name": "Example Service",
  "version": "1.0.0",
  "api": "1.0",
  "kind": "service",
  "web": {
    "entry": "./index.js",
    "styles": ["./styles/main.css"]
  },
  "dependencies": {},
  "optionalDependencies": {},
  "conflicts": [],
  "activation": {
    "events": ["kernel.ready"]
  },
  "hotSwap": {
    "mode": "parallel",
    "drainTimeoutMs": 10000
  },
  "executables": {
    "worker": {
      "windows-x86_64": "./bin/windows-x86_64/worker.exe",
      "linux-x86_64": "./bin/linux-x86_64/worker",
      "macos-aarch64": "./bin/macos-aarch64/worker"
    }
  },
  "reactVersion": "19"
}
```

### 3.1 字段

| 字段 | 必填 | 说明 |
|:--|:--:|:--|
| `schema` | 是 | 当前必须为 `1` |
| `id` | 是 | 正则 `^[a-z0-9]+(?:[.-][a-z0-9]+)*$` |
| `name` | 是 | 非空显示名称 |
| `version` | 是 | 非空版本；Native Store 接受字母数字及 `.`、`+`、`-` 分段 |
| `api` | 是 | 当前接受 `1.0` / `1.1` / `1.2` / `1.3` / `2.0` / `2.1` / `2.2` / `2.3` |
| `kind` | 是 | 插件角色，见下表 |
| `web.entry` | 是 | 包内 ESM 入口路径 |
| `web.styles` | 否 | stylesheet 路径数组 |
| `dependencies` | 否 | plugin id → version range；缺失、未启用、版本不匹配、依赖成环或依赖被阻止都会阻止激活 |
| `optionalDependencies` | 否 | plugin id → version range；不存在不阻止激活，已启用但版本不匹配会产生非阻塞诊断 |
| `conflicts` | 否 | 冲突 plugin id 列表；任一方声明即可双向阻止两个已启用插件同时激活 |
| `activation.events` | 否 | 至少一个声明事件已发出后才可激活；普通启动会发出 `kernel.ready` |
| `hotSwap.mode` | 否 | 缺省 `parallel` |
| `hotSwap.drainTimeoutMs` | 否 | 正数；Hook lease 排空超时 |
| `executables` | 否 | executable id → platform → 包内路径 |
| `capabilities` | 否 | API 1.2 新增：声明所需的宿主能力（封闭词表，当前只有 `plugin.management`），须经用户在授权卡逐项批准后插件才会激活（用户版 §5.1）；1.0/1.1 manifest 出现该字段直接校验失败 |
| `dangerousHooks` | 否 | API 1.2 新增：声明需要用户确认的危险 Hook 锚点（锚点必须存在于 §6.2 词表且不重复）；宿主当前只做词表与重复校验。1.0/1.1 manifest 出现该字段直接校验失败 |
| `reactVersion` | 否 | UI surface / React 隔离诊断元数据 |

已删除字段（任何 API 版本都直接校验失败）：

```text
trust
contributes
signature
顶层 entry
```

### 3.2 kind

```text
shell
workspace
feature
hook
renderer
skin
agent-adapter
tool-provider
service
automation
```

`kind` 是角色与管理元数据，不会自动注册 contribution。真实能力取决于入口代码调用的 context API。

### 3.3 运行时硬契约

Plugin Host 在启动、安装、更新、启用、停用和卸载前解析同一份候选图：

- version range 当前支持精确版本、caret（例如 `^1.2.3`）与 `*`；参与匹配的实际版本与精确/caret 基准必须是三段数字，否则按不匹配处理；
- required dependency 决定拓扑顺序，dependent 存在时不能停用或卸载其依赖；
- 更新不得把已启用 dependent 的依赖版本变成不兼容；
- conflict 采用对称阻止，即使只有一方声明也会同时阻止双方；
- 未收到 `activation.events` 时，包可以保持“已安装且已启用”，但状态为“等待激活事件”，不会创建 Runtime 实例；
- 契约错误以 `plugin_contract_blocked` 和逐插件 diagnostics 返回，不应靠解析错误字符串处理。

---

## 4. 入口模块生命周期

入口必须导出 `activate`。宿主接受命名导出对象或 default object：

```js
export async function prepare(context) {
  return { readyAt: Date.now() }
}

export async function activate(context, prepared) {
  // 注册 contribution、启动进程等
}

export async function suspend() {}
export async function resume() {}
export async function deactivate() {}
```

类型：

```ts
interface PackagePluginModule<TPrepared = unknown> {
  prepare?(context: PluginActivationContext): TPrepared | Promise<TPrepared>
  activate(context: PluginActivationContext, prepared?: TPrepared): void | Promise<void>
  suspend?(): void | Promise<void>
  resume?(): void | Promise<void>
  deactivate?(): void | Promise<void>
}
```

### 4.1 激活顺序

```text
创建 runtime 目录
→ stylesheet 使用 media="not all" 预加载
→ module.prepare
→ module.activate 写入当前事务
→ contribution 校验
→ commit contribution
→ stylesheet commit 生效
```

### 4.2 失败与停用

- prepare / activate / contribution 校验失败：回滚候选事务并 dispose Scope；
- deactivate 抛错：不阻断 Scope 后续回收；
- Scope 按资源注册逆序等待释放；成功资源从 residual 集合移除，失败资源保留稳定 resource id；
- deactivate hook 或任一资源释放失败：实例保留为 `cleanup-failed`，返回结构化 residual，不报告停用成功；
- `retryCleanup(instanceKey)` 只重试未完成的 hook/resource，成功后实例才进入 inactive；
- Package disable/uninstall 在 cleanup 未完成时不会修改持久 enabled 状态或删除安装包；
- 停用成功：移除所有注册项、样式、listener、timer、进程和 runtime 临时目录；
- 更新：候选失败时旧实例保持 active。

---

## 5. Plugin identity 与 Scope

`context.identity`：

```ts
interface PluginIdentity {
  pluginId: string
  version: string
  packageInstanceId: string
  runtimeInstanceId: string
  key: string
}
```

示例：

```text
pluginId          = service.example
packageInstanceId = service.example@1.0.0-a81f...
runtimeInstanceId = service.example@1.0.0-a81f...#run-...
```

`context.scope` 提供：

```ts
scope.add(disposable)
scope.listen(target, type, listener, options)
scope.setTimeout(handler, timeout)
scope.setInterval(handler, timeout)
scope.createAbortController()
```

所有 context 注册 API 都会自动把返回句柄登记到 Scope。插件绕过 API 创建副作用时，必须手工 `scope.add()`。

Host 为每个 Scope resource 分配稳定 id。释放错误会携带该 id 并显示在插件管理页；实现 disposable 时应保持幂等，以便失败后安全重试。

错误示例：

```js
window.addEventListener('resize', onResize)
```

正确示例：

```js
context.scope.listen(window, 'resize', onResize)
```

---

## 6. Activation Context API

```ts
context.identity
context.scope
context.application
context.workspace
context.renderer
context.commands
context.hooks
context.sessions
context.turns
context.process
context.ui
context.services
context.sidebar
context.fileWorkbench
context.contextPanel
context.presentation
context.settings
context.fonts
context.sessionCreation
```

### 6.1 Commands

```js
context.commands.register({
  id: 'example.hello',
  name: 'hello',
  description: '返回问候语',
  priority: 100,
  execute: ({ args, signal }) => {
    if (signal?.aborted) throw signal.reason
    return { message: `hello ${args?.name ?? 'world'}` }
  },
})
```

API：

```ts
commands.register(definition, options?)
commands.execute(id, args?, { signal }?)
commands.list(filter?)
commands.describe(id)
```

`name` 不得以 `/` 开头；执行时可通过 id、name 或 alias 解析。

### 6.2 Hooks

```js
context.hooks.register('message.user.beforeSend', {
  id: 'example.decorate-message',
  mode: 'pipeline',
  priority: 100,
  execution: 'blocking',
  timeoutMs: 3000,
  failurePolicy: 'continue',
  handler: ({ event, signal }) => ({
    action: 'continue',
    event: { ...event, pluginTouched: true },
  }),
})
```

Hook 名称（API 1.3 词表，与 `src/plugin-runtime/hooks/hookTypes.ts` 的 `HOOK_NAMES` 逐项一致，由 `scripts/check-hook-anchor-parity.mts` 门禁强制；每行一个全名，禁止简写）：

```text
context.afterBuild
context.beforeBuild
message.received
message.user.beforeSend
message.user.sendFailed
message.user.sent
permission.request
session.closed
session.closing
session.creating
session.created
session.deleted
session.deleting
session.loaded
session.loading
tool.afterCall
tool.beforeCall
tool.failed
tool.started
turn.cancelled
turn.completed
turn.failed
turn.started
```

相对 API 1.2 的变更：新增 `permission.request`（权限缝决策锚点，见下）；移除 `agent.chunk` 与 `message.agent.committed`（二者自 1.0 起从未有宿主派发方，1.3 起注册即校验失败）。`context.beforeBuild`/`context.afterBuild`/`turn.started`/`turn.cancelled`/`tool.started`/`tool.afterCall`/`tool.failed`/`session.deleting`/`session.deleted` 自 1.3 起有宿主派发方。

permission.request（权限缝，仅此锚点可短路 ACP 权限审批）：

```js
context.hooks.register('permission.request', {
  id: 'example.permission-gate',
  mode: 'pipeline',
  handler: ({ event }) => {
    // event: { source, provider, agentId, requestId, toolCallId, title, prompt, options }
    // 允许：{ action: 'respond', output: { decision: 'allow' } }
    // 拒绝：{ action: 'cancel', reason: '…' }
    // 改写（只允许原 optionId 的过滤/重排，不可新增）：
    return { action: 'continue', event: { ...event, options: event.options.filter(option => option.optionId !== 'allow_once') } }
  },
})
```

锚点事件形状与超时预算（gate 类 3000 ms / 通知类 1000 ms）以 `hookTypes.ts` 内的类型与 `HOOK_TIMEOUT_BUDGET_MS` 为准：`message.user.beforeSend`（transform 改写 `content`/`blocks`）、`message.received`（改写 `content`）、`permission.request`、`tool.beforeCall`（cancel → 按 reject 选项应答）为 gate 类；其余为通知/投影类（`session.*` 携带 `{ session, source }`，canonical 投影类携带 `{ owner, event }`）。注意：`message.user.beforeSend` 全宿主唯一方言是 `{ source, content, blocks }`——改写 `message` 字段自 1.3 起无效。

权限钩子的实际权力（知情声明）：`permission.request` 的 allow/deny 在 bypass/auto 判定**之前**短路；modify 过滤掉全部 allow 语义项时，bypass/auto 会按过滤后集合选取（极端等价于自动拒绝）。即插件可逆转 bypass 语义——宿主当前仅做声明校验，不设执行时确认（与 D16 全信任前提一致）。钩子驱动的 allow/deny 应答只匹配对应语义选项（allow 前缀 / reject 前缀），请求不含该语义项时不伪造应答、交回常规流程。

结果：

```ts
{ action: 'continue', event? }
{ action: 'cancel', reason }
{ action: 'respond', output }
void
```

配置：

```text
mode: notification | pipeline
execution: blocking | background
failurePolicy: continue | abort | disable-hook | disable-plugin
```

Hook 默认超时按锚点预算表执行：gate 类（`message.user.beforeSend` / `message.received` / `permission.request` / `tool.beforeCall`）3000 ms，通知与投影类 1000 ms（`hookTypes.ts` 的 `HOOK_TIMEOUT_BUDGET_MS` 为单一来源）；definition 显式 `timeoutMs` 可覆盖。Runtime 保留最近 trace，并在连续失败达到阈值后熔断（按 pluginId 键控：同插件任一钩子连续失败，该插件全部钩子一同熔断一个冷却周期）。`failurePolicy: 'disable-plugin'` 会调用唯一产品 `PluginRuntime` 停用整个插件；若 cleanup 不完整，trace 会追加 `plugin-disable-failed`，实例进入 `cleanup-failed`，而不是只静默禁用当前 handler。

### 6.3 Workspace

```ts
workspace.registerType(definition)
workspace.open(input)
workspace.focus(id)
workspace.close(id)
workspace.list()
workspace.listTypes()
workspace.describe(kind)
```

`WorkspaceTypeDefinition` 包含：

```ts
{
  kind,
  label,
  singleton,
  getSingletonKey,
  sidebarMode,
  launch?,
  component,
  sidebar?,
  createInitialState,
  serialize,
  deserialize,
  canClose?,
}
```

`launch` 决定该类型如何进入 Registry 驱动的 Sheet Launcher：

```ts
launch: {
  kind: 'example.inspector',
  title: 'Inspector',
  description: '检查插件运行状态',
  launchable: true,
  icon: 'activity',
  category: 'example.tools',
  categoryLabel: 'Example 工具',
  categoryOrder: 400,
  order: 20,
  keywords: ['inspect', '诊断'],
}
```

`icon` 是由 Host 解释的稳定字符串，不是 React 组件。当前内置键包括 `activity`、`agent`、`boxes`、`clock`、`folder-tree`、`globe`、`history`、`layout-dashboard`、`messages`、`plus`、`search`、`settings`、`sliders`、`waypoints`；未知键安全降级为通用 Workspace 图标。**Agent 左栏模块的 `icon` 与 `headerActions[].icon` 消费同一张映射表**（见 §6.8）。`categoryOrder` 与 `order` 只控制 Launcher 排序，不是跨插件视觉 token。

注意：当前外置 UI 插件不共享宿主 React 组件契约。通用第三方 UI 优先使用隔离 UI Surface；第一方 Workspace React 类型属于当前主构建内部契约。

### 6.4 Renderer

```ts
renderer.registerMessageRenderer(definition)
renderer.registerContentRenderer(definition)
renderer.registerToolRenderer(definition)
renderer.registerCodeHighlighter(definition)
```

所有 definition 需要：

```text
id
priority
fallback
canRender(input)
onError?(error, input) → fallback | rethrow
```

工具渲染器可提供 summary、search text、output label 和 diff candidate 判断。代码高亮器返回 HTML 字符串或 `null`。

Renderer Engine 与视觉风格正交。用户可在“设置 → 外观 → 渲染器”选择消息渲染引擎（Renderer Suite 选择器，呈现偏好持久化）；`auto` 按 `priority / fallback / canRender` 解析。宿主向 `RenderSurface.mount/update` 同时提供语义 `messageProps`、可序列化 `appearance` 和兼容第一方 React facade 的 `component/componentProps`。外置渲染器应消费语义载荷，不应执行宿主 React Component。

### 6.4.1 Presentation Profile（渲染风格）

```ts
context.presentation.registerProfile({
  id: 'example.gui-reading',
  label: 'GUI Reading',
  family: 'gui',
  interfaceMode: 'modern-gui',
  order: 300,
  tokens: {
    msgStyle: 'bubble',
    messageLayout: 'bubble',
    msgFont: 'system',
    inputVariant: 'composer',
    ccVariant: 'glass',
  },
  assets: { assistantGlyph: '✦', runningGlyph: '▶', completedGlyph: '✓' },
})
```

Profile 只能声明 `themeFieldDefs` 中已验证的结构令牌，不直接挂载 UI，也不决定 React/Solid。`interfaceMode` 只声明 Profile 在哪个现有模式的选择器中出现，可选 `modern-gui` / `terminal-like`；省略时按兼容规则归入 `terminal-like`。它不能注册或切换新的 Interface Mode。注册项由 owner/scope 管理，并参与 shadow hot-swap。

Interface Mode 是 Application Shell 的应用级契约，不是 Renderer、Presentation Profile、Theme Preset 或 Skin。插件通过 `context.interfaceModes.registerMode(contribution)` 注册完整模式（`workbench` 支持 `renderer-suite` / `host` / `isolated-surface` 三种渲染来源，激活期做跨注册表引用校验），并随 Scope 回收、参与 shadow hot-swap。

模式可用 `shellRecipeId` 引用一个 **Shell Recipe**（`context.shellRecipes.registerRecipe`）：声明会话侧栏与上下文面板的所在侧（`sidebarSide` / `contextPanelSide`，枚举 `left` / `right`，二者必须互斥）。Shell Recipe 只参数化排列——骨架（标题栏、侧栏壳、右栏壳、拖拽区、窗口控制）始终由宿主渲染，重排经 `.app` 上的解析值数据属性（`data-shell-sidebar-side` 等）驱动 CSS flex order 实现，DOM 结构不变；引用悬空的模式在激活期被拒绝，并走既有回退链落回默认模式（ADR-0003）。

### 6.4.2 字体贡献与视觉语义

```ts
context.fonts.registerFont({
  id: 'example.readable-ui',
  label: 'Readable UI',
  family: "'Inter Variable', 'Segoe UI', sans-serif",
  roles: ['interface', 'content'],
  order: 300,
  sample: '清晰、自然、适合长时间工作',
})
```

`roles` 可为 `interface`、`content`、`code`。注册后字体会出现在对应的设置选择器中；用户选择保存稳定 id，插件停用时界面安全回退到系统字体。插件应通过自己的样式资源声明随包字体的 `@font-face`，宿主不会代插件下载远程字体。

插件自定义 UI 应优先消费 SDK 导出的 `VISUAL_SEMANTIC_TOKENS` 对应 CSS 变量，例如 `--surface-raised`、`--state-selected-bg`、`--state-focus-ring`、`--state-danger-surface` 与 `--motion-standard`，不要复制宿主的透明度、阴影或动画毫秒值。

### 6.4.3 会话创建贡献、首轮指令与 preflight

`context.sessionCreation` 是开放式会话创建管线，不使用 `prompt | skill | mcp` 之类封闭枚举。插件自行定义 namespaced contribution `kind` 与 JSON payload，再注册同 kind compiler，把它编译成 namespaced phase/artifact。所有注册项绑定 Scope，并参与 shadow hot-swap。

API：

```ts
sessionCreation.registerContribution(contribution)
sessionCreation.registerCompiler(compiler)
sessionCreation.registerArtifactHandler(handler)
```

kind、phase 与 artifact kind 使用至少两段的 namespaced path，例如 `example.skill/bootstrap`。payload、artifact 与 effect 必须可 JSON 持久化。创建会话时，宿主按 Registry 顺序同步编译，并把结果作为 `Session.creationSnapshot` 保存；插件之后更新或卸载不会追溯改写既有会话快照。

首轮隐藏指令示例：

```js
context.sessionCreation.registerCompiler({
  id: 'example.skill/compiler',
  kind: 'example.skill/bootstrap',
  compile: contribution => [{
    phase: 'pylon/session-first-message',
    kind: 'pylon/prompt-prelude',
    payload: { source: 'example.skill', text: contribution.payload.instructions },
  }],
})

context.sessionCreation.registerContribution({
  id: 'example.skill/default',
  kind: 'example.skill/bootstrap',
  failurePolicy: 'required',
  payload: session => ({
    instructions: `在 ${session.workdir || '当前工作区'} 启用 Example Skill。`,
  }),
})
```

`pylon/session-first-message + pylon/prompt-prelude` 是宿主提供的首轮前导协议。Profile Persona 本身也由第一方插件通过这条普通贡献链编译，而不是另设旁路。用户的会话提示词和旧 commandSet 指令会依次叠加。Rust 发送门禁只在第一个非 `/` 命令消息前隐藏拼接；成功结束后消费，发送失败则保留供重试。UI 回显仍只显示用户原文。

MCP / 浏览器 / 电脑操作 preflight 示例：

```js
context.sessionCreation.registerCompiler({
  id: 'example.browser/compiler',
  kind: 'example.browser/bootstrap',
  compile: contribution => [{
    phase: 'pylon/session-preflight',
    kind: 'example.browser/prepare',
    payload: contribution.payload,
  }],
})

context.sessionCreation.registerArtifactHandler({
  id: 'example.browser/prepare-handler',
  phase: 'pylon/session-preflight',
  kind: 'example.browser/prepare',
  async run(artifact, { session, signal }) {
    // 可在这里启动/检查插件自己的浏览器或电脑操作进程。
    if (signal.aborted) throw signal.reason
    return [{
      kind: 'pylon/acp-new-session-options',
      payload: {
        mcpServers: [{
          id: 'example-browser',
          name: 'Example Browser',
          transport: 'stdio',
          enabled: true,
          command: artifact.payload.command,
          args: artifact.payload.args ?? [],
        }],
      },
    }]
  },
})

context.sessionCreation.registerContribution({
  id: 'example.browser/default',
  kind: 'example.browser/bootstrap',
  payload: { command: 'example-browser-mcp', args: [] },
})
```

`pylon/session-preflight` 在 ACP `session/new` 之前运行；`pylon/acp-new-session-options` 当前消费 `mcpServers`。MCP 配置仍要经过 Rust 的数量、传输、URL、命令、参数和重复 identity 校验。提示文字不会授予工具能力；真实浏览器/电脑操作必须由 handler、插件进程或 MCP server 提供。

失败与预算：

- contribution 默认 `failurePolicy: optional`：失败写入快照/phase 诊断并跳过；`required` 会阻止本地创建或远端 `session/new`；
- compiler 同步预算当前为每项 50 ms；artifact 总量上限 256 KiB；贡献数上限 128；
- artifact handler 当前每项预算 5 秒，接收 `AbortSignal`；phase effect 总量上限 256 KiB；
- 快照冻结的是解析后的 JSON，不是插件代码。既有会话后续需要再次运行插件私有 phase 时，如果对应 handler 已卸载，按 artifact 的 failure policy 处理。

### 6.5 Services

当前 service kind：

```text
search
export
event-projector
session-state
agent-instance-sink
tool-dictionary-sink
```

注册：

```js
context.services.register('search', 'example.search', provider)
```

Service 注册会随 Scope 回收。当前公开 API 只有 `register`，没有面向外置插件的通用 `resolve/acquire`。`agent-instance-sink:pylon.agent-instances` 与 `tool-dictionary-sink:pylon.tool-dictionary` 是 Product Shell 和第一方 Agent/Tool 插件之间的保留 contribution port；第三方插件不要注册或依赖这些保留 id。Host 通过 `PluginServiceRegistry.resolveRequired()` 解析必需端口，缺失或重复都会返回结构化错误并让 Application bootstrap 降级。

### 6.6 Session / Turn namespace

每个插件按 plugin id 隔离：

```ts
sessions.getPluginMetadata(sessionId)
sessions.setPluginMetadata(sessionId, patch)
sessions.getPluginContext(sessionId)
sessions.setPluginContext(sessionId, patch)

turns.ensure(turnIdentity)
turns.getPluginMetadata(turnId)
turns.setPluginMetadata(turnId, patch)
turns.getPluginContext(turnId)
turns.setPluginContext(turnId, patch)
```

值必须可 JSON 序列化。单插件 namespace 有大小限制；不要存二进制或大型日志。

### 6.7 UI Surface

```ts
context.ui.registerSurface({
  id: 'example.panel',
  reactVersion: '19',
  mount(container, bridge) {
    container.textContent = 'Hello from plugin'
    const off = bridge.on('refresh', detail => { /* update */ })
    return () => {
      off()
      container.replaceChildren()
    }
  },
})
```

宿主只接收 `mount/unmount`，不接收插件 React Component。插件可以携带自己的 React 版本并创建独立 root。

UI Surface Registry 已实现。`surfaceId` 需要由可见贡献点引用；Agent 左栏、Sheet 右栏和插件设置页均是正式可见宿主。

### 6.8 左右栏贡献

Agent 左栏是**一个有序的模块栈**：会话本身就是栈里的一个模块（声明 `alwaysOpen`），与插件注册的模块同构——同一条注册表、同一套外壳 / 图标 / 点击语义 / 长按拖拽 / 显隐设置。模块按 `order` 排列：

```ts
context.sidebar.registerAgentSidebarContribution({
  id: 'example.automation',
  label: '自动化',
  icon: 'waypoints',
  order: 300,
  onTitleClick: 'expand',
  collapsible: true,
  defaultCollapsed: false,
  page: { title: '自动化' },
  headerActions: [{ id: 'new-rule', label: '新建', title: '新建自动化规则', icon: 'plus' }],
  when: context => true,
  renderKind: 'isolated-surface',
  surfaceId: 'example.panel',
})
```

**注册字段**

| 字段 | 必填 | 默认 | 语义 |
| --- | --- | --- | --- |
| `id` | 是 | — | 贡献 id，也是契约（改名需迁移） |
| `label` | 是 | — | 模块标题的**唯一来源**；由宿主渲染，贡献不得再画一份 |
| `icon` | 否 | 无图标 | 稳定图标键（见下）；未知键安全降级 |
| `order` | 否 | 注册顺序 | 模块的**默认**位次；用户拖拽后被次序偏好覆盖 |
| `onTitleClick` | 否 | `'expand'` | 标题点击语义：`'expand'` 展开/折叠 · `'page'` 进入整页 |
| `collapsible` | 否 | `true` | 是否可折叠（`alwaysOpen` 的模块同样可折叠） |
| `defaultCollapsed` | 否 | `false` | 首次出现时的折叠默认值（用户显式操作以用户为准） |
| `alwaysOpen` | 否 | `false` | 常驻：**不可隐藏**、不出现在显隐设置的可改项里、首次出现时默认展开（**不压制折叠**），且**钉在模块栈底**——它不响应长按拖拽，别的模块也拖不到它下面（左栏主体如会话区因此稳定在最后） |
| `page` | 否 | 无 | `{ title }`；声明后该模块可展开成主区整页 |
| `headerActions` | 否 | `[]` | 头部动作按钮（宿主渲染，见下） |
| `when` | 否 | 恒可见 | 可见性谓词，入参 `{ activeAgentId, activeSessionId }` |
| `renderKind` | 是 | — | `'first-party-react'`（仅主构建内置）或 `'isolated-surface'`（外置插件） |
| `component` / `surfaceId` | 是 | — | 按 `renderKind` 二选一 |

**注册期校验（fail-closed，任一不满足即拒绝注册）**：`id` / `label` 非空且无首尾空格；`onTitleClick` 只能是 `expand` / `page`；**`onTitleClick: 'page'` 必须同时声明 `page`**（点了没处去是死路，不做静默降级）；`headerActions[].id` 非空、不重复且 `label` 非空；`page.title` 非空；`isolated-surface` 的 `surfaceId` 非空。

**点击方案**（三种全部由此表达）：

| 想要的 | 声明 |
| --- | --- |
| 点击展开/折叠 | `onTitleClick: 'expand'`（默认） |
| 点击进入新页面 | `onTitleClick: 'page'` + `page`（宿主另给一个独立折叠钮，因为标题已被占用） |
| 都要 | `onTitleClick: 'expand'` + `page` —— 标题负责展开，模块头**自动出现**「打开」按钮 |

**模块外壳（图标、标题、折叠钮、`headerActions`）全部由宿主渲染**，贡献只画模块内容。用户**长按模块头**即可拖拽改次序（没有独立拖拽手柄）。

**`headerActions` 的回派**：宿主渲染按钮，语义留在贡献。`first-party-react` 贡献在挂载期调用 `props.registerBlockActionHandler(fn)` 注册处理器（卸载时传 `null` 注销），宿主点击时以 `actionId` 回调；`isolated-surface` 贡献改为从 `host:input.blockAction` 读请求（含 `nonce`，重复点击可区分）。

**props 契约（`first-party-react`）**：贡献组件收到

| 字段 | 语义 |
| --- | --- |
| `presentation` | `'block'`（左栏模块内）或 `'page'`（主区整页）——**同一组件两种体量** |
| `collapsed` | 是否处于折叠；`page` 体量恒为 `false` |
| `activeAgentId` / `activeSessionId` | 当前 Agent 与会话 |
| `sessions` / `workspaces` / `liveGeneratingSources` | 与工作台同源的会话、工作区与运行中来源；会话对象自带 `pinned?`（置顶，自 API 2.3 起）与 `archivedAt?` |
| `registerBlockActionHandler` | 见上 |
| `onBlockAction` | 占位（宿主回派走注册的处理器；保留字段以稳定接口形状） |
| `onSelectSession` / `onDeleteSession` / `onExportSession?` / `onArchiveSession?` / `onOpenSessionSettings` / `onRenameSession` / `onToggleSessionPin?` | 会话操作回调（`onToggleSessionPin` 自 API 2.3 起：切换置顶，置顶的会话排在其所属工作区最前） |
| `onCreateLooseSession` / `onCreateWorkspace` / `onCreateWorkspaceSession` | 创建入口 |

**wire 契约（`isolated-surface`）**：宿主经 `host:input` 下发

```ts
{
  activeAgentId, activeSessionId,
  presentation: 'block' | 'page',
  collapsed, pageOpen,
  blockAction: { actionId, nonce } | null,
  sessions: { id, name, workspaceId }[],
  workspaces: { id, name, rootPath }[],
}
```

可发的受控事件：

| 事件 | detail | 语义 |
| --- | --- | --- |
| `host:select-session` | `sessionId` | 选中会话 |
| `host:create-loose-session` | — | 新建无 cwd 会话（**旧名 `host:create-chat-session` 已废弃**） |
| `host:create-workspace-session` | `workspaceId` | 在该工作区下新建会话 |
| `host:open-session-settings` | `sessionId` | 打开会话设置 |

**整页渲染的是同一个贡献组件**，只是 `presentation: 'page'`——不需要维护两份组件，两种体量共享同一批数据与回调。整页**替换该 Sheet 的聊天视图，但不是新 Sheet**：左栏仍是该 Sheet 的左栏，Esc 或页面头部「返回」回到聊天。

**内置模块参考**：`builtin.sidebar.module.search`（搜索——**独立模块**，VSCode 搜索侧栏那一类专属面板：自持查询、按工作区分组的命中结果、清除与命中计数；它**不过滤**会话列表，二者是两回事）、`builtin.sidebar.module.sessions`（会话，`alwaysOpen`）、以及四个 mock 模块（定时 / 自动化 / 任务 / 扩展）。**模块自己拥有自己的查询**——宿主不再下发 `query`，插件想过滤自己的内容就在自己的组件里存。

**顺序与显隐**是跨 Sheet 的界面偏好，存放在独立键 `pylon-sidebar-modules-v1`（**不是** `pylon-workspace-layout-v3`）：用户在左栏**长按模块头拖拽**改顺序，在「设置 → 侧栏 → 模块」里改显隐；`alwaysOpen` 的模块不可隐藏、也不参与排序（钉在栈底，拖拽落点被钳在钉区之前）；偏好里指向已卸载模块的 id 被忽略（插件停用不会留下悬挂项）。次序偏好在收纳时统一收敛，因此手改过的旧偏好同样不会把常驻模块排到前面。

右栏面板（上下文面板）注册：

```ts
context.contextPanel.register({
  id: 'example.context',
  workspaceKind: 'agent',
  label: 'Example',
  order: 300,
  renderKind: 'isolated-surface',
  surfaceId: 'example.panel',
})
```

**面板选择模型（API 2.2 起，见 ADR-0012）**：`workspaceKind` 是**亲和**而不是闸门——

| 字段 | 语义 |
| --- | --- |
| `workspaceKind` | **只是默认选中**：进入某个种类的 Sheet 且用户没显式选过时，右栏优先显示声明了该种类的面板。面板**不会**因为种类不匹配而消失，用户在右栏切换器里可以选任意面板（面板拿到的是当前 Sheet 的上下文，可能因此显示空态）。 |
| `scope: 'contextual'`（默认） | 与 `workspaceKind` 配套的「这个种类的家用面板」。 |
| `scope: 'global'` | 任何 Sheet 都能用；当没有任何面板声明当前 Sheet 种类时，它是默认选中的兜底。 |
| `when` | **硬闸门**：为假时面板不出现在切换器里。它表达「此刻这个面板没有意义」（例如无会话时不显示），与「适不适合这个 Sheet」是两条轴。异常按「不显示」处理并记录一条运行错误。 |

没显式选过时的默认顺序：**亲和当前 Sheet 种类的面板 → 第一个 `global` 面板 → 列表第一个**。用户一旦在切换器里选过，那次选择跨 Sheet 保持（`rightRailStore.activePanelId`），切 Sheet 不会把它抢回默认值。右栏头部的切换器列出全部通过 `when` 的面板；**切换器的标签是宿主渲染的，插件不画自己的标签行**。

`order` 越小越靠前；相同顺序由 Registry 的稳定 owner/id 顺序决定，**模块栈内按 `order` 纵向堆叠**（旧模型的「一个 mode 只挂一个贡献」使 `order` 形同虚设，现已真正生效）。两类贡献都随插件 Scope 回收，并参与 parallel hot-swap 的 shadow transaction。`first-party-react` 只供主构建内置插件使用；外置插件使用 `isolated-surface`，通过 `host:input` 接收可序列化宿主状态（含 `presentation` / `collapsed` / `pageOpen` / `blockAction`），并用受控的 `host:*` 事件请求选择会话、创建会话或收起面板。每个贡献有独立错误边界，一个插件渲染失败不会卸载主 Sheet 或其他贡献。

Workspace 自身的 `sidebar` 仍负责声明整块左栏壳；Agent 左栏内部内容、FileSheet workbench activity，以及通用右栏内容分别由对应 contribution registry 管理，不建立第二套 `kind → sidebar` 映射。

#### 6.8.1 标题栏贡献与设置齿轮菜单（API 2.1）

标题栏的**右簇只有两个控件**：一个设置齿轮菜单（`data-menu-trigger="app-menu"`）与一个右栏折叠钮。界面模式、设置域跳转、插件菜单项都在齿轮菜单里——所以「界面」与「设置」不再各占一个文字触发。右栏的**类型切换在右栏内部**（`.context-panel-tabs`），标题栏那个按钮**只负责折叠**，不提供第二处面板选择入口；右栏内部也不再有第二个折叠钮（折叠只有标题栏一处）。切换器**列出全部已注册面板**，其中不适用于当前 Sheet 的面板照列但禁用并在 `title` 里写明原因（只列可用面板时，单面板 Sheet 会只剩一个撑满的标签，看上去是标题而不是切换器）。

插件往齿轮菜单里加一项：

```ts
context.titlebar.register({
  id: 'example.menu.doctor',
  slot: 'app-menu',
  renderKind: 'command',
  label: '运行自检',
  icon: 'activity',
  order: 400,
  commandId: 'example.doctor.run',
  when: context => context.workspaceKind === 'agent',
}, { contributionId: 'example.menu.doctor' })
```

**槽位（`slot`，封闭词表）**：`left-rail` / `workspace` / `center` / `app-actions` 四个**渲染槽**沿用原语义（渲染成标题栏上的按钮或表面，`first-party-react` 或 `isolated-surface`）；`app-menu` 是唯一的**数据槽**——它不渲染成按钮，而是成为齿轮菜单「插件」段里的一项，点击时宿主执行 `commandId`（走命令注册表，见 §6.1）。

**菜单项字段**

| 字段 | 必填 | 默认 | 语义 |
| --- | --- | --- | --- |
| `id` | 是 | — | 贡献 id（也是去重键） |
| `slot` | 是 | — | 菜单项固定为 `'app-menu'` |
| `renderKind` | 是 | — | 菜单项固定为 `'command'` |
| `label` | 是 | — | 菜单项文字（宿主渲染，插件不画 DOM） |
| `commandId` | 是 | — | 点击执行的命令 id；命令不存在或不可执行时宿主吞掉错误并记录，不炸标题栏 |
| `icon` | 否 | 无图标 | 稳定图标键，与左栏模块图标同一映射；未知键降级为默认图标 |
| `order` | 否 | 注册顺序 | 段内排序 |
| `when` | 否 | 恒可见 | 可见性谓词，入参 `TitlebarContext`（`interfaceMode` / `workspaceKind` / `sheetId` / `settingsOpen`）；抛异常按「不显示」处理 |

**注册期校验（fail-closed）**：`id` 非空且无首尾空格、`label` 非空、`slot` 属于封闭词表；`slot: 'app-menu'` ⇔ `renderKind: 'command'`（两者互相绑定，错配即拒绝）、`commandId` 非空；其余两种 renderKind 各自的 `component` / `surfaceId` 校验照旧。**菜单外壳（分组标题、图标、键盘导航、错误边界）全部归宿主**——插件只声明「叫什么、什么图标、点了跑哪条命令」，与左栏模块同一条纪律。

齿轮菜单的键盘语义与其它菜单一致：`↓` / `↑` / `Home` / `End` 在**整段**菜单项之间移动（跨段连续），`Esc` 关闭并把焦点还给齿轮。

### 6.9 Application

```ts
context.application.register({ id, component })
```

这是第一方 Shell / Application 使用的宿主 React 契约。外置插件不应依赖宿主 React 组件类型；普通第三方 UI 使用 `context.ui.registerSurface()`。

### 6.10 插件设置页与参数

外置插件先注册隔离 Surface，再把它贡献到设置页：

```ts
context.ui.registerSurface({ id: 'example.settings.surface', reactVersion: '19', mount })
context.settings.registerPage({
  id: 'example.settings',
  label: 'GUI 化渲染',
  description: '配置布局、材质和交互参数',
  order: 300,
  renderKind: 'isolated-surface',
  surfaceId: 'example.settings.surface',
})

context.settings.getValue('density')
context.settings.setValue('density', 'compact')
context.settings.removeValue('density')
context.settings.subscribe(() => { /* 同插件 namespace 已更新 */ })
```

参数必须可 JSON 序列化，按 plugin id 隔离并持久化。设置 Surface 通过 `host:input` 接收 `{ pluginId, pageId, values }`，通过 `settings:set`（`{ key, value }`）或 `settings:remove` 请求宿主写入。外置插件不能贡献宿主 React Component；`first-party-react` 仅供主构建内置插件。

插件还可以修改宿主已有候选型设置的选项视图：

```ts
context.settings.registerOptions({
  id: 'example.message-style-options',
  target: 'theme.msgStyle',
  order: 200,
  remove: ['terminal'],
  upsert: [
    { value: 'bubble', label: '紧凑气泡' },
    { value: 'cards', label: '分层卡片', description: '由 Example Renderer 提供' },
  ],
})
```

- 主题字段目标使用 `theme.<ThemeFieldKey>`；当前宿主消费 `select`、`fontPicker` 和字段私有 `color` 色板贡献。
- 每个贡献先执行 `remove`，再执行 `upsert`；同值 upsert 可修改 `label`、`description`、`disabled` 和 `order`。
- 多插件按 Registry layer/priority/order 确定性叠加，注册项随 Scope 回收，并参与 shadow hot-swap 原子替换。
- 该 API 不取得字段值、持久化、联动或控件渲染的所有权。当前值被删除时，Host 保留原值并显示“已不可用”，不会静默改写用户配置。

完整协议见 [插件设置选项贡献](../Pylon-插件设置选项贡献.md)。

### 6.11 插件 SDK（@pylon/plugin-sdk）

插件作者不直接 import 宿主模块，统一从 SDK 引用宿主契约与 helpers：

```ts
import {
  definePlugin,
  createPluginLogger,
  createSettingsSurface,
  VISUAL_SEMANTIC_TOKENS,
  type PluginActivationContext,
  type CommandDefinition,
} from '@pylon/plugin-sdk'
```

事实源为 `src/sdk/index.ts`；引用方式为路径别名（tsconfig `paths` 与 esbuild `--alias` 都指向 `src/sdk/index.ts`，见 §14）。SDK 的打包约束：

- 类型一律 `export type` re-export（`PluginActivationContext`、`CommandDefinition`、`HookDefinition`、`PluginUiSurface`、`WorkspaceTypeDefinition`、renderer/settings/presentation/sessionCreation/process/scope 等），编译期消失；
- 运行时值仅限常量表与纯函数，禁止 import 宿主运行时模块——SDK 可安全内联进插件 bundle，不会泄漏宿主代码。

API：

| 成员 | 用途 |
|:--|:--|
| `definePlugin(module)` | 生命周期定义的 checked 包装：缺 `activate` 或生命周期成员非函数立即报错 |
| `validatePluginManifest(value)` | 解析并校验 `pylon-plugin.json`（等价宿主 parse，含已删除字段拒绝） |
| `createPluginLogger(pluginId)` | 统一 `[pluginId]` 前缀、琥珀标签的 console 封装 |
| `createSettingsSurface(definition)` | 声明式设置页（见下） |
| `VISUAL_SEMANTIC_TOKENS` / `VISUAL_SEMANTIC_ROLE_TOKENS` | 宿主视觉语义 token 名（§6.4.2 纪律的唯一真值） |

`createSettingsSurface` 把 §6.10 协议（`host:input` 进、`settings:set` 出）封装成字段清单，纯 DOM 渲染、样式消费语义 token，返回值直接交给 `context.settings.registerPage`：

```ts
context.ui.registerSurface(createSettingsSurface({
  description: '示例设置',
  fields: [
    { type: 'text', key: 'greetingName', label: '问候名' },
    { type: 'toggle', key: 'decorate', label: '装饰用户消息' },
  ],
  onChange: (key, value) => { /* 提交后回调（宿主持久化回流会再次触发渲染） */ },
}))
context.settings.registerPage({
  id: 'example.settings-page', label: 'Example', order: 900,
  renderKind: 'isolated-surface', surfaceId: '…',
})
```

可运行的完整示例（manifest + SDK 入口 + scoped styles + 构建脚本）：`examples/web-plugins/hello-starter`。

#### 6.11.1 测试基建（@pylon/plugin-sdk/testing）

SDK 的 testing 子路径提供 `createMockContext(options?)`，让插件单测脱离真实宿主运行：

```ts
import { definePlugin } from '@pylon/plugin-sdk'
import { createMockContext } from '@pylon/plugin-sdk/testing'

const ctx = createMockContext({ pluginId: 'starter.hello' })
await plugin.activate(ctx)
await ctx.__commands.execute('starter.hello.ping', { name: 'Pylon' })
const result = await ctx.__hooks.dispatch('message.user.beforeSend', event)
const driver = ctx.__ui.mount('starter.hello.settings')   // 真实 DOM + 桥
driver.hostInput({ greetingName: '新值' })
await ctx.__scopeDispose()                                 // 真实 Scope 回收纪律
```

语义：`__commands.execute` / `__hooks.dispatch`（按 priority 排序的 pipeline 归约）/
`__ui.mount`（挂载即派发 host:input，settings:set 回写 settings 存储，与
PluginSettingsPageHost 同款）/ `__settings` / `__storage` / sessions·turns 为内存实现；
其余 13 个 API 面为记录式 Proxy（调用被记录、返回 undefined）——覆盖不到的
行为用真实宿主或集成测试验证。插件测试文件 import 此子路径，生产 bundle
不会包含它。

#### 6.11.2 存储 API（API 1.1 新增）

`context.storage`：按 pluginId 隔离的 KV 存储，值可 JSON 序列化；
每插件 1 MiB 软配额，超限抛 `PluginStorageError`，不静默丢弃。
与 settings 的分工：settings 是“设置页可编辑的用户偏好”，storage 是
“插件私有运行状态”。

```ts
context.storage.setValue('lastQuery', { text: 'refactor', at: Date.now() })
context.storage.getValue('lastQuery')
context.storage.keys()
context.storage.clear()
```

#### 6.11.3 API 版本策略

- 宿主按 allowlist 接受 `api`：`1.0` / `1.1` / `1.2` / `1.3` / `2.0` / `2.1` / `2.2` / `2.3`（`PYLON_PLUGIN_API_SUPPORTED`）；
  旧版本插件在新宿主继续激活，未知更高版本拒绝并提示升级宿主。
- minor 版本只做加法（新增可选 context 成员与 manifest 字段）；破坏性变更加 major 并要求重写。
- `api` 低于 `1.2` 的插件不得引用高版本成员（如 1.1 的 `storage`、1.2 的 `capabilities`/`dangerousHooks`）——宿主仅在对应契约下保证其存在；1.0/1.1 manifest 出现 1.2 字段按已删除字段直接校验失败。1.3 仅扩充 Hook 锚点词表（§6.2），manifest 字段形状相对 1.2 不变。
- **2.0 是破坏性主轴**：Agent 左栏贡献由「按 `mode ('work' | 'chat')` 注册的互斥视图」改为「按 `region ('modules' | 'sessions')` 注册的堆叠区块」（§6.8）。manifest 字段形状相对 1.3 不变，因此 1.x 清单仍可解析与激活；**引用旧 `mode` 的左栏贡献必须按 2.0 重写**。`capabilities` / `dangerousHooks` 的 `>= 1.2` 谓词对 2.0 继续成立。
- **2.1 只做加法**：标题栏贡献新增 `slot: 'app-menu'`——把一项数据化菜单项注册进标题栏的设置齿轮菜单（§6.8.1）。既有槽位、字段与校验不变，2.0 插件无需改动。
- **2.2 只放宽**：右栏面板的 `workspaceKind` 从「可用性闸门」改为「默认选中的亲和」（§6.8，ADR-0012）。字段形状不变、清单无需改动，只是面板在更多 Sheet 上变得可选；`when` 仍是硬闸门。
- **2.3 只做加法**：会话视图新增可选字段 `pinned`，左栏贡献 props 新增可选回调 `onToggleSessionPin`（§6.8）。既有插件无需改动。

#### 6.11.4 SDK 发行形态

SDK 由 `bun run build:plugin-sdk` 从同一源码同时生成两种形态：

- **正常版**：`dist-plugin-sdk/normal/`，包含 `pylon-plugin-sdk.js`、
  `testing.js`、完整 `types/` 声明树和 `package.json` exports。将其复制进插件
  开发套件后，TypeScript/Node 项目可从 `@pylon/plugin-sdk` 与
  `@pylon/plugin-sdk/testing` 获得 runtime、类型和测试基建。
- **离线版**：发行包的 `resources/sdk/`，只有单文件浏览器 ESM 与
  `pylon-plugin-manifest.schema.json`，不依赖 Node、源码或 testing harness。

#### 6.11.5 发行包内开发（无源码环境）

发行包自带 `resources/sdk/pylon-plugin-sdk.js`（单文件 ESM，经 Tauri resources
打包）。**不装 Node、不碰源码仓库**也能写插件：

1. 建插件目录，把发行包 `resources/sdk/pylon-plugin-sdk.js` 复制进去；
2. 写 `pylon-plugin.json`（用随包的 `pylon-plugin-manifest.schema.json` 做编辑器校验）；
3. 入口用**纯 JS ESM**，相对引用随包 SDK：

```js
import { definePlugin, createPluginLogger } from './pylon-plugin-sdk.js'

export default definePlugin({
  async activate(context) { /* 同 §6 契约 */ },
  async deactivate() {},
})
```

4. "设置 → 插件" 安装该目录。入口经 `import(entryUrl)` 以真实 URL 加载，
   ESM 相对导入按入口文件自身解析——无需任何打包器。

边界：纯 JS 路径没有类型检查（SDK API 表见本章各节与 starter 示例）；
需要类型声明或 `createMockContext` 时使用正常版 SDK（插件开发套件的 `sdk/`）。
打包脚本对离线 runtime 有 64KB 体积守卫，并拒绝 testing/宿主运行时闭包；超限或
依赖泄漏说明 `src/sdk` 边界被破坏，构建会直接失败。

---

## 7. Stylesheet 生命周期

Manifest：

```json
{
  "web": {
    "entry": "./index.js",
    "styles": [
      "./styles/base.css",
      "./styles/theme.css"
    ]
  }
}
```

Runtime 行为：

- 为每个路径生成带 runtime cache bust 的 `pylon-plugin://` URL；
- 创建 `<link rel="stylesheet">`；
- 候选阶段使用 `media="not all"`，不提前污染当前 UI；
- activate 成功后移除 `media` 并启用；
- activation rollback、disable、reload、update 时随 Scope 删除 link；
- DOM 节点带 `data-pylon-plugin-style` 与 `data-pylon-plugin-runtime`。

建议 selector 以插件 id 或稳定 surface 属性限定：

```css
[data-plugin-id="example.plugin"] .example-card { ... }
[data-pylon-surface="workspace"] .example-card { ... }
[data-interface-mode="modern-gui"] .example-card { ... }
[data-interface-mode="terminal-like"] .example-terminal-row { ... }
```

不要写无作用域的 `button {}`、`body {}`、`* {}`。

---

## 8. 资源

包资源 canonical URL：

```text
pylon-plugin://<packageInstanceId>/<path>?runtime=<runtimeInstanceId>
```

生产 WebView2 会转换成平台可加载 URL。资源协议支持：

- MIME；
- CORS；
- Range；
- 路径逃逸与符号链接防护；
- 图片、字体、WASM、二进制大文件。

前端内部 typed client 具备：

```ts
resourceUrl(packageInstanceId, path, runtimeInstanceId?)
openStream(packageInstanceId, path, signal?)
readRange(packageInstanceId, path, start, end, signal?)
```

这些 package client 方法目前不是完整暴露在外置 `context` 上的通用 Files API。插件入口可直接引用自己已知的资源相对路径时，优先通过 CSS、模块内 URL 或已提供的宿主 surface 数据传递；需要通用文件能力时应先核对当前公开 context。

---

## 9. Process Supervisor

Manifest：

```json
{
  "executables": {
    "echo": {
      "windows-x86_64": "./bin/windows-x86_64/echo.exe",
      "linux-x86_64": "./bin/linux-x86_64/echo",
      "macos-aarch64": "./bin/macos-aarch64/echo"
    }
  }
}
```

入口：

```js
export async function activate(context) {
  const process = await context.process.spawn('echo', {
    protocol: 'json-rpc',
    cwd: { namespace: 'runtime' },
    restart: {
      policy: 'on-failure',
      maxAttempts: 2,
      backoffMs: 250,
    },
    shutdown: {
      method: 'json-rpc',
      timeoutMs: 2000,
    },
  })

  const ready = await process.request('echo', { ready: true }, {
    timeoutMs: 30000,
  })
  if (!ready?.ready) throw new Error('readiness failed')
}
```

协议：

```text
raw
lines
json-lines
json-rpc
http
```

cwd namespace：

```text
package
data
runtime
```

Handle：

```ts
write(data)
request(method, params?, { signal, timeoutMs }?)
terminate()
kill()
onStdout(listener)
onStderr(listener)
onExit(listener)
dispose()
```

通过 `context.process.spawn()` 创建的 handle 自动加入 Scope。Windows 使用进程树监管；插件停用时不会只杀父进程。

可运行示例：

- `examples/process-plugins/process.json-rpc-echo`
- `examples/update-plugins/update.shadow-echo-v1`
- `examples/update-plugins/update.shadow-echo-v2`
- `examples/update-plugins/update.shadow-echo-failure`

---

## 10. 热更新事务

模式：

```text
parallel
exclusive
soft-remount
restart-required
```

`parallel` 更新流程：

```text
stage 新包
→ import 新 entry
→ 创建新 identity / Scope
→ prepare
→ 候选样式预加载
→ 候选 contribution 写入 Shadow Registry
→ validate
→ commit contribution
→ 新请求切到新实例
→ 等待旧 Hook lease 排空
→ commit active package pointer
→ deactivate + dispose 旧实例
```

失败：

```text
revert/rollback candidate contribution
→ dispose candidate Scope
→ abort stage
→ 保留旧实例、旧 pointer、旧进程和旧样式
```

`exclusive` 要求旧定义提供 `suspend/resume`。`soft-remount` 会重挂 Application 子树。`restart-required` 在进程内 reload 时抛出明确错误。

---

## 11. 安装、存储与版本

Native Store：

```text
<config_root>/pylon/plugins/
├─ packages/<plugin-id>/<package-instance>/
├─ data/<plugin-id>/
├─ runtime/<runtime-instance>/
├─ transactions/
└─ state.json
```

`state.json` schema 2 保存：

```text
disabled
activeVersions
packageHistory
skinBindings
```

安装目录被复制为不可变 package instance。不要让插件直接修改 `packages/` 或 `state.json`。

当前设置页支持：

- inspect directory；
- install / update；
- enable / disable；
- reload；
- uninstall；
- list / refresh。

底层 typed client 还支持 versions、rollback、stream、Range 等能力，但并非全部已有设置页按钮。

---

## 12. Pylon CLI / Agent Tool

运行中控制面暴露单一 Agent Tool：

```text
pylon_cli
```

输入：

```json
{
  "command": "plugin list",
  "args": {},
  "timeoutMs": 30000
}
```

CLI 壳当前提供 58 个固定控制命令，完整参数见 [Pylon CLI 命令表](Pylon-CLI-命令表.md)。主要分组：

```text
plugin list / inspect / enable / disable / reload
package list / inspect / install / versions / rollback / uninstall
hook list / trace
command list / inspect / exec
registry list
agent list / import / set-default
session list / inspect / create / send / messages / close / cancel / config / export
approval get / set
interaction list / respond
workspace registry list / create / update / delete / search
skin schema / draft create / draft patch / preview / capture / commit / rollback
process list / logs / terminate
workspace list / open / close
operation inspect / logs / cancel
event log
```

内置第一方插件当前注册 64 个可执行 Command，覆盖核心会话快捷命令、File/Git、布局与 Sheet、呈现风格、插件设置、主题/配置预检、完整 Skin 闭环和 Browser Sheet 控制面。运行时事实以以下命令为准：

```powershell
pylon-cli command list --executable true --json
pylon-cli registry list --json
pylon-cli command inspect example.command --json
```

插件通过 `context.commands.register()` 注册且提供 `execute` 后，会自动获得 CLI 入口：

```powershell
pylon-cli command exec example.command --args '{"key":"value"}' --json
```

无需把插件命令加入共享 CLI manifest；manifest 只维护固定控制壳。命令输入/输出应可 JSON 序列化，长操作必须消费 `signal`。没有 `execute` 的命令仍可用于输入建议和 Agent prompt，但 CLI 执行会明确返回“命令不可执行”。

示例：

```json
{
  "command": "plugin reload",
  "args": {
    "pluginId": "service.example",
    "mode": "parallel"
  }
}
```

变更命令返回 `operationId`。可通过 operation 命令查询日志或取消仍在运行的操作。

`permission: 'read' | 'gate'` 当前是命令元数据和 UI/自动化策略依据，不是独立安全沙箱；CLI 仍继承命名管道 SID 校验和运行中内核边界。敏感插件命令必须在自身 `execute` 中继续校验参数与作用域。

`plugin enable/disable/reload` 只控制 live Runtime；`package inspect/install/enable/disable/reload/versions/rollback/uninstall` 同时管理外置包的持久启用状态、不可变安装包和 active pointer。为避免运行实例和包指针分裂，`package rollback` 要求先执行 `package disable`，回滚后再执行 `package enable`。

---

## 13. 最小示例

`pylon-plugin.json`：

```json
{
  "schema": 1,
  "id": "command.hello",
  "name": "Hello Command",
  "version": "1.0.0",
  "api": "1.0",
  "kind": "feature",
  "web": {
    "entry": "./index.js",
    "styles": []
  },
  "dependencies": {},
  "optionalDependencies": {},
  "conflicts": [],
  "activation": {
    "events": ["kernel.ready"]
  },
  "hotSwap": {
    "mode": "parallel",
    "drainTimeoutMs": 10000
  }
}
```

`index.js`：

```js
export function activate(context) {
  context.commands.register({
    id: 'command.hello.say',
    name: 'hello',
    aliases: ['hi'],
    description: '返回 Hello',
    priority: 100,
    execute: ({ args }) => ({
      message: `Hello, ${args?.name ?? 'Pylon'}`,
      runtimeInstanceId: context.identity.runtimeInstanceId,
    }),
  })
}
```

安装：

```text
Pylon → 设置 → 插件 → 安装/更新 api=1.0 包… → 选择 command.hello 目录
```

---

## 14. 构建建议

入口建议使用 esbuild 或 Rollup 打成单 ESM：

```bash
npx esbuild src/index.ts \
  --bundle \
  --format=esm \
  --platform=browser \
  --alias:@pylon/plugin-sdk=<仓库根>/src/sdk/index.ts \
  --outfile=dist/index.js
```

包目录：

```text
release/command.hello/
├─ pylon-plugin.json
└─ dist/index.js
```

manifest：

```json
"web": { "entry": "./dist/index.js", "styles": [] }
```

不要把 Node-only 内置模块直接打入 Web entry。需要本地 Node/Rust/Python 能力时，作为 executable 随包分发并通过 Process Supervisor 调用。

---

## 15. 调试与验证

推荐顺序：

1. 校验 manifest；
2. 在浏览器单测纯逻辑；
3. 使用 Tauri 安装真实目录；
4. 检查 Runtime 插件 identity；
5. 执行 command / hook / process readiness；
6. reload 并确认 runtime id 变化；
7. 检查旧 stylesheet、Hook、进程和 runtime 目录无残留；
8. 制作故障候选，确认旧实例回滚保留；
9. 制作 cleanup 失败，确认状态为 `cleanup-failed`、residual id 可见且“重试清理”只重试残留；
10. 分别验证 dependency missing/version mismatch/cycle/conflict 与 waiting activation diagnostics；
11. 重启 Pylon，确认满足契约且收到激活事件的 enabled 包自动恢复。

DOM 样式诊断：

```js
[...document.querySelectorAll('[data-pylon-plugin-style]')].map(node => ({
  pluginId: node.dataset.pylonPluginStyle,
  runtime: node.dataset.pylonPluginRuntime,
  href: node.href,
}))
```

CLI 诊断重点：

```text
plugin inspect
hook trace
process list
process logs
operation inspect
```

设置页同时显示“等待激活事件”“契约阻止”“启动失败”“清理失败”和“运行中（有清理残留）”。不要把 enabled、active 与 cleanup-complete 当作同一个状态。

---

## 16. 当前限制

- Plugin API 0.1 不兼容，旧插件必须重写。
- 没有签名、trust 或插件市场。1.2 的能力授权卡只约束插件**声明过**的宿主能力（当前词表仅 `plugin.management`），不是恶意代码权限沙箱。
- 第三方插件按产品决策视为完全可信本机代码；生命周期、依赖和 cleanup 隔离不是恶意代码安全沙箱。
- CSS 没有 selector 沙箱。
- 第一版入口应为单 JS bundle，不支持插件入口继续拆动态 chunk。
- storage 为单窗口 localStorage 持久化（无跨端同步、无迁移框架）；Files/Resources 完整 API 仍缺。
- UI Surface Registry、左右栏与插件设置页挂载点已完成；完整 AgentSheet Workbench 级替换仍是第一方实验边界，第三方当前从 message/content/tool renderer 粒度接入。
- Host setting-option contribution 已开放；它只能增删改候选项，不能借此注册新的 Interface Mode 或接管宿主设置值。
- 外置插件不应直接依赖 Pylon 内部 Zustand Store 或第一方 React 组件。
- `application.register` 和第一方 Workspace React contract 属于主构建内部边界，第三方 UI 应优先走隔离 surface。
- 公共 context 尚未提供完整 Files/Resources/Storage API；不要依据施工总书草案调用未进入 `BuiltinPluginActivationContext` 的字段。

---

## 17. 源码真值

开发时以这些文件为准：

```text
src/kernel/kernelBootstrap.ts
src/kernel/kernelBootstrapServices.ts
src/plugin-runtime/pluginCompositionRoot.ts
src/plugin-runtime/builtinPluginBootstrap.ts
src/plugin-runtime/packageManifest.ts
src/plugin-runtime/pluginContractResolver.ts
src/plugin-runtime/packagePluginRuntime.ts
src/plugin-runtime/packageInstallationService.ts
src/plugin-runtime/pluginActivationContext.ts
src/plugin-runtime/pluginRuntime.ts
src/plugin-runtime/pluginInstance.ts
src/plugin-runtime/pluginScope.ts
src/plugin-runtime/hooks/hookTypes.ts
src/plugin-runtime/hooks/hookRuntime.ts
src/plugin-runtime/services/pluginServiceRegistry.ts
src/app/ports/productContributionPorts.ts
src/plugin-runtime/commands/commandRegistry.ts
src/plugin-runtime/workspaces/pluginWorkspaceApi.ts
src/plugin-runtime/renderers/pluginRendererApi.ts
src/plugin-runtime/presentation/pluginPresentationApi.ts
src/plugin-runtime/settings/pluginSettingsApi.ts
src/plugin-runtime/settings/pluginSettingOptionsRegistry.ts
src/plugin-runtime/settings/pluginSettingsTypes.ts
src/plugin-runtime/fonts/pluginFontApi.ts
src/plugin-runtime/session-creation/sessionCreationTypes.ts
src/plugin-runtime/session-creation/sessionCreationRegistry.ts
src/plugin-runtime/session-creation/compileSessionCreationSnapshot.ts
src/plugin-runtime/session-creation/runSessionCreationPhase.ts
src/plugins/core/sessionCreation/builtinSessionCreation.ts
src/plugins/core/sessionCreation/sessionPreflight.ts
src/workspace-sheets/workspaceTypes.ts
src/domains/interface/interfaceModeStore.ts
src/plugin-runtime/process/processTypes.ts
src/plugin-runtime/sessionData/pluginSessionDataApi.ts
src/plugin-runtime/ui/pluginUiTypes.ts
src/infrastructure/plugins/pluginPackageClient.ts
src/infrastructure/plugins/pluginProcessClient.ts
src-tauri/src/plugin_cmds.rs
```

相关示例：

- [Process Supervisor examples](../../examples/process-plugins/README.md)
- [用户版说明书](Pylon-插件系统说明书-用户版.md)
- [插件设置选项贡献](../Pylon-插件设置选项贡献.md)
- [Pylon README](../../README.md)
