# 前端可维护性与性能审查

审查日期：2026-08-29

范围：`src/components/chat`、`src/sheets/file`、`src/workspace-sheets`、runtime registry 消费点、Vite 首屏拆包。

目标：保持现有行为与契约，只收敛重复工作、稳定渲染 seam，并为后续架构深化留下可验证的建议。

## 结论摘要

本轮没有改变消息投影、工具状态、文件读取/编辑、插件选择或持久化语义。已落地的优化集中在两个热点：

1. Chat 的流式更新不再让每个静态 `MessageRendererHost` 重复 `surface.update`；已知消息位置采用 copy-on-write，未修改消息继续共享引用。
2. File 只读行渲染把改动行 membership 从线性 `includes` 改为 `Set`，编辑器语言元数据改为首次打开编辑器时加载，编辑分支不再拆整份文本行数组。

同时合并了多个 Zustand 订阅，并把 `useSyncExternalStore` 的 adapter 固定在 module scope 或由 `useCallback` 稳定，减少无关 render 造成的 unsubscribe/subscribe 抖动。Vite 的 vendor chunk 判定统一使用 normalized path，Windows 构建不再依赖路径分隔符。

## 已实施项

### Chat render hot path

涉及：

- `src/components/chat/ChatView.tsx`
- `src/components/chat/sessionRuntimeStore.ts`
- `src/components/chat/useChatRuntimeSnapshot.ts`
- `src/components/chat/GenerationFooter.tsx`
- `src/components/chat/ToolConnector.tsx`
- `src/components/ControlCenter.tsx`
- `src/components/SettingsPreview.tsx`
- `src/App.tsx`
- `src/sheets/AgentSheetView.tsx`
- `src/workspace-sheets/SheetRightSlot.tsx`

做法：

- 浏览器 benchmark/demo 消息改用 lazy `useState` initializer；最多 5000 条消息不会在每次父级 render 时重新构造。
- `MessageRendererHost` 使用 `React.memo`。比较器忽略 `rowRef`，因为该回调只是注册 seam，不是消息语义；消息 id、消息引用和 renderer context 必须保持稳定。
- `sessionRuntimeStore` 对尾部 assistant/reasoning 和已定位 tool 使用 copy-on-write。数组仍不可变，未修改消息引用保持不变，memoized row 可以跳过更新。
- 多个小的 `useStore` 订阅合并为 `useShallow` 选择器；默认值在 selector 外归一化，减少订阅数量和重复字段读取。
- registry 的 `subscribe/getSnapshot` adapter 固定，`useChatRuntimeSnapshot` 只在 `source` 改变时重建 callback。

收益：

- 流式 chunk 的 DOM/renderer 更新更接近“受影响的 row”，而不是整个历史列表。
- subscription seam 更稳定，减少无关 state 变化导致的重连。
- 语义未改变：事件顺序、消息 id、tool raw 字段、replay/canonical projection 均保持原路径。

边界：`prepareRenderableMessages`、`buildMessageLookups`、`buildChatRowDescriptors` 仍会在 ChatView 更新时扫描完整数组。因此本轮降低的是子树重渲染和 surface 更新成本，不是把长会话的父级 O(n) 投影变成 O(1)。

### File view hot path

涉及：

- `src/sheets/file/FileTabView.tsx`
- `src/sheets/file/FileCodeEditor.tsx`
- `src/sheets/file/FileSheetView.tsx`

做法：

- 只读投影的 `codeLines`/`highlightedLines` 使用 `useMemo`；编辑模式返回空行数组/空高亮，避免 CodeMirror 分支无意义地 split 大文本。
- `changedLines` 先构造 `Set`，每行高亮用 O(1) membership 查询，保留原 `data-changed` 契约。
- `@codemirror/language-data` 改为模块级共享 promise 的动态加载；只有真正打开编辑器才载入语言目录，未知扩展名和加载失败仍回退纯文本。
- `FileSheetView` 使用稳定的 registry adapter，并以 `useCallback` 固定当前 sheet 的 tab 读取函数，修复 hooks dependency 警告。

### Build and static guards

