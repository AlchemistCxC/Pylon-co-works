# Dev Record — #416 后端四逻辑块结构性重构批次一（等价重构）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/416-backend-structural-refactor-batch1.md`

## 元信息

- issue：#416（主）/ #417（行为变更决策口，本批不施工）
- 分支：`kumo/prometheus`（基线 = merge github/main @ 8b1eaca4 + L.md 声明）
- 提交范围：`bc84081d`（docs/scripts）、`cf183384`（后端代码单提交）
- 日期：2026-09-28
- 施工方式：调查（4 agent 并行）→ 对抗复核（4 agent 逐条验证修正）→ 施工 wave1（4 agent 按单写者文件域并行）→ 施工 wave2（1 agent 串行跨域步骤）；调查/复核/施工全程材料在未跟踪目录 `_refactor-recon/`（不入库）

## 目标与范围

**做什么**：四块纯结构等价重构，零行为变化——① pylon-acp engine.rs 巨石拆分与 spawn 归位；② dispatcher 正身搬移 + Gateway 选路收口 + pet 产品反应 KernelReactionSink 化；③ prompt.rs 四域拆分 + finalize 双胞胎合并 + load 臂 helper + 常量单源；④ agent_detection/lifecycle 模块化 + 预算常量归口 + FNV 收编 + L7 判定共享。

**不做什么**（全部转 #417 或明确放弃）：turn 在途双写收口、connect 总时间预算、B1 门禁后端化、快照面 wire 收敛、private_ext 搬宿主（R1 裁决：本批冻结）、panic expect 改造、死词表清理、late_terminal_events 生产出口、storage_write_bench 归档（需跨域连带 docs+frame_path_bench，收益低，明确放弃）、InteractionLedger 三 store 合一与注册表合并（施工时证实零行为中间态不可达，见「与 spec 的偏差」）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `pylon-acp/src/engine.rs` → `engine/{mod,inbound,outbound,prompt_wait,test_support}.rs` | 全文件按四域拆分；RequestId/PreparedRpc 留守 mod.rs；tests 随域走且置尾 | 拆分（删除旧单文件） |
| `pylon-acp/src/process.rs` | `spawn_agent_child` 自 engine.rs 归位 | 移动 |
| `pylon-acp/src/adapter/permission_wire.rs` | protocol_adapter.rs 的 wire parse/build 正身下沉（宿主 pub(crate) use 再导出） | 新增（移动） |
| `pylon-acp/src/adapter/interaction_bridge.rs` | 各桥超时非承诺值裁决表下沉 | 新增（移动） |
| `pylon-acp/src/interaction_queue.rs` | 增 `deadline_ms`/`drain_expired`（严格 `now > deadline` 边界，wire 投影不含该字段） | 修改 |
| `pylon-acp/src/{client,replay,cause,lib}.rs` | CrashReason/prompt_wait re-export 承接、注释债（文件头过期描述、重复行） | 修改 |
| `src/acp/mod.rs` + `src/lib.rs` | Q3：`negotiated_snapshot_from_client` 共享辅助，双入口保留；lib.rs 双重 generation 装载收敛为一 | 修改 |
| `src/dispatcher/{host_tools_gate,permission_route,interaction_route}.rs` | host 工具/审批正身与 helpers 搬入（mod.rs 再导出），10 测试随走 | 修改 |
| `src/dispatcher/publish_route.rs` | Gateway 选路三处收口为单一 `publish_session_update`（日志文案/载荷富化以参数保留差异） | 新增 |
| `src/dispatcher/reactions.rs` | KernelReactionSink：两位点终态（on_turn_failed/on_turn_done）+ 独立 on_agent_crashed + wants_live_reactions 门控（Replay+Boundary 丢）+ 禁 IO/await 约束入 doc；删 `RoutingDecision.apply_pet`；`apply_update_event_with_pet_policy` → `derive_session_reactions` | 新增 |
| `src/dispatcher/{mod,routing,canonical_flush,draft_flush,crash_reconnect,frame_path_bench}.rs` | 四应用点改调 sink；route_frame doc 四处 return-false 修正；draft 常量改引 pylon-session 单源 | 修改 |
| `src/session/prompt.rs` → `prompt/{mod,ingest,ledger,wait,settle,tests}.rs` | 2467 行四域拆分，glob 链重建，re-export 面不变 | 拆分（删除旧单文件） |
| `src/session/prompt/hooks.rs` + `settle.rs` | PromptTurnHooks async trait（手工 dyn 兼容装箱，无新依赖）；Prism persist 经 hook await 至完成；pet 分位点接 sink（failed 在广播前、done 在 persist 前） | 新增 |
| `src/session/{create,persist}.rs` | persist/revive load 臂共享 `run_load_with_replay_capture`（错误策略两侧各自保持） | 修改 |
| `src/session/{model,control,session_expiry_platform_tests}.rs` | finalize 合并 + S3 failure 元数据收口 + owner 双入口注释 | 修改 |
| `pylon-session/src/{event_repo/fold,mod}.rs`、`lib.rs` | draft 预算常量升 pub 再导出（Rust 侧单源；TS 第四份拷贝不在本批） | 修改 |
| `pylon-session/src/msg_repo/migrations.rs` | `LAST_IN_PLACE_VERSION` 显式常量（=15，逐位等价） | 修改 |
| `pylon-session/src/del02_tombstone_migration.rs` | 头注释 v6→v7 旧叙事改为 ADR-0008 重建叙事（测试体零改动） | 修改 |
| `pylon-core/src/agent_detection.rs` → `agent_detection/{mod,types,locate,evidence,probe,probe_cache,scan,snapshot,tests}.rs` | 3509 行七模块化 + 1550 行 tests 外迁，glob 再导出保路径 | 拆分（删除旧单文件） |
| `pylon-core/src/fnv1a.rs` | 域内 4 份手写 FNV-1a 收编（哈希输出逐字不变） | 新增 |
| `pylon-core/src/agent_catalog.rs`、`src/lifecycle/*`、`src/agent/{detection}.rs`、`src/agent_config/patch.rs`、`src/runtime.rs` | lifecycle 拆 summary/registry/session_probe/stop（锁序与 do_connect_and_replace 留 mod.rs）；预算常量归口 `lifecycle/budgets.rs`；L7 `effective_status_and_connected` 共享判定 + 逐字段 wire 断言 | 修改/新增 |

