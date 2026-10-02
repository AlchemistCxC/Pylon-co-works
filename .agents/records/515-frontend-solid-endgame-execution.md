# Dev Record — #515 前端全量 Solid 化终局执行（ADR-0035）

> 本记录承接一次性规格文档 `.agents/spec/515-frontend-solid-endgame-execution.md` 与迁移施工指南 `515-migration-guide.md`（均不入库），其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#515（`gh issue view 515`，ADR-0035 执行）
- 分支：`kumo/prometheus`
- 提交范围：`fc875a23..87e48eaf`（批0/0.5/1×4/2×2/3×3/7/7b/8×2/10；不含并行的 #463/#504/#519 各自 issue 提交）
- 日期：2026-10-01 ～ 2026-10-02

## 目标与范围

ADR-0035 终态落地：React/zustand 退出生产树、`solidStoreBridge` 拆除、react 生态依赖退役；测试随组件迁移（断言不降级）；每批落地门禁保持绿。

**不做什么**（执行中固化为避让域/过渡态）：`src/components/settings/{AgentCreateForm,AgentRuntimePanel,AgentCandidateList,AgentRuntimeCard,AgentSettingsSection,ZonePresetSection,ArgumentListEditor,InvocationPreview,SettingsSectionHeader,settingsSectionShared,settingsAgentActions,useAgentDetection,useAgentCandidateProvisioning,useAgentPanelFeedback}*`（[Codex] 在途，L.md 2026-10-01）及其 React 岛载具；Rust/wasm 出口；sheet 注册表 wire 契约；持久化格式。

## 改动清单（区段粒度；合计 464 files，+20963/−16714）