- `vite.config.ts` 对 `id` 做 slash normalization 后再匹配 React/Motion vendor，Windows 与 POSIX 构建采用同一拆包规则。
- 三个结构守卫脚本接受合并后的 selector/COW 写法，同时继续验证关键字段来自正确 store、动画 class 和改动行标记没有被移除。
- 增加 `MessageRendererHost` 回归测试：仅更换 row-ref callback 时，静态 renderer surface 不重复 update。

## 建议书：下一阶段候选

这些项目需要产品/架构选择，故本轮没有直接改动。

### A. 增量化 Chat row projection（Strong）

当前 interface 仍让 `ChatView` 每次 runtime revision 重新准备完整消息数组、lookup 和 row descriptor。可以在 `sessionRuntimeStore` 或独立 projection module 暴露“变更消息 id + revision”的只读 interface，再由 ChatView 只更新受影响 descriptor。

- locality：消息变化规则集中在一个 projection module。
- leverage：长会话每个 chunk 不必重新扫描 N 条消息。
- test surface：以 revision、受影响 id、replay 顺序作为 interface 测试。
- 风险：搜索、tool connector、AnimatePresence key 和跨会话切换必须共享同一 ordering 语义。

### B. 统一 resolved appearance adapter（Worth exploring）

Chat、SettingsPreview、ControlCenter、ToolConnector、GenerationFooter 目前各自选择相近字段并重复默认值。可建立一个小而 deep 的 appearance interface，统一默认值、冻结快照和 profile/plugin 覆盖规则。

- locality：默认值和字段演进只改一处。
- leverage：React、Solid、preview consumers 共用同一 resolved snapshot。
- test surface：覆盖缺省、插件贡献、profile 切换和旧 schema migration。
- 约束：不能让 appearance adapter 反向拥有 WorkbenchDocument 或 Session 状态。

### C. Sheet keep-alive 资源预算（Worth exploring）

`SheetLayout` 当前保活多个 Agent、File 和 Browser sheet，以保护编辑草稿和浏览器状态。打开很多 sheet 时，隐藏实例仍占用内存、订阅和 DOM 资源。可定义按 kind 的上限/LRU，并为 File 草稿提供显式 snapshot/restore seam。

- locality：生命周期策略集中在 Sheet host，而不是散落在各 Sheet。
- leverage：在不改变 close 语义的前提下控制资源上界。
- 需要决策：哪些状态必须 keep-alive，哪些可以序列化恢复。

### D. 样式与 GPU 视觉效果 profiling（Speculative）

先用真实 WebView trace 测量 `backdrop-filter`、大面积阴影、消息列表 paint 与字体加载，再决定 CSS 拆分或材质降级。没有 profile 数据前不建议大规模重写 CSS，避免改变视觉契约却得不到可证明收益。

## 契约与风险记录

- `MessageRendererHost` comparator 忽略 `rowRef` 的前提是消息 id 唯一、`messageRefs` 为稳定 `useRef(Map)`，row-ref 闭包只捕获稳定 key。若未来 rowRef 承载语义数据，必须先恢复比较字段并补测试。
- copy-on-write 只对已知位置使用；confirm-user 等需要筛选多个消息的路径仍保留原实现，避免误改匹配语义。
- 动态语言加载保留 filename matching 和纯文本 fallback；编辑器实例仍由 `FileTabView` 的 path key 管理生命周期。
- 本轮刻意没有触碰 Renderer Suite planned seam、canonical/workbench projector、SheetLayout keep-alive 上限或全量 CSS 拆分。

## 验证结果

通过：

- `npx.cmd eslint src/`
- `npx.cmd tsc -b --pretty false`
- `npm.cmd run build`
- Chat 定向测试：消息 renderer、invariants、replay、streaming、canonical projection（组合 8 个文件，54 tests）
- `npx.cmd vitest run src/sheets/file --passWithNoTests`（17 files，117 tests）

既存/并发工作树问题（未归因于本轮优化）：