## 方案要点

- **每步独立验证**：wave1 四域并行（单写者文件域互斥），wave2 串行跨域；每步完成即跑按块测试并记入 `_refactor-recon/W*-construct-log.md`。
- **表征基准零触碰**：route_frame 分支次序、pump_step biased 优先级、ingest→publish 顺序、`Arc::try_unwrap`、lifecycle 锁序原文、golden trace 字节面、durable-before-publish 全部逐条对照未动。
- **零行为变化的三处关键等价论证**：finalize 合并保留 5 处差异簇（尤其 cancelled 跳过 #316 闭式表评估）；persist/revive helper 保持各自错误策略（上抛 vs 降级 Ok(None)）；pet sink 保持「收集序=应用序 / commit 后 publish 前 / 锁外应用」三表征（R2 对抗审查构造 5 场景推不倒后按修正形态施工）。
- **契约测试即护栏**：契约冻结面（EVT-01、seqSpan、turn 快照字段、分页==一次性折叠等）全部未修改任何测试断言。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `cargo test --workspace --lib` | **1586 passed / 0 failed**（基线 1583 + 新增 3：Boundary 门控、drain_expired 边界、L7 逐字段断言） |
| `cargo test --workspace --tests --features test-agent`（集成） | exit 0，全绿 |
| `bun run check:clippy` | 全 crate `added: []`（基线外零新增），exit 0 |
| `bun run check:acp-shadow` | 通过（探针测试名随 engine 拆分同步为 `engine::inbound::tests::*`） |
| `cargo fmt --all --check` | 干净 |
| `bun run check:maintenance` | exit 0（新目录被既有模块规则覆盖） |
| re-export 面不变 | lib.rs/dispatcher/gateway/test_harness 消费方零改动（`generate_handler` 全量编译 + 全测绿即证） |
| 测试未被修改的前提 | 既有测试仅随正身整体搬移（super:: 导入适配），断言逐字未改（W3 实测 prompt 12 个测试逐字未改） |

## 测试处置

无删除、无断言修改。仅搬移与新增：engine 族 14 测试随四模块分布（6+7+1）；prompt 12 测试随迁；dispatcher 46 + routing 6 + reactions 1（新增 Boundary 门控）；interaction_queue 8（新增 drain_expired 边界）；lifecycle 29（含新增矩阵等值）；pylon-acp 全量 190。

## 证据

- commit：`cf183384`（后端代码）、`bc84081d`（docs/scripts）
- 测试：上表四门禁 + fmt/maintenance，均为本机实际运行输出（CARGO_INCREMENTAL=0）
- 施工日志：`_refactor-recon/W{1..4}-construct-log.md`（逐步文件/符号/测试数字）

## 与 spec 的偏差

1. **InteractionBridge trait 全量 + InteractionLedger 三 store 合一未做**（R2.4 步6 的 6a/6b/6c 已做：裁决表下沉、deadline 下沉、dead-runtime 清理合一）：施工证实三 store（pending_permissions/private_interactions/InteractionQueue）类型与生命周期整体耦合，不存在零行为中间态；trait 化必须连 store 迁移一起做，超出「纯等价」边界 → 转后续（连同快照面单源，见 #417 追加评论）。
2. **注册表合并 + catalog 反向投影未做**（R2.4 步7）：method 表 last-writer-wins 已坍缩 per-provider 事实（peri/hermes 同 method 双注册），反向投影会把 peri 的 `adapter_registered` 诊断位翻假 = 可观察行为变化；前哨调查此处存在缺口 → 放弃本批，随 private_ext 归宿一并决策。
3. **storage_write_bench 归档未做**（R3 清单 D 类）：两候选去处均需连带 docs/说明书与 dispatcher/frame_path_bench（跨域连带），收益低 → 明确放弃，文件原样保留。
4. **L7 的 wait.rs 三处直呼**：`on_error(ensure)/on_user_sent/on_timeout` 无对应 sink trait 方法，保持直呼 pet 函数族（行为不变，已记录）。
5. **clippy 两处基线外新增**（wave2 期间引入的 `drain_collect`/`redundant_clone`）已在施工内零行为修复（`mem::take`、去 clone），最终门禁 `added: []`。

## 未解问题

- #417 决策口新增两条：InteractionLedger 合一（含快照面单源）的施工形态；private_ext + 注册表合并的归位裁决（R1 证据：方言信封终局归宿宿主适配层，待 dispatcher 稳定后一步翻转）。
- 磁盘：G: 施工中再次写满（os error 112），已按 L.md #401 先例清 `target/debug/incremental`（6.3G）+ 陈旧变体 exe/pdb，得 9.6G。后续大批次施工前建议先查 `df -h G:`。

## 并行交集

本批触及的共享面（他人在途 #410 为前端 CSS/TSX，与本批零交集，工作树对方 hunk 未触碰）：`src-tauri/src/lib.rs`（Q3 + 6c 集成）、`src-tauri/src/test_utils.rs`（依赖随迁）。git 提交全部 pathspec，未动他人任何文件。
