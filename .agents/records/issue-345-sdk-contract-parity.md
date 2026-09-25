# Dev Record — #345 插件 SDK 契约面对齐 2.4（分层重构 + 出口补全 + 防漂移门）

## 元信息

- issue：[#345](https://github.com/AlchemistCxC/Pylon-co-works/issues/345)
- 分支：`kumo/prometheus`
- 提交范围：`52acf131`（L.md）→ `b3893d2b`（refactor(345)）
- 日期：2026-09-26

## 目标与范围

SDK 自 API 1.3 后未随宿主演进（2.0 破坏性主轴 region、2.1 app-menu、2.2 面板亲和、
2.3 置顶、2.4 keywords/tier 均未覆盖），作者拿 SDK 生成不了用上 2.x 面的插件。
本案让 `src/sdk` 成为 2.4 契约面的完整、可防漂移的作者入口。

**不做**：API 契约本体变更（allowlist/字段形状/C3 门控语义全部不动）；first-party
React 面板 SDK 化；starter manifest 升版（#343 决议：保持 1.1/1.2）；脚手架生成器。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/sdk/contract.ts` | 纯类型再出口按域分组、逐域标 since；补全全部缺口类型 | 新增 |
| `src/sdk/runtime.ts` | 常量表 + helpers 自 index.ts 平移 + `defineManifest` + 协议事件词表再出口 | 新增 |
| `src/sdk/index.ts` | 321 行平铺清单 → 组合出口（`export * from contract/runtime`） | 重写 |
| `src/sdk/testing.ts` | management opt-in mock（`MockContextOptions.management`） | 修改 |
| `src/sdk/__tests__/{sdkExports,sdk,testing}.test.ts` | parity 门 + allowlist 2.x 覆盖 + management 用例 + 去 1.x 化 | 修改 |
| `src/plugin-runtime/sidebar/sidebarSurfaceProtocol.ts` | `AgentSidebarSurfaceInput` 等 wire 投影类型 + `SIDEBAR_SURFACE_EVENTS` | 新增 |
| `src/plugin-runtime/context-panel/contextPanelSurfaceProtocol.ts` | `ContextPanelSurfaceInput` 等 + `CONTEXT_PANEL_SURFACE_EVENTS` | 新增 |
| `src/components/Sidebar.tsx`、`sidebar/AgentSheetPageHost.tsx`、`right-panel/ContextPanelHost.tsx` | `surfaceInput` 字面量 `satisfies` 挂协议类型（运行时零变化） | 修改 |
| `src/plugin-runtime/management/pluginManagementTypes.ts` | 删重复的 `enterSafeMode` 签名（P53 编辑残留） | 修改 |
| `scripts/plugin-devkit-verify.mjs` | 类型树检查改搜顶层全部 .d.ts（不绑文件布局）+ 4 条新断言 | 修改 |
| `scripts/build-plugin-sdk.mjs` | SDK 包版本 1.1.0 → 1.2.0 | 修改 |
| `src-tauri/resources/sdk/pylon-plugin-sdk.js` | 随构建重建的入库离线 SDK（21443B） | 修改（构建产物） |
| `docs/说明书/Pylon-插件系统说明书-开发者版.md` | §6.11 出口覆盖说明、API 表 +2 行、§6.11.1 management mock 语义 | 修改 |

## 方案要点

1. **分层不换面**：`index.ts` 拆为 contract（类型）/runtime（值），作者 import 路径与
   打包约束（零宿主运行时 import、64KiB 离线上限）不变；esbuild bundle 由 20332B → 21443B。
2. **协议真源提取**：隔离面 input 形状原先内联在宿主组件字面量里，无类型可引用。
   提为 plugin-runtime 域文件后宿主 `satisfies` 挂型、SDK 再出口——宿主与作者共用同一
   wire 契约。`satisfies` 立即逮到一处我按字段名想当然的错误：会话投影的
   `workspaceId` 实际可缺省（散会话），协议类型据此修正。
3. **防漂移门是本阶级性解法**：`SdkTypeForMember` 映射的 `keyof` 与 context 成员键集
   `Equal`——宿主新增成员而未补出口时编译红，2.0→2.4 期间出口无人补全的事故类别
   从根上拦截。运行时侧另有 mock 成员键与 management 装配规则断言。
4. **management mock 不复刻守卫语义**：授权/守卫（self_locked / product_required /
   现查 grant）属宿主 grant 检查职责，mock 只提供空结构投影 + 操作记录，语义如实
   写进说明书 §6.11.1。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `bun run vitest run src/sdk` | 23 tests / 3 files 全绿（原 19） |
| `bun x tsc -b`（含宿主 satisfies 挂型） | 0 错误 |
| 全量 `bun run test` | 652 files / 4998 tests 全绿，1 skipped + 1 todo 为既有 |
| `bun run build:plugin-sdk` | 绿；offline bundle 21443B < 64KiB 上限 |
| `bun scripts/pack-plugin-devkit.mjs` | G1/G2/G3 全 PASS |
| 套件 `node verify.mjs` | ALL PASS（含新增 defineManifest / 协议类型 / 2.x 面断言） |
| `bun run lint` | 0 error（1 warning 为 GatewaySheetView.tsx 既有项，非本案域） |
| `bun scripts/check-doc-links.mjs` | 通过 |

## 测试处置

- `sdkExports.test.ts`：重写——parity 门（26 成员逐一 `toExtend` + keyof `Equal`）、
  mock 成员键/management 装配规则、值出口断言（+defineManifest + 事件词表）。
- `sdk.test.ts`：allowlist 用例从「接受 1.0–1.3、拒绝 1.4」扩为「接受 1.1–1.3 与
  2.0–2.4、拒绝 1.4/2.5」，错误文案断言放宽到 `api 仅支持` 前缀（消灭 1.3 时代
  写死文案的过期陷阱）；新增 `defineManifest` 校验/冻结用例；describe 改名去 1.x。
- `testing.test.ts`：新增 management 两用例（缺省不装配 / 开启后投影+记录）。

## 证据

- commit：`b3893d2b`（17 files，+868/−394）
- 测试输出：见上表；全测 `4998 passed | 1 skipped | 1 todo (5000)`，Duration 116.72s
- 手工验证：套件 bundle import 实测 `defineManifest` 为 function、两个事件词表各 4 项；
  旧 v1.4.1 套件 zip 与新 zip（#343 产物链）验证脚本对新布局全 PASS

## 与 spec 的偏差

- `examples/web-plugins/hello-starter/dist` 遗留项：spec 预判为 tracked 快照待 `git rm`；
  实际核查发现 `dist/` 本就在 .gitignore（第 2 行任意深度），该文件**不在索引里**，
  只是盘上残留——落成一条 `rm`，无仓库改动。
- 新增 `plugin-devkit-verify.mjs` 适配（spec 未列）：分层让符号离开 index.d.ts，
  套件自检按旧布局 grep 假红，改为搜顶层全部声明文件并顺势加强 4 条断言。
- 新增 `pluginManagementTypes.ts` 重复签名清理与离线 SDK 重建入库（构建链自然产物）。

## 未解问题

- sidebar 隔离面的 page 体量 input 中 `query` 恒为空串（宿主头部搜索框尚未接线），
  协议类型如实标可选；宿主侧接线属后续功能案。
- `RecordingProxy` 各面（sidebar/titlebar 等）的调用记录仍是无类型 args——若后续要
  typed 断言桶，可基于本案协议类型再进一步，本期不做。

## 并行交集

- 与 #338（ErrorCenter 域）无文件交集；其 `src/runtimeError.ts`/`errorCodeExplanations.ts`
  在途期间本案提交全程 pathspec 隔离。
- `docs/说明书/开发者版` 仅 §6.11 段；与 #339 文档站域（`.vitepress/**`，且不改说明书）无交集。