| 区段 | 大致范围 | 性质 |
| --- | --- | --- |
| store 内核（批0） | `src/infrastructure/state/solidStoreKernel.ts`（新增）、`src/host/reactStoreShim.ts`（新增，批8 迁至 infrastructure/state/）、16 个 zustand store 置换内核（对外签名不变） | 修改/新增 |
| 组件面（批1~2，六批并行） | `components/{settings 叶子,sidebar,right-panel,根,ui,file,kernel}`、`sheets/{根,file,browser,docs,gateway,agent-workbench}` 全部 React 组件 → `.solid.tsx` 实体 + React 薄桥 | 修改/新增 |
| 根翻转（批7） | `main.tsx`→`main.solid.tsx`、`App`/`KernelRoot`/`ApplicationMount`/`KernelRecoveryLayer`/`SheetLayout`/`SheetHost`/`SheetSidebarSlot`/`SheetErrorBoundary`/`PermissionDialog` → `.solid.tsx`（原件删除） | 修改/新增/删除 |
| 插件契约（批3） | contextPanel/settings/titlebar/workspace/pluginApplication 五契约 `ComponentType` → solid `Component`（`renderKind` 字面量保留，语义登记于类型 JSDoc）；`IsolatedPluginSurface` 晋升 solid 实体 | 修改 |
| 岛退役（批3/7） | ContextPanelPluginIsland/AgentSheetPagePluginIsland/WorkspaceTitlebarPluginIsland/FirstPartyContribution/CwdSettingsIsland/TemplateLibraryPreviewIsland(部分保留) 等岛与宿主直连改造 | 删除/修改 |
| 桥清退（批7） | 72 个零消费者 React 薄桥/死代码级联删除（grep 全仓 + glob 断链扫描双重校验） | 删除 |
| 依赖退役（批7b） | `package.json`：zustand、@radix-ui/*（10）、cmdk、motion 移除（零 import 核实）；react/react-dom/@testing-library/react 保留（避让域+岛载具） | 修改 |
| 编译配置（批0.5/7） | vite/vitest `SOLID_WORKBENCH_FILES` 预扩全 src；tsconfig.json exclude 收敛 `src/**/*.solid.*`；全部 `.solid.tsx` 加 `@jsxImportSource solid-js` pragma；index.html 入口改名 | 修改 |
| 门禁脚本（批7b/8） | check-context-panel-wiring 重写为 solid 实体接线守卫；product-contribution/css-var/layer/plugin-manifests/first-party-styles/solid-workbench-boundaries 六脚本被检对象与白名单随改名更新 | 修改 |
| 测试迁移 | 108 个 React 测试 → `.solid.test.tsx`（harness solid 化 + 断言零缩减）；新增 `solidStoreKernel` 单测 11 用例 | 修改/新增/删除 |
| 说明书（批10） | 架构参考/拓扑全图/模块维护地图/README：入口链、内核启动链、store 机制表述 | 修改 |

## 方案要点

1. **store 保签名置换**：`createSolidStoreKernel` 以 solid-js/store 为本体复刻 zustand vanilla 门面（getState/setState 浅合并/函数 updater 同引用跳过/replace 整体置换/subscribe/getInitialState/version 计数）；`attachSolidPersist` 复刻 persist 子集（`{state,version}` 信封逐字节兼容、同步 hydrate、migrate 后经 partialize 回写、corrupt 静默、写盘异常原样传播）；React 面 hook 形态经 `reactStoreShim`（useSyncExternalStore + 无 selector 版本浅拷贝）。消费者在批0 零改动。
2. **组件迁移统一形态**：`.solid.tsx` 实体（照常 `props.x`）+ `createSolidMount`/`bridgedProps` 通用桥面工厂 + React 薄桥（`import.meta.glob` eager 缝——直连 import 会把 Solid JSX 拉进 React 类型图，不可编译）；岛承载不可直连的 React 子树（最终只剩避让域）。
3. **keep-alive 保实例**：SheetLayout 槽位以 sheet.id 串为 `<For>` 键 + 内层访问器更新（React keyed-by-id 语义对齐，metadata patch 不重建）；replace 路径禁用 `reconcile`（就地合并会写穿共享引用——批8 定位的批0 产品回归，见「测试处置」）。
4. **编译自描述**：全部 `.solid.tsx` 头部 `@jsxImportSource solid-js`，使 Solid 文件被 React 类型图静态引用时仍按 solid JSX 编译。
5. **react 依赖残留的合法形态**：避让域 React 组件经 Settings.solid 内 React 岛（SolidMount）承载；`react`/`react-dom`/`@testing-library/react` 等 React 生态依赖因此保留（ADR 终态的最后一个收敛批待避让域合入）。

## 验收标准与结果（issue #515 判据逐条）

| 验收项 | 结果 |
| --- | --- |
| `src` 生产代码 react/zustand import 清零（避让域除外） | ✅ zustand 0；react 仅剩避让域 14 文件 + 岛载具 4 文件（SolidMount/reactStoreShim/Settings.solid/solidSheetSupport），逐项见 issue 评论 |
| `solidStoreBridge.ts` 与 `SolidMount.tsx` 删除 | ⚠️ 未达成（过渡态）：`createZustandSignal` 为 48 个 solid 实体的在役 store 消费范式，「直连收敛 + 拆桥」登记为后续批（follow-up issue）；SolidMount 仍承载避让域岛 |
| package.json 依赖退役 | ✅ zustand/radix/cmdk/motion 已移除；react 系保留理由=避让域 |
| 门禁全绿（check:frontend + check:solid + lint） | ✅ `check:frontend:static` exit 0、`check:solid` 全链 exit 0、lint 0 诊断、全量 vitest 5168+ 通过 0 失败（两轮） |
| 几何契约与 keep-alive 测试迁移后仍绿 | ✅ sidebarUnifiedModel/workspaceTitlebar css 契约零改动绿；keep-alive 三件断言逐一持平（含实例同一性 toBe） |
| DOM 断言测试 solid-dom 等价存在 | ✅ React 测试 593→6（余=避让域/岛缝测试），solid 测试 55→160；改写登记在诸测试文件头（汇总见下） |
| 子 agent 审查结论落在 PR | ✅ 两轴审查（standards PASS-with-notes / spec FAIL→修复环清偿）结论并入 PR 描述与本记录 |
| 开发记录 + docs 同步 | ✅ 本记录；说明书 4 文件同步（07a10437 + 批8） |

## 测试处置（改写登记汇总）

- **规模**：React 测试 593 → 6；`.solid.test.tsx` 55 → 160。6 个保留 React 测试=避让域（AgentRuntimePanel.default、SettingsSectionHeader）+ 岛缝路径（SettingsPreview.solidMigration、SolidMount.test）。
- **断言零缩减**为硬规则；典型改写点（逐文件明细在各文件头注释）：`render(<X/>)`→`render(() => <X/>)`、显式 `afterEach(cleanup)`、`rerender`→信号驱动/卸载重挂、`act` 移除（Solid 同步落盘）、`fireEvent.change`→`fireEvent.input`（受控 input）、`useId`→`createUniqueId`、store 夹具改 zustand 门面形态、vi.mock 工厂内 JSX 改 createElement（React 岛兼容）。
- **登记在案的行为差异**（非缺陷，语义等价改造）：rendererMode 三处「同实例 update」改信号驱动（实体经 getter 链传导）；「从空态重入」三连 rerender 改卸载重挂。
- **新增**：`solidStoreKernel.test.ts` 11 用例（同引用跳过/replace 置换与不写穿回归钉/persist 信封/corrupt 静默/no-op）。
- **批8 修复环清偿的产品回归**：批0 的 replace 用 `reconcile` 会就地合并数组、写穿 `ZONE_PRESET_POOL` 等调用方共享引用（defaultPresets「铁律1」×3 必红；二分实证 809aeb92 界界两侧）→ 改 produce 逐键整换 + 缺席键删除，并补回归钉单测。

## 证据

- commits：`809aeb92`（批0）/ `9d2c2919`（批0.5）/ `f0a77629`·`58d0e12e`·`ec1c5ce8`·`89dfacff`·`9ff82b05`·`8f482b13`（批1~2）/ `347645f1`（批3/7/7b）/ `54d125e1`·`87e48eaf`（批8）/ `07a10437`（批10 docs）
- 门禁（最终轮，commit 87e48eaf+）：`bun run check:frontend:static` exit 0；`bun run check:solid` 全链 exit 0；`bun run lint` 0 诊断；`bun run test` **Test Files 662（1 skipped）/ Tests 5168 passed + 1 skipped + 1 todo，0 失败**（多 worker 两轮 + 单 worker 一轮）
- 子 agent 审查：standards 轴 PASS-with-notes（P1×2/P2×7 已清偿，内核单测已补）；spec 轴 FAIL→三硬指标中两项达成、「桥删除」按过渡态声明（见偏差）

## 与 spec 的偏差

1. **`solidStoreBridge` 未拆**（spec/ADR 终态判据之一）：48 个 solid 实体以 `createZustandSignal` 为 store 消费范式，直连收敛是一整批独立重构（涉及全部实体的读取面改写）。本轮按「过渡完成、收敛批另立」处理：follow-up issue 登记，ADR-0035 的判据语义在该批才完全兑现。
2. **避让域 14 文件保持 React**（spec 已声明）：其岛载具（SolidMount/reactStoreShim/Settings.solid 岛段/solidSheetSupport.ReactIslandHost）随之保留，react 系依赖退役推迟到避让域收尾批。
3. **spec 未写的**：批8 修复环（审查发现清偿）与 store 内核单测；`renderKind` 字面量保留不改名（spec 原计划把 React 时代旧字面量改成 Solid 命名——实作发现该字面量被 ~30 处 registry/coverage/cli 测试引用且语义已是「非 isolated 即同运行时组件」，当时判改名收益不抵扰动，登记为后续卫生批；**后记：该卫生批已由 #520 终局收尾批 W2 执行落地**）。
4. **glob 断链教训**（写进施工指南备查）：基于 basename 的消费者扫描看不见 `import.meta.glob` 字符串引用——TacticalCommandDeck/BrowserSidebar 三件套曾被误删后恢复/补齐。

## 审查循环（二轮，2026-10-02）

按「并行子 agent 审查 → 并行子 agent 改善」循环执行两轮（每波 ≤4 agent）：

**第一轮**（审查 4 轴：响应性/行为契约/性能/死代码 → 改善 4 批）：
- [P0] `Settings.solid` identity selector（`s => s`）在内核恒定根引用下信号永不传播——主题受控值/ccEditMode 冻结（性能轴实测证实机制）。修法 = 逐通知浅快照 + `shallowEqual` memo。
- [P1] `AgentRendererSuiteWorkbench` selector 读 `props.modeId`（切界面模式后套件偏好解析滞旧）；`ToolConnector` 丢弃 `onMembershipChange` 退订函数（长会话监听泄漏）；`FileTabView` selector 读组件 memo（桥头注定时炸弹形态复现）。
- 清理：死 barrel ×16、`lazyMergeView`+`@codemirror/merge`、`lucide-react`/`react-refresh` 退役；GlobalPresetSection 三副本收拢；`sheetRegistry.tsx→.ts` 合并；`SheetContext.ccEditMode` 死契约字段删除（+20 夹具同步）。
- flake 根因修正：settingsCcNavElements 滚动断言的「点击→navigate→岛异步重挂窗口内 rAF 抢跑」单发竞态，改有界重试点击。

**第二轮**（审查 4 轴：修复验证/断言强度/内核对抗推演/跨框架边界 → 改善 3 批，限额窗口内由主会话直接落地）：
- 内核三处无意走样对齐 zustand：[P1] writeBack 异常中止 notify 循环；[P2] migrate thenable 覆盖磁盘信封（数据不可逆丢失）；[P2] 版本错位无 migrate 静默混入；[P2] 同引用守卫补对象形态。内核单测 11→15（含「磁盘信封保留原样」数据安全钉）。
- 测试债：modalOverlay 补回「重复声明不产生重复槽位」用例（初版迁移漏失）；MarkdownPreview.solid 显式死件登记（25 断言契约无门禁，复活须连测试）；23 个 solid 测试批量补 cleanup 网。
- P3：stderrSamples 证据锚改符号锚、TaskTree/宿主过期注释、App.solid shallowEqual 去双实现、SheetHost/ApplicationMount 补 Suspense、死白名单条目清理。
- 边界审查确认：混合态（Solid 主体 + 避让域岛）六项核验通过，7 条 P3 全部登记处理。

**审查方法学发现**（供后续批次复用）：basename 消费者扫描必须同时覆盖 side-effect import 与 glob 属性访问（曾差点误判两个在役 wiring 文件、漏判 7 个挂载工厂导出）；「断言零缩减」审查需对 105 对迁移文件做 expect 行 diff 而非抽样。

## #520 终局收尾批（2026-10-02，本记录的完成章）

#521（Codex 避让域工作）并入 main 后障碍清除，#520 以「2 干活 + 2 严查」两波执行完毕：

**wave1**（W1 避让域 + W2 契约改名/死代码 + A1 完整性盘点 + A2 运行时正确性）：
- W1：避让域 14 文件 → .solid 实体（基线=#521 后版本）；Settings.solid 六段 ReactIslandHost 岛改直连；4 个 RTL 测试迁移；11 个外部 mock 重定向。迁移中修复 4 个 Solid 语义坑（run-once 组件体/effect 嵌套依赖读/For 引用判行/setter 同步性）。
- W2：renderKind `'first-party-react'`→`'first-party-solid'`（25 文件 63 处）；死代码二批 14 生产文件+9 测试（含 TaskTree.solid、loadSolidControlCenterPreview）；messageRendererResolver 判定为「承诺能力缺口」保留。
- A1：React 世界生产文件 23 个账目精确闭合（14 避让域+4 载具+5 记录漏计）、避让域外零遗漏、8 对测试断言零弱化、契约零漂移。
- A2：**P1 复现命中**——TacticalCommandDeck identity selector（Settings.solid 同族），已修；157/158 selector 合规；keep-alive/几何/IPC 红线全在场；#521 逻辑无 P0/P1。

**wave2**（W3 store 直连 + W4 依赖终退 + 分诊修复）：
- W3：reactStoreShim 退役——14 store 直接导出 SolidStoreKernel（hook 形态零消费核实）；shallowEqual 迁至内核；内核冒烟用例补直连消费面。
- W4：孤儿挂载工厂清退 50 个；SolidMount/SolidMount.test 删除；solidSheetSupport 岛三件套退役；**react/react-dom/@testing-library/react/@types/react*/@vitejs/plugin-react/eslint-plugin-react-hooks 七依赖删除**；vite/vitest react 插件移除、tsconfig jsx→preserve、eslint react-hooks 段删除；bundle −134KB（react+react-dom+scheduler 出包）。
- 分诊：W3/W4 后 17 测试失败逐项插桩分诊 = **17 测试竞态 0 产品回归**（统一根因：RTL act() 微任务冲刷的隐式时序在 Solid 无等价物）；修复=等条件就绪，断言零缩减；solidBridge.solid.tsx 删除（孤儿厂清退后零消费者）；solidStoreBridge 头注定稿（读取原语）。

**终态实测**：`git grep "from 'react'\|from 'zustand'" -- src/` = **0**（含测试）；react-dom 0；package.json react 系依赖 0；bundle js gzip 1,443,859/1,615,000。ADR-0035 终态判据全部兑现。

**保留决策**：`solidStoreBridge.ts`（createZustandSignal）保留为**读取原语**——React 退役后它不再是跨框架桥，只是 store 订阅助手（内核对象原生满足其签名）；48 实体改直读 kernel.state 属零框架语义的纯风格重构，未纳入。vitest react-dom/react-shared 分组名保留（承载非 solid jsdom 测试）。messageRendererResolver 待宿主消费承诺裁决。

## 未解问题

- 避让域收尾批：14 文件 Solid 化 + React 岛与载具退役 + react 系依赖（react/react-dom/@types/@testing-library/react/@vitejs/plugin-react/react-refresh/eslint-plugin-react-hooks/lucide-react）终局移除 + `renderKind` 改名 + solidStoreBridge 直连收敛拆桥（follow-up issue 承接）。
- `settingsSectionShared.solid.tsx` 的 GlobalPresetSection 本地 Group 副本收拢；`MarkdownPreview.solid.tsx` 零消费死件（随 1-A1 复活或删除）。
- dev-standards「前端全局可变状态」一节的 zustand 措辞收敛（§修订需仓库主批准，未动）。

## 并行交集

- 共享文件：`vitest.setup.ts`（console 白名单改名，多批追加）、`scripts/check-*.mts`（本批独占改动）、`src/components/LucideIcon.solid.tsx`（图标登记追加 + 去重）。`src-tauri/**`、`.agents/decisions/0036*`、`.agents/records/321*`、`src/cli/**` 在途期间全程未触碰。
