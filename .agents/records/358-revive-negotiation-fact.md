# Dev Record — #358 复活会话缺协商事实（会话下方的持久配置卡）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 规格原稿：`.agents/spec/358-revive-negotiation-surface.md`（不计入版本库）。

## 元信息

- issue：[#358](https://github.com/AlchemistCxC/Pylon-co-works/issues/358)
- 分支：`kumo/prometheus`
- 提交范围：`ace7a013..5360b1bf`（代码与说明书；本记录另计）
- 日期：2026-09-26
- 署名：[Penrose]
- 来源：用户实机反馈（F:\A-I\Platform\Pylon\pylon.exe，0.3.0-AUE）——「聊天界面有个奇怪的配置卡片，怎么也消不掉，打开应用就是那个会话」。取证工具 `tools/webview2-mcp`（CDP 9222），随后在隔离副本上做修复前后对照（CDP 9222/9223）。

## 目标与范围

**目标**：复活（`load_persisted_session` → ACP `session/load`）后的会话，其协商目录（model / mode / reasoning）与控制中心一致地只出现一次，不再在会话流底部渲染第二份持久配置表单。

**不做什么**：不动 `WorkbenchDocumentSurface` 的守卫语义（尤其不把「普通 `session.config-updated` 保留编辑器」改成无条件过滤）；不动 canonical journal / 任何 Rust 代码；不新增关闭按钮之类的交互面。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/sheets/agent-workbench/sessionResponseProjection.ts` | `createSessionResponseEnvelope` 增可选 `syntheticReason`（默认值保持逐字不变）+ 说明注释 | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts` | `applySessionResponse` 增可选 `{ syntheticReason }`；`enqueueSessionResponse` 透传；`pendingSessionResponses` 排队项携带标注 | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchLifecycle.ts` | 新增宿主缝 `onSessionLoadResponse`，load 成功分支在 `applySessionStateResponse` 之后调用 | 修改 |
| `src/sheets/agent-workbench/AgentRendererSuiteWorkbench.tsx` | 把该缝接进 `sessionRuntime.applySessionResponse(..., { syntheticReason: 'session-load-response' })` | 修改 |
| `src/sheets/agent-workbench/__tests__/agentWorkbenchSession.test.ts` | 新增「复活响应投影为协商事实」用例 + `createCanonicalEvent` import | 修改 |
| `src/sheets/agent-workbench/__tests__/agentWorkbenchLifecycle.recoveryRace.test.ts` | 新增「load 成功把协商响应交给 `onSessionLoadResponse`」用例 | 修改 |
| `src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx` | 新增「复活文档补上协商事实后配置卡消失」用例 + `createSessionResponseEnvelope` import | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | load 链那句补 `onSessionLoadResponse` 的接线事实（#358） | 修改 |

## 方案要点

- **根因是两条路径的不对称，不是守卫本身错**：守卫（`WorkbenchDocumentSurface.solid.tsx:31-41`）只在时间线存在**带 `options` 的 `session.started`** 时才把中控目录从会话下方配置面过滤掉；而 `session.started` 全仓只有一处生产者（`createSessionResponseEnvelope` 默认 kind），只被**建会话**路径调用（`agentWorkbenchSessionCreation.ts:74-75`）。复活路径 `agentWorkbenchLifecycle.ts` 只调 `applySessionStateResponse`，不投影文档 ⇒ 守卫前提在复活会话上必然为假。
- **修法 = 补齐对称**：复活成功时把 load 响应也交给工作台文档，投影成同一条协商事实。`load_persisted_session` 的响应本就是该会话的 ACP 协商目录（`configOptions` / `models` / `modes`），语义上就是「本会话的协商」，与 `new_session` 同构。
- **溯源如实标注**：新增 `syntheticReason` 可选参数，复活传 `session-load-response`，建会话保持默认 `session-new-response`——同一形状的信封来自两条路径，混用理由会让事后取证认错来源。
- **为什么不改成无条件过滤**：既有契约（`mountSolidWorkbench.solid.test.tsx:2156`）要求「没有启动协商时，普通 `session.config-updated` 保留其编辑器」（部分 agent 只用该事件暴露可编辑运行时设置）。无条件过滤是行为变更，超出本 issue 范围。
- 排队路径（响应早于 bind 到达）也携带标注：`pendingSessionResponses` 元素由 `SessionResponseObject` 变为 `{ response, syntheticReason? }`。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 复活成功后时间线出现 `session.started`，且目录保留 | 达成（`agentWorkbenchSession.test.ts` 新用例；`document.session.options` 仍为 `['model','mode']`，`status='ready'`） |
| 复活文档的配置卡消失（`data-config-count: 2 → 0`） | 达成（`mountSolidWorkbench.solid.test.tsx` 新用例；实机见下） |
| 建会话/普通 config-updated 两条既有契约不变 | 达成（两条既有用例原样通过） |
| 实机：同一份 data、同一次成功复回，仅二进制不同 → 卡片有无之别 | 达成（下表） |
| 实机：中控目录未丢失 | 达成（widgets `input/model/reasoning/mode/tokens/cc-command-hint` 均在，读数 `custom:deepseek/deepseek-v4.1-flash / none / default`） |
| `bun run check:solid`、`bun run build`、`bun run lint` | 达成（见证据） |

### 实机对照（隔离副本，原始 data 为 F: 便携版 `data/` 的拷贝）

| 实例 | 复回 trace | `.solid-workbench-config` |
| --- | --- | --- |
| 未修复：F: `pylon.exe`（12:05 release 包） | `session-load-response`，observed 6，`canonical_revision=477`，`authority=local-journal` | **在**：`data-config-count=2`，选项 `['model','mode']` |
| 已修复：本轮 `cargo build`（debug，dist 为本轮 `bun run build`） | 同上（`canonical_revision=477/479`，observed 6） | **不在**：`data-config-count=null` |

取数时刻（CDP `Runtime.evaluate`）：未修复 `1790398876385`；已修复 `1790398743155` / `1790398935789`。

## 测试处置

- 新增：
  - `agentWorkbenchSession.test.ts` → `#358 复活响应投影为 session.started 协商事实，并保留回放出来的目录`
  - `agentWorkbenchLifecycle.recoveryRace.test.ts` → `#358：load 成功把协商响应交给 onSessionLoadResponse`（**反向验证**：注释掉 `this.onSessionLoadResponse?.(session, res)` 后该用例红，`expected "vi.fn()" to be called 1 times, but got 0 times`；恢复后绿）
  - `mountSolidWorkbench.solid.test.tsx` → `#358：复活文档补上 load 响应的协商事实后，会话配置卡消失`
- 修改/删除既有行为测试：**无**。

## 证据

- commit：`5360b1bf`（8 文件，+123 / −10）
- 测试：
  - `bun run test src/sheets/agent-workbench/__tests__/agentWorkbenchSession.test.ts src/sheets/agent-workbench/__tests__/agentWorkbenchLifecycle.recoveryRace.test.ts` → `Test Files 2 passed (2)`、`Tests 38 passed (38)`
  - `bun run test src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx` → `Test Files 1 passed (1)`、`Tests 96 passed (96)`
  - `bun run test src/__tests__/replay src/sheets/agent-workbench` → `Test Files 34 passed (34)`、`Tests 563 passed | 1 todo`
  - `bun run check:solid` → 全部子门禁通过（Solid 边界 / 渲染器架构 R1–R4 / 运行时边界 23 条遗留白名单仅报告、无新增越界 / CSS 消费 / ZONE_FIELDS）
  - `bun run build` → `built in 19.78s`；`bun run lint` → `0 errors, 1 warning`（`GatewaySheetView.tsx` 既有告警，与本改动无关）
- 手工验证：见上表；构建机为 debug 产物，`frontendDist` 已确认内嵌本轮 dist（二进制资源表含 `AgentSheetView-D2phK9Rb.js`）。

## 与 spec 的偏差

- spec 未写「排队路径携带标注」这一项，施工中为保持标注不丢而补上（`pendingSessionResponses` 元素结构变更，仅内部）。
- spec 的「验收标准」原写法是「`.solid-workbench-config` 消失」；实测达成，且追加了「中控目录未丢失」一条实测。

## 未解问题

1. ~~**冷启动 load 双败时卡片仍在**~~ → **已修**，见文末「追加：遗留修复」。
2. 占位窗口（journal 回放先于 load 响应）内卡片短暂可见 → **已修**（同一追加）。
3. 反向对照用的旧包是 F: 的 12:05 release 构建；若要与 main 基线更严格对照，可在 `git stash` 修复后用同配置 debug 包再跑一次。

## 并行交集

- 共享文件：`src/sheets/agent-workbench/**`、`src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx`、`docs/说明书/Pylon-项目架构参考.md`、`.agents/L.md`（施工声明已随 `ace7a013` 入库）。
- 与在途 #351（`src/` 根件下沉 + 全仓 import 路径重写）可能在 import 行相交；本批未改任何根件与 `presets/`、`zones/`。

## 追加：遗留修复（`3d977d9a`）

### 动机与做法

遗留的根是「协商事实只来自 load 响应」：首屏 journal 回放先于它到达，冷启动两次 `session/load` 都失败时它更是永远不来。做法是把事实的来源下移到**回放本身**：

- `agentWorkbenchSession.ts` 新增 `withReplayNegotiationFact(document)`，在**共享发布口** `publishCanonicalRead`（bind 与 refresh 共用）里调用：已持久化会话（`session.periId` 存在 ⇒ 历史来自 journal 回放，非本进程新建）且文档已有目录、且时间线尚无协商事实时，补一条**不带 `status`** 的合成 `session.started`（`provenance.synthetic.reason = 'session-replay-negotiation'`，`trust: authoritative`）。
- 不带 `status` 是刻意的：只交出守卫与中控需要的目录，**不碰会话状态机**（状态仍由 replayed/内核事实决定，避免把在途会话误标 ready）。
- 反面对照（用例）：无 remote id 的新建会话不补事实 —— `mountSolidWorkbench.solid.test.tsx:2156` 那条「没有启动协商时普通 `session.config-updated` 保留编辑器」的既有契约原样有效。

### 验收与证据

| 验收项 | 结果 |
| --- | --- |
| 已持久化会话 bind 回放补出协商事实（不等 load 响应） | 达成（新用例；反向验证：去掉包裹后红 `expected undefined to be defined`） |
| 未持久化会话不补事实（契约不动） | 达成（新用例 + 既有 2156 用例原样绿） |
| 本轮回归 | `112 files / 1419 passed | 1 skipped | 1 todo`；`check:solid`、`build`、`lint`（0 errors）全绿 |
| 发行包 | `bun run release:portable` 成功，`release/pylon-0.3.0-AUE-win64.zip` 37,674,492 B，sha256 `8ad6f6da…845f`，248 项 `verify OK` |
| 部署到本体实例 | `F:\A-I\Platform\Pylon` 仅覆盖程序侧文件（robocopy `/XD data`，248 文件/242 复制/0 失败）；部署后 `pylon.exe` 与包内**哈希逐字节一致**（`0D7C9390…4994`）；`data/`、`agents.yaml` 未动；旧件备份在 `F:\A-I\Platform\Pylon\backup-358-20260926\` |

**首屏窗口 A/B**（同会话 `smuhyyhy7`、同流程：CDP `Page.addScriptToEvaluateOnNewDocument` 注入 50ms 采样器 → `webview_navigate action=reload` → 读回样点）：

| 二进制 | 采样 | 卡片 |
| --- | --- | --- |
| 修复前（备份 exe，12:05 包） | 113 次 / 5.8 s | **有**：`pageAge=312ms` 首次出现 `data-config-count=2`，直到最后一个样点仍在（109/113 命中） |
| 修复后（已部署包） | 180 次 / 9.2 s | **从未出现**（0 命中）；中控 widgets `input/model/reasoning/mode/tokens/cc-command-hint` 均在 |

这直接覆盖了原来的两条遗留：占位窗口不再闪卡，且 load 失败/未达时也不再长卡（事实来自回放，不依赖响应）。