- `npm.cmd run test:legacy` 仍有 8 个既存失败：`test-agent-sidebar.mts`、`test-cc-layout-roundtrip.mts`、`test-css-var-consumption.mts`、`test-demo-seed.mts`、`test-history-replay.mts`、`test-scroll-bottom-offset.mts`、`test-session-settings-form.mts`、`test-sheet-layout.mts`。
- `AgentSheetView.rendererMode.test.tsx` 的一条断言仍假设 send-before-select；工作树已有的 `agentWorkbenchCommands` 改动采用 select-before-send，导致 36 tests 中 1 条失败。该文件和对应测试在审查开始前已被并发修改，本轮未回退。
- 未跟踪的 `tmp*` 调试测试（`src/components/__tests__/tmpSettingsPresetRepro.test.tsx`、`src/domains/theme/__tests__/tmpCustomPresetRepro.test.ts`、`src/renderers/solid-workbench/chat/__tests__/tmpMarkdownCases.solid.test.tsx`、`src/renderers/solid-workbench/chat/__tests__/tmpMarkdownInspect.solid.test.tsx`）含复现代码/`console.log`；其中最后一个会使 `npm.cmd run check:solid` 因未使用 import 失败。本轮未删除或修改，以保护未知来源的工作树资产。

工作树中另有既存的文档删除、`issue.md`、`InputBar.css` 及 agent workbench 修改；均保留原样。

## 架构深化施工记录（2026-08-31）

首个巨型文件拆分 slice 已完成，目标是 `src/components/chat/chatEventController.ts`。

### Chat replay coordinator seam

新增 `src/components/chat/chatReplayCoordinator.ts`，集中承载 controller 中与 React refs、Tauri listener 和持久化无关的 replay/listener 规则：

- replay/live 增量按外部 identity reconciliation；无 identity 的 live 增量保守保留；
- 并行 listener 注册使用 `allSettled`，成功项保留、失败项可重试；
- canonical event 与 ChatEvent 的表示关系判断；
- 缓存、live、canonical 顺序合并及缺失消息定位插入；
- rendered source 判定和 replay persona 前缀清理。

`chatEventController.ts` 仅通过该 seam 调用实现，并继续 re-export `mergeReplayMessages` 与 `settleListeners`，因此现有测试和外部调用路径无需迁移。此次没有引入新的宽 facade/interface，也没有改变 runtime reducer、canonical journal 或 load generation lock 语义。

### 验证

- `npx.cmd tsc --noEmit --pretty false`
- replay/listener/controller 定向回归：6 个文件、53 tests 全部通过
- `git diff --check`

后续可在同一 seam 上继续抽离 wire ingress adapter、replay/load transaction coordinator，再评估是否收窄 `ChatControllerHandle`；每片保持可回滚并以现有 interface tests 作为护栏。

## 非巨型文件技术债扫描（2026-08-31）

本轮排除巨型文件，扫描 lint blocker、effect 依赖契约、deprecated adapter 与测试双轨。扫描报告：`%TEMP%/architecture-review-prism-debt-20260831.html`。

已处理：

- `src/domains/activity/activityLine.ts`：修复 `normalizeToolActivityLabel` 正则字符类中的无效转义，恢复全量 ESLint 通过。
- `src/sheets/browser/BrowserSheetView.tsx`：visibility/status effects 补齐 `ctx.isActive` 依赖，避免 Sheet 活跃态变化时原生 WebView 同步使用过期闭包。

待治理台账：

- 14 处 `react-hooks/exhaustive-deps` 豁免：多数有稳定 ref/setter 理由，但需要统一记录读取值、稳定性证明和失效条件，并按 FileTabView/InputBar/SheetLayout 补行为测试。
- `commandRegistry`、`rendererRegistry`、File target/provider、workspace adapter 等 deprecated compatibility adapter：先盘点生产 caller 与测试-only caller，再设 sunset 条件，禁止在 caller 未清零前删除。
- `test:legacy` 与 Vitest 双轨：按脚本建立迁移映射和删除日期，避免继续扩大排除列表。

验证：`npm.cmd run lint`、browser 4 files/10 tests、activity 4 files/33 tests、`git diff --check` 均通过。

## Solid 化后的遗留 React renderer 清理（2026-08-31）

扫描确认 `src/renderers/modern-workbench/ModernAgentWorkbench.tsx` 已无生产或测试 caller；当前 Agent 工作台入口为 `SolidWorkbenchApp`，该文件仅在旧拓扑图中留下节点。为避免继续让维护者误以为存在第二套 renderer，已删除该孤立 React renderer，并移除 `ChatView.css` 中仅服务其 DOM class 的 56 行 modern workbench 样式。

