# 前端结构全修批（A/B 两报告清偿）· 开发记录

- 日期：2026-09-29
- 执行：[kumo]（单会话，异步子 agent 两名完成前置审查：A 视图层 / B 领域逻辑层，报告在 `_research/frontend-structure-review-{A-view,B-logic}.md`）
- 性质：refactor（结构清偿，无行为变更意图；测试全绿为行为不变证据）
- 分支：`kumo/439-review-fixes`（共享分支延续；**基于同主 #440-449 批次的未提交在途 hunks 之上施工**，chatRowPipeline/messagePipeline/codeHighlight/workbenchProjector 等文件的在途改动随文件迁移一并入库，L.md 已提前披露）

## 依据

两份只读结构审查报告（A：视图/呈现层 12 项；B：领域/逻辑层 13 项）的全部可落地发现。核心病灶：依赖方向无机器门禁（domains/plugin-runtime/infrastructure/视图四层互相穿透）、workbench 上帝域、上帝文件、迁移遗产死代码。

## 处置清单（按提交序）

| 提交 | 内容 | 对应发现 |
|---|---|---|
| `9aeb4a92` | 死代码清偿（-962 行）：chat 退役残件 6 模块+测试、shadowCompare(EVT-05 未接线)、workbenchLegacyFacade、fake 夹具迁 test-utils、coverage 台账迁测试侧、chatMockData 迁 demo、scripts/test-replay-state 随删 | A-V6、B-7 |
| `17fa23d5` | 结构迁移主批（420+221 文件 import 重写）：`components/chat` 42 个纯逻辑模块 → `domains/chat`（真组件归位 components/file、right-panel）；根级主题集群 → `domains/theme/`（store→themeStore、themeTypes 抽取、预设事务下沉 presetActions、barrel 摘除）；contracts 抽取（agentTypes/agentEntry/fonts） | A-V1、A-V5、B-1、B-13、B-11(部分)、B-3(部分) |
| `ee644c23` | plugin-runtime 端口化：workspaceRegistry/workspaceTypes 迁入运行时层、sheet 纯类型落 contracts/sheets、file-workbench 本地契约、context-panel 改引 contracts | B-2、A-域外指涉 |
| `74c83653`+`1e2fe3b6` | workbench 拆出 `domains/appearance/`（appearance/皮肤/侧栏偏好 6 文件；sidebar 两 store 去 React 化，钩子集中视图侧） | B-4(阶段一) |
| `1b30b337` | 破环：fontContributionCssVariable 上收 contracts（theme⇄skin 环）；ToolRegistryEntry/Overlay 拆叶子模块（agent⇄tool 文件环）；删 useAgentCapabilities（生产零消费） | B-5、B-3 |
| `f989768c`+`5d8542c9` | 微域合并 history→overview、sessionState→session；pluginEventBus 宿主包装层更名 pluginEventBusHost（含 vi.mock 随迁） | B-9、B-11 |
| `d99d6bd3` | obs04~07 → `src/devtools/obs/` + mountDevConsoleApi 样板抽取 | B-10 |
| `60337fdb` | rightRailStore → `domains/workspace/layoutRailsStore.ts`（名从实 + 修 domains→components 边 + App 矛盾注释） | A-V8 |
| `45d95e51` | DiffCard 三处镜像常量单源 diffCardPresentation；launchIconKeys 编译期穷举；A-V11 ChatView 过期注释 8 处；vi.mock/compat/守卫测试路径随迁修复 | A-V7、A-V11 |
| `43d7dd59` | **分层边界门禁** `scripts/check-layer-boundaries.mts`（并入 check:solid）+ 四处残余越界真修：inputPrediction 分层归位（port→contracts、HTTP→infrastructure，B-6）、workspaceStore 域件归位（sheetState/sheetPersistence/showPetPersistence/sheetRegistry → domains/workspace）、retentionPolicy 域化、WorkspaceEntry 族上收 contracts | B-1(门禁)、B-6、A-域外指涉 |
| `a57a3fb2` | SheetLayout keep-alive 三段手写块 → KEEP_ALIVE_SHEET_SLOT 数据驱动槽位表（browser 块恢复错误边界覆盖） | A-V10 |
| （更早批内） | projector timeline 收窄开关改「宿主默认 + 批量入口显式 WorkbenchReduceOptions」（B-8 头条）；模式兜底字面量收敛 DEFAULT_INTERFACE_MODE（A-V9 有界件） | B-8、A-V9(部分) |

## 门禁证据

- `bun run test`：654 文件 / 5,066+ 用例绿（各批次点验 + 收尾全量）
- `bun run check:frontend:static`：exit 0（lint/csp/canonical-types/retention-policy/ipc/first-party-styles/tailwind-tokens/example-plugin/wasm/build/bundle/solid-smoke/docs/deps 全链）
- `bunx tsc -b`：0 错（每批次点验）
- `bun scripts/check-layer-boundaries.mts`：814 生产文件四层零越界（豁免 7 条均带理由）
- `bun run check:clippy`：基线外零新增（本批零 Rust 改动）
- `bun run check:solid`：过（含新并入的 layer-boundaries）

## 遗留（显式登记，评审轮裁决是否阻塞）

1. **A-V3/V4 组件内拆分**（Settings.tsx 783 行五职责、AgentRuntimePanel.tsx 989 行 24 useState）：有界抽取未做。属组件内部设计债，非跨层边界违规；layer-boundaries 门禁不拦。建议独立 issue 化。
2. **A-V9 完全体**：tactical-blue 装饰场景特判保留（App.tsx 有注释），registry sceneSurface 声明位待小改动。
3. **A-V12 持久化三机制并存**：未收敛；rightRailStore migrate 内 clamp 重复实现未复用。
4. **B-8 余项**：identityStore 801 行五职责、normalizerSupport 313 行巨型 switch、pylonCliService 13 个 ControlPort 同文件——未拆。
5. **B-2 已知债（门禁豁免登记）**：rendererSuiteTypes→workbenchContracts 工厂契约类型边（WorkbenchHostPort 463 行闭包）；pluginWorkspaceApi→workspaceController 值边。
6. **B-12**：`*ForTests` 清理钩子模式保留（runtimeServices 单例为既成事实）；projector 的进程级开关已降为「宿主默认 + 显式选项」。
7. 审查报告 A 曾断言 replayState「零引用」，实有 scripts/ 下一个迁移期测试引用——已随删；证明 `scripts/*.test.mts` 必须纳入反查面。

## 环境坑（供后来者）

- 会话中段 python 解释器损坏（Windows Store stub 假成功 exit 0 不执行）——两批手术脚本静默未跑，靠「预期产物不存在」发现。此后一律用 bun 跑脚本，且脚本必须打印成功标记。
- git mv 之后解析级 import 重写必须同时接受「源已迁走」（按移动表源识别），否则指向已移动目标的 import 全部漏改。
- `vi.mock('path')` 与 `scripts/*.compat.test.mts` 的字符串路径不经过 `from` import 重写，迁移后必须单独 grep 反查——本批两次踩中（pluginEventBusHost、codeHighlight），后者表现为 perf 测试「确定性失败」。
- `.solid.tsx` 不经 tsc 主工程编译（tsconfig exclude），类型错误只在 Solid transform/运行期暴露；删常量后 must 配套跑对应 solid 测试。
