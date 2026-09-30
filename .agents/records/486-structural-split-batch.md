# Dev Record — #486 结构拆分整理批（7 项逐项 PR）

> 入库保留。规格文档（`.agents/spec/486-structural-split-batch.md`，不入库）的目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#486（refactor(split)：agent-workbench 归位 / projector 四分 / 超长函数群 / 上帝组件 / 碎域合并 / unsafe 单源）
- 分支：`kumo/486-{5,6,1,2,4,7,3}-*` 七条独立分支，均基于各自时点的 github/main（df6cd864 / ea82ac88）
- 日期：2026-10-01 ～ 2026-10-02
- 施工方式：独立 git worktree（`../pylon-486-wt`）——共享树让给 #484/#487/#488 并行批；共享 HEAD 竞态一次（项5 提交误落 487/488 分支基座，PR #492 为其干净载体）已复盘入 L.md

## 目标与范围

按 2026-10-01 全项目审计裁决，把「纯结构拆分/归位」债务逐项小步清偿，**行为不变**（wire/持久化/公开契约/事件投影语义不动）。不做：分层禁令新增、AppState 收口、await-holding 治理、CSS 迁移、死代码删除。

## 改动清单与 PR 映射

| 项 | PR | 内容 | 性质 |
| --- | --- | --- | --- |
| 项5 | **#492** | JobObject unsafe 装配下沉 `pylon-foundations::job_object::KillOnCloseJob` 单源；probe 静默 None / acp 三段 warn 文案原样；pylon-core JobObjects feature 裁剪 | 修改+新增 |
| 项6 | **#493** | `scan.rs`（388 行单函数）→ `scan/{mod,selection,discover,version_probe,rank,tools}.rs` 七段拆五模块，编排与两条早退留 mod | 重命名+新增 |
| 项1 | **#495** | `src/sheets/agent-workbench/` 11 个运行时模块 + 9 个测试文件 → `src/application/agent-workbench/`（20 文件 0 行内容变更，rename 检测）；视图件留守；门禁豁免（vitest.setup console 白名单 ×4、retiredFieldRoots、audit-maintenance workbench-host 根 + 归属优先级断言）随文件迁移；说明书三件同步 | 纯搬移 |
| 项2 | **#499** | `workbenchProjector.ts`（2,134 行）四分 + 61 行公开面门面（30 个导出逐名显式再导出）；reduceMessage/reduceReasoning 成对 60 行收编共享正身 `foldIntoSealedSegmentOrDrop`/`dropOutOfOrderAppend` + 新增互钉测试（4 用例，含族间 append 谓词既有不对称的显式钉） | 拆分+去重 |
| 项4 | **#500** | `WorkbenchContent.solid.tsx`（789→332 行）滚动状态机拆 `chat/createChatScrollController.solid.tsx`（composable）+ `chat/ScrollRail.solid.tsx`；连带清理 displayDocument 直通 memo | 拆分 |
| 项7 | **#501** | `fileDispatch` → `file`（消费簇全在 sheets/file，rename 100%）；其余碎域逐个核实消费者后保留（裁决入维护地图）；attachment/binding/feature 生产零消费者，留卫生批；维护地图新增「呈现四域边界与碎域归属」段 | 归并+文档 |
| 项3 | **#507** | 五个超长函数拆子模块：handle_session_update（锁前解析/锁外收尾 → `session_update.rs`，临界区留 mod.rs）、permission_route → `{mod,hooks,admit}.rs`、revive_session_slot → `create/revive.rs`、load_persisted_session → `persist/load.rs`、run() 的 240 行命令注册表 → `commands.rs` | 拆分 |

## 方案要点

- **逐字搬移优先**：所有拆分均为段级原文搬移（含注释与日志键序），新代码只有编排薄壳与参数化差异位；项2 的去重是唯一语义等价改写，族间差异全部参数化（coalesce 函数 / tool 边界 / delta 判据 / 栅栏是否要求流连续），判定逐字等价。
- **公开面控制**：项2 门面用显式逐名再导出（`export *` 会泄漏内部词汇常量）；项3 的 tauri 命令宏工件（`__cmd__`/`__tauri_command_name`）随函数一并再导出。
- **门禁豁免随文件迁移**（不改口径）：项1 是样本——白名单路径跟文件走，归属优先级补断言（application 子目录被 workbench-host 专属桶认领）。
- **锁纪律红线执行**：项3 的 sessions 单一临界区与锁序文档留 dispatcher/mod.rs；`route_frame` 分支次序、回滚时序（revive 内层代检先于 load 错误消费 / persist 回滚失败优先于原错误）逐字保留。
- **并行协调**：#488-⑤（dispatcher/lib.rs json! 合并）先行提交；项3 保持编排薄壳与邻近区段不动，冲突按既定「项3 基于新基线机械合并」处理。

## 验收标准与结果（对照 issue 判据）

| 判据 | 结果 |
| --- | --- |
| 每项独立小步 PR，挂 issue checklist | ✅ 7 PR（#492/#493/#495/#499/#500/#501/#507），issue 评论区有 checklist |
| 每步 `check:all` 绿（前端 7 项全量 vitest 本地绿 + Rust crate 级门禁；全量 check:all 由 CI 收口） | ✅ 各 PR 描述附证据 |
| 行为不变证据 | 项1：rename 20 文件 0 行变更 + 全量 vitest 664 文件绿；项2：665 文件绿（对照测试零弱化）+ 互钉测试；项3：pylon lib 964 绿（连跑两次）+ clippy 基线零新增；项4：664 绿（mountSolidWorkbench 88 用例）；项5：三 crate 93/137/186 绿 + job 杀树差分测试；项6：core 137 绿（同数同集） |
| workbenchProjector 不再是单文件上帝模块 | ✅ 最大件 reducer 1,480 行（四件 + 门面） |
| sheets/agent-workbench 仅剩纯视图 | ✅ 仅 AgentRendererSuiteWorkbench.tsx |
| 5 个超长函数均有子模块归属 | ✅ 见上表 |
| JobObject unsafe 全仓单源 | ✅ `CreateJobObjectW` 全仓仅 foundations 一处 |

## 测试处置

- 新增：foundations job 关闭杀树差分测试；projector 消息/推理 parity 互钉测试（4 用例）。
- 既有测试：断言零改动零弱化；仅 import 路径随项1 搬移重写。
- 已知既有失败（与本期无关）：`dispatcher::interaction_route::tests::resolve_agent_provider_follows_live_config` 需先构建 fake-agent bin（环境性，构建后绿）。

## 遗留与后续

- attachment/binding/feature 三域生产零消费者 → 死代码候选，待卫生批裁决（维护地图已记录）。
- reduceMessage/reduceReasoning 的族间 append 谓词不对称（封存段后不同 messageId：message 追加入段 / reasoning 开新段）为**拆分前既有行为**，已在互钉测试显式钉住；是否收口属行为变更，另行决策。
- 各 PR CI 与合并顺序由仓库主裁断；项3 与 #488-⑤ 同文件，按既定约定机械合并。