同步更新拓扑图：`SolidWorkbenchApp` 标记为当前 renderer，删除 `ModernAgentWorkbench` 节点。应用 shell、插件隔离 surface 和 contracts 中必要的 React 仍保留；本次没有触碰应用框架或插件自带 React runtime。

验证：

- `npm.cmd run lint` 通过；
- `npm.cmd run check:solid` 及 Renderer architecture guards 通过；
- AgentSheet renderer mode、composer visual contract、Solid workbench mount：3 个文件、95 tests 全部通过；
- `git diff --check` 通过。

## 类型逃逸清理（2026-08-31）

从渲染器/运行时残留扫描中挑选了最低风险的一项：移除两个非必要的 `as any`。

- `SettingsPreview.tsx` 的 `WebkitAppRegion` 改为明确的 `React.CSSProperties` 扩展类型，保留浏览器预览样式不变；
- `infrastructure/tauri/env.ts` 的 Tauri 全局探测改用已有 `TauriWindow` 类型的 unknown cast，避免绕过类型系统。

这两处均未改变运行时逻辑，只收窄了类型逃逸面。剩余 React effect 豁免仍按前一节台账保留，避免把有意的生命周期约束机械改坏。

验证：`npm.cmd run lint`、TypeScript 类型检查、组件/tauri 相关 13 个测试文件（52 tests）及 `git diff --check` 全部通过。

## 死兼容导出清理（2026-08-31）

`src/components/chat/commandRegistry.ts` 的 `FALLBACK_COMMANDS` 曾是导入期静态快照，但全仓库没有任何 caller；生产路径已经通过 `resolveFallbackCommands` / `usePluginCommandSuggestions` 从 command-set registry 动态解析。已删除该死导出，并同步移除 `builtinCommands.ts` 中过时的“双面同源”说明，避免维护者继续把静态快照当作可用 interface。

验证：全量 lint、TypeScript 类型检查、command/session command 相关 Vitest 8 tests 通过；旧的直接 `test-command-registry.mts` 脚本仍受其既有 extensionless import 运行限制影响，未作为本次回归依据。

## 死 ANSI HTML facade 清理（2026-08-31）

`src/components/chat/ansiRender.ts` 已无任何生产、测试或脚本 caller。Solid renderer 的 `AnsiBlock` 直接消费 framework-neutral 的 `stripAnsiControlSequences`，旧 facade 中的 Anser → HTML 路径不再属于当前渲染管线；已删除该孤立文件，避免维护者误以为仍存在第二套 ANSI renderer。

验证：全量 lint、TypeScript 类型检查、Solid architecture guards 与现有 ANSI/content 测试通过。

## 命令 registry 测试迁移（2026-08-31）

将已迁入 Vitest 兼容套件的 `scripts/test-command-registry.mts` 正式迁移为 `src/components/chat/__tests__/commandRegistry.test.ts`，覆盖 slash command 解析、动态 fallback suggestions、agent 上报命令归一化与前缀过滤。随后移除旧脚本，以及 `run-frontend-tests`、`legacy-runner`、`legacy-plugin-runtime-compat` 中对应的排除/动态登记。

这样 command registry 的 interface test 不再依赖 extensionless import 的 Node 直接执行，也不会继续扩大 legacy/Vitest 双轨排除列表。

验证：全量 lint、TypeScript 类型检查、legacy frontend runner、command registry/legacy compatibility 相关 Vitest 共 15 tests 通过。

### Solid built-in content renderer seam

第二个巨型文件拆分 slice 已完成，目标是 `src/renderers/solid-workbench/SolidWorkbenchApp.solid.tsx`。新增 `solidBuiltinContentRenderer.solid.tsx`，将以下 implementation 收敛到 Renderer Engine 的内建内容 adapter：

- `ContentPart` 到 Markdown、code、ANSI、file、media、search/link、diff、LSP、terminal/log、extension、structured/unknown renderer 的分派；
- Renderer semantic command 到 Workbench Host Port 的命令适配；
- extension fallback 和 session surface appearance resolution。

`SolidWorkbenchApp` 继续拥有工作台编排、Slot candidate 选择、消息/活动布局和滚动状态；本片只移动既有 fallback implementation，没有改变 Renderer Slot kind、payload、命令 capability 判定或 fallback 顺序。这样新增/修正 content kind 时不再需要进入工作台根 module，提升 renderer 规则的 locality，同时避免建立新的宽 interface。

