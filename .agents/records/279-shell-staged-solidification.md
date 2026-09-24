# Dev Record — #279 前端 shell 逐梯队 Solid 化(第 0~3 梯队)

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/279
- 决策：ADR-0023（前端 shell 逐梯队 Solid 化）
- 分支：`kumo/solidify`（隔离工作树 `D:/pylon-solidify-wt`，基于 `78a75a36`）
- 日期：2026-09-24

## 目标与范围

按 ADR-0023 执行第 0~3 梯队：chat 死代码出清 → 叶子 sheet（Search/History）→ 文件工作台 → shell chrome（Titlebar/TabStrip/ResizeHandle/WorkspaceMenu/SheetLauncher）。行为契约不变（DOM 形状/几何契约/sheet kind/keep-alive/插件 mount）；Solid 侧渲染器套件与 Rust/wasm 出口零改动；第 4（设置页 radix 区）/第 5（宿主根+删 react 依赖）梯队显式留待后续。

## 改动清单（按梯队）

| 梯队 | 内容 |
| --- | --- |
| 第 0 | 删 `components/chat` 孤儿 React 组件 9 文件（MessageRenderBoundary/CollapsibleRegion→后修正恢复/SpinnerGlimmer/useToolConnectors+test/useMinDisplayTime/useMessageLocation/ToolConnector+3 个配套测试） |
| 第 1 | vite/vitest/tsconfig 双侧 solid 编译面扩展到 sheets/workspace-sheets/components；`SolidMount`（React→Solid 薄桥）+ `solidStoreBridge`（zustand→Solid 信号）；SearchSheetView/HistorySheetView 迁移 |
| 第 2 | SolidMount v2（响应式 props 通道）；FileTabView/FileCodeEditor/MarkdownPreview Solid 化 |
| 第 3 | WorkspaceTitlebar/SheetTabStrip/LeftRailResizeHandle/WorkspaceMenu/SheetLauncher Solid 化；`ReactIsland`（Solid→React 逆桥）；LucideIcon（lucide 核心 IconNode 自绘）；删 React 版 WorkspaceMenu/AgentStatusLights |

## 方案要点（跨梯队机制）

1. **桥形态 = P52 D4 加载缝**：React 桥文件不写 Solid JSX、不静态导入 .solid 模块（React 类型图不触碰 .solid 类型图），经 `import.meta.glob(eager)` 缝加载，挂载函数接口在桥内声明。
2. **SolidMount v2 响应式 props**：React 渲染经 layout effect 把最新 props 推入 Solid 信号；Solid 侧 `createMemo` 引用等值去重消费（语义等价 React deps 数组）。saveReceipt/saveAnchorToken/editing 类可变字段的跨桥响应性是数据完整性契约。
3. **Solid 粒度三定律（本轮实测踩坑沉淀）**：
   - 渲染分支必须 **keyed Show 惰性创建**——Solid 的 JSX 赋值会急切实例化子树（FileTabView 编辑器预创建即以游离 DOM 存在，CM measure RAF 在 jsdom 每帧抛错，实测 invoke 45+ 次死循环即 target 对象身份不稳定 × 依赖面过宽的复合）；
   - 行内派生值一律访问器（`const active = () => ...`），否则随首渲染冻结；
   - **effect 依赖面 = React deps 同口径**：体内读到的 memo 经引用等值去重，但宿主每渲染构造的对象（如 FileViewHost 的 target）必须 untrack——「加载→渲染→推送→重载」死循环的根源。
4. **SheetLauncher 手写收敛 cmdk**：按可见行为契约实现过滤/环选/Empty/[cmdk-*] 属性词汇（App.css 消费），行为由既有测试钉死。
5. **图标**：lucide-solid 在本环境不渲染（实测 svg 空）且类名不合契约——改 lucide 核心包 IconNode 数据 + 自绘 `LucideIcon`（类名 `lucide lucide-{kebab}` 与 lucide-react 逐类一致）；图标按具名静态导入 + 显式映射表（动态键索引击穿 tree-shaking，实测 744KB chunk）。
6. **插件贡献 React 岛**：标题栏 app-actions 插件贡献按插件 API 是 React 组件（依赖 ErrorBoundary/Suspense），经 `WorkspaceTitlebarPluginIsland`（ReactIsland 逆桥）留在 React root；依赖变化由 Solid effect 调 rerender。