验证：

- `npm.cmd run check:solid`：TypeScript 与四项 Solid/Renderer architecture guards 全部通过；
- Solid mount、smoke、suite completeness：3 个文件、64 tests 全部通过；
- 定向 ESLint 与 `git diff --check`。

### Solid workbench projection support seam

第三个拆分 slice 将 `SolidWorkbenchApp.solid.tsx` 中的纯投影/归一化规则移至 `solidWorkbenchProjectionSupport.ts`：canonical token 计数、activity 时间线放置、tool connector 父子来源推导、生命周期/交互 render kind 解析，以及 WorkbenchDocument 到 Solid Message 的转换。

工作台组件仍负责状态与布局编排；新 module 不持有 Solid signal、Host Port 或 DOM 引用，只提供可独立验证的 projection rules。为保持现有调用契约，`interactionRenderKind` 继续从 `SolidWorkbenchApp.solid.tsx` re-export。该 seam 减少根 module 的 domain 规则耦合，并为后续 activity projection 测试提供窄 interface。

验证：

- `npm.cmd run check:solid` 及全部 Solid/Renderer architecture guards 通过；
- interaction kind、workbench mount、smoke 回归：3 个文件、60 tests 全部通过。

## ANSI 渲染路径统一（2026-08-31）

清理 `SolidToolCard` 中遗留的第二套 ANSI 实现。此前工具执行输出仍在卡片内部重复执行 `Anser → sanitizeHtml → innerHTML`，而内建 `content.ansi` 已使用结构化的 `SolidAnsiBlock`。现在两条 Solid 渲染入口统一为同一个 ANSI adapter：

- `SolidToolCard` 移除 `anser` 与 `htmlSanitizer` 依赖，execute 输出直接挂载 `SolidAnsiBlock`；
- `SolidAnsiBlock` 保留 `.term-ansi` 兼容样式类，同时提供 `.term-ansi-block` 结构化测试 seam；
- 空 execute 输出继续走普通 `<pre><code>` fallback，避免为无文本输出创建空 ANSI surface；
- 更新工具卡片回归测试，验证结构化 block、文本内容和控制序列注入不会重新出现。

这样 ANSI 的解析、控制序列剥离、颜色白名单和可访问文本只需在一个 module 中维护，避免 framework-specific HTML facade 再次分叉。

验证：

- `npx.cmd vitest run src/renderers/solid-workbench/chat/__tests__/ToolDiffTask.solid.test.tsx src/renderers/solid-workbench/chat/__tests__/TextBlocks.solid.test.tsx`：2 个文件、15 tests 通过；
- 全量 lint、TypeScript 检查、ChatView 结构守卫与 `git diff --check` 均通过；React MessageRow/renderer host 13 tests、Solid ReasoningStates/MessageRow 15 tests 通过。

## ChatView React 兼容逻辑收紧（2026-08-31）

本轮审查确认 `ChatView.tsx` 仍由 `core.renderer.react` 动态加载，属于兼容 Renderer Engine 入口，暂不删除或整体迁移。先处理两个无行为收益的参数/依赖问题：

- `AssistantContent` 删除未使用的 `isStreaming` 参数，`StreamingAssistantText` 不再传递死参数；
- `ReasoningBlock` 删除从未读取的 `startedAt` 参数，流式思考不再创建无效的本地时间状态；
- React fallback `ToolCard` 的 ANSI memo 依赖改为 `[model.outputText, isExecute]`，移除 `react-hooks/exhaustive-deps` 豁免，并使依赖表达式与实际读取值一致。

这保持现有 React fallback 的视觉和生命周期行为不变，同时减少误导性的 interface 和 lint 豁免，为后续拆分 `MessageRendererHost`、消息列表和生成状态栏保留清晰 seam。

随后修复 `CodeBlock` 的异步高亮 stale-result 窗口：代码或语言变化时立即清空旧高亮，并用 language+code key 校验异步结果，防止旧 grammar 的 HTML 在新代码上短暂显示。高亮状态同时移除未使用的 `lang` 字段，保留纯文本 fallback。