## 登记的测试改写（断言语义不降级）

- `searchNavigation.integration` / `tsWi02ProductionOwnerWiring` / `sheetLauncherRegistry`：`fireEvent.change` → `fireEvent.input`（Solid onInput 监听原生 input 事件，RTL change 不派发——测试事件口径而非行为变化）。
- `FileTabView.readonly` 损坏响应用例：`findByRole('status')` → `waitFor(getByRole)`（loading 态同为 role=status 且瞬态先落 DOM）。
- `SolidMount.test` 随 v2 契约改写；新增 Solid 原生冒烟：SearchSheetView ×2、HistorySheetView ×2、MarkdownPreview（既有 #276 测试穿桥零修改）。

## 已知渲染形状差异（方向均为「与聊天主链路一致」）

- 数学公式按 comrak 模型渲染 `span.math`/`div.math`（原样 latex 文本，预览无 MathRender 表现层）。
- `PylonMark.solid`/DOM 投影剔除 React 版的 `focusable` 遗留属性；布尔属性落 `"true"` 值（对齐 React 形状）。

## 验收标准与结果

- [x] 全量 `vitest run`：**636 文件 / 4819 用例通过**（1 skipped / 1 todo）——含穿桥的既有测试零修改（除上列 3 处事件口径登记改写）
- [x] 门禁 `check:frontend` 全链绿：lint（0 error）/ csp / canonical-types / ipc / first-party-styles / tailwind-tokens / build:wasm / build / check:bundle（主 chunk 11KB；最大 chunk 405KB/450KB；js gzip 1,496,048/1,615,000）/ solid-smoke / **check:docs** / check:deps / 生产产物隔离
- [x] `tsc -b` + `tsc -p tsconfig.solid.json` 双绿
- [x] 几何契约护栏全绿：sidebarUnifiedModel.css.test / workspaceTitlebar.css.test / sheetLayoutSidebarCollapsedReactive 等穿桥通过
- [x] `docs/说明书/` 维护地图/架构参考无逐文件表述需同步（check:docs 绿）；ADR-0023 承载方向性表述
- [x] 隔离工作树施工，共享树零干扰；全程 pathspec 提交

## 遗留与未解

- **第 4 梯队**（设置页 radix/cmdk 区，25 文件）与**第 5 梯队**（宿主根 IsolatedPluginSurface、App/main、删 react 依赖、撤 R1/双测试环境门禁）待后续 issue。
- `FileViewHost.save.test` 曾现 2 次 jsdom getComputedStyle 未捕获异常（CM 销毁时序）——已修（destroy try/catch + 微任务补刀取消挂起 measure RAF），全量三轮复验零复现。
- `InputBar.solid`（solid 面）跨框架消费 `components/chat/commandRegistry`（内含 React hooks）为**既有 R1 漏网**（静态 import 不含 react 字面量故未触发门禁），本轮按「不碰 solid-workbench」承诺未处理，建议后续单独立 issue。
- `markdownRenderModel.ts`（solid）与 `markdownCompute.ts`（infrastructure）的渲染模型 TS 类型双份同义（#276 遗留），待单源收敛。

## 环境注记

- G 盘全满（100%）：vitest 临时目录需 `TMPDIR/TEMP/TMP=D:/pylon-tmp` 重定向；工作树/依赖均在 D 盘。
- 本机 Git Bash 的 `python - << HEREDOC` 写盘存在静默丢失现象（多次打印成功但内容未落盘）——文件修改一律改用 Edit/Write 工具后消失。
