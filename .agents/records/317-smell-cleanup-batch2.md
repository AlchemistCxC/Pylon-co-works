# Dev Record — #317 代码异味清偿批次二（结构性拆分）

> 入库保留。规格文档（spec，`.agents/spec/317-smell-cleanup-batch2.md`）不保留；目标、范围、方案与验收结论在此承接。

## 元信息

- issue：[#317](https://github.com/AlchemistCxC/Pylon-co-works/issues/317)
- 分支：`kumo/prometheus`
- 决策依据：用户 2026-09-25 四项裁断（D1 四项全做 / D2 六缝提取 / D3 三层全做 / D4 原子写下沉+双写另立），ADR-0025
- 提交范围：`bc4b31a7`、`9f17f9fb`、`9bceecc3`、`05af1ab2`、`0888381b`、`7a916c6c`（每项独立 commit，可独立 revert）

## 目标与范围

承接批次一遗留的结构性条目（全仓异味审计 2026-09-25），按 ADR-0025 四项全做：

1. **TS 工厂拆分**：`createAgentWorkbenchSessionRuntime`（agentWorkbenchSession.ts:365-1465，1101 行）。
2. **命令边界错误单源化**：6 份手写 Serialize 去重；16 条裸 String 命令 + 15 条 pylon-session 四件套命令收编 PylonError；AcpError 边界区分度保留；前端错误解释收口 errorPayload.ts 单点。
3. **原子写正身下沉 pylon-foundations**：消除 workspace.rs 无 fsync 弱实现（remove+rename 丢窗口）。
4. **dispatcher 主泵六缝提取**：`start_notification_dispatcher`（mod.rs:1706-2708，1003 行）。

**不做**（剥离）：localStorage/SQLite 双写（identity 双写为 browser 权威/Tauri 缓存+revision baseline 的刻意设计，另立 issue + ADR 讨论）；`#[allow(dead_code)]` 清理；>900 行文件全仓扫荡。

## 改动清单

| 项 | 文件 | 性质 |
| --- | --- | --- |
| ① | `agentWorkbenchSession.ts`（1465→约 760 行）＋新增 `agentWorkbenchProjection.ts` / `agentWorkbenchTurnClock.ts` / `agentWorkbenchOptimisticEcho.ts` | 拆分 |
| ②a/②b | `src-tauri/src/error.rs`（新增 UserData/Retention/Command 变体 + 宏）、`gateway/instance.rs`、`pylon-session/src/{lib.rs,event_repo/error.rs,msg_repo/mod.rs,user_data.rs,retention.rs}`、`session/mod.rs`（15 命令）、`lifecycle/{mod.rs,mcp.rs}`、`hook_bridge.rs`、`pylon_cli.rs`、`paths.rs`、`plugin_process/mod.rs`（8 命令） | 修改 |
| ②c | `pylon-acp/src/error.rs`（新增 code()）、`src/acp/mod.rs`（From 改 AcpDomain 委托）、`session/persist.rs`（词汇表单源化）；前端 `errorPayload.ts`（新增 wireErrorParts）＋ 10 个消费点收口 | 修改 |
| ③ | 新增 `pylon-foundations/src/atomic_write.rs`；`pylon-foundations/{src/lib.rs,Cargo.toml}`、`workspace.rs`；宿主 `agent_config/{atomic_write.rs,patch.rs}`、`pet/mod.rs`、`lifecycle/mcp.rs`、`gateway/{credentials.rs,instance_store.rs}`、`src-tauri/Cargo.lock` | 迁移 |
| ④ | 新增 `dispatcher/{canonical_flush,crash_reconnect,interaction_route,host_tools_gate,permission_route,fallback_route}.rs`；`dispatcher/mod.rs`（3676→2854 行，主泵 1003→约 360 行） | 拆分 |

## 方案要点

1. **①工厂**：散落闭包 let 单源化为 `binding`/`fold` 状态对象（子系统与宿主经同一对象读写，竞态控制面显式化）；TurnClock/内核活性子系统（5 Map + #217 快照守卫）与乐观回声子系统各自成模块、经显式依赖注入；refresh/bind 成功尾巴去重为 `publishCanonicalRead`（账本证据差异参数化 `withLedgerEvidence`）。返回对象 10 个公共成员签名逐字不变——9 个测试文件零修改全绿。
2. **②错误收编**：UserDataError/RetentionError 走新增 `#[error(transparent)]` 委托变体（message 逐字不变）；EventError/MessageError 走既有 CanonicalEvent/MessagePersistence `#[from]`（与 session/load 既有 wire 现实对齐）；16 条 String 命令映射新增 `Command(String)`（`#[error("{0}")]` 保留原文案，code=`command_error` 净新增）。wire code 全部逐字保留，序列化输出逐字节不变（DEL-05 矩阵看守）。
3. **②AcpError**：`AcpError::code()` 词汇表与 `persist.rs::replay_load_error_code` 既有回放契约逐字一致（单源化，persist.rs 改转调）；`From<AcpError>` 除既有 ReplayLoadInProgress→Storage 特判外整包委托新增 `AcpDomain` 变体。前端 grep 证实零处消费 `protocol_error`（风险远低于预期）；码表有 pylon-acp/host 双侧稳定性测试看守。
4. **②前端收口**：`wireErrorParts` 共享提取核心；三处 repository typed Error 包装、retention 双 helper、runtimeError `structuredErrorParts`、两份同名 `wireErrorCode`、`replayErrorCode` 全部改走单点。String 收编后的 3 处 `[object Object]` 显示坏点（skinHostPorts 捕获错误串、pluginManagerPanel 两处）分别在 skinHostPorts（errorMessage）与 pluginManagementWiring（宿主侧归一化为 Error 实例，插件面板保持 SDK 纯净）修复。
5. **③原子写**：正身（write_file_atomically/AtomicWriteOptions/replace_file/sync_parent/write_synced_temp）下沉 foundations——依赖仅 std+windows-sys，消解「pylon-foundations 不能依赖宿主」的依赖方向死结；workspace.rs 弱实现改调正身 best_effort 档位（保留历史「不 fsync」语义；Windows 替换从 remove+rename 丢窗口升级为 MoveFileExW WRITE_THROUGH）；宿主 atomic_write.rs 只留 config 域事务（ConfigLease/CAS/.bak）。
6. **④dispatcher**：决策归子模块、副作用适配归调用点（同 routing.rs 惯例）。CrashReconnectHandler 以 `&self` 按字段克隆改写原闭包的「每次调用全量克隆入 future」（语义等价、克隆更少）；`should_flush_batch` 提取窗口决策纯函数；`flush_canonical_window` 收拢 4 处 9 参 flush 调用点。不改事件名、路由顺序、锁持有范围。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| vitest 全量 | ✅ 650 文件 / **4955 passed**（1 skipped/1 todo），工厂相关 9 测试文件 + 全部既有测试零修改 |
| tsc / eslint | ✅ `tsc -b` 零错误；eslint 改动文件零告警 |
| check:solid | ✅ 8 项全过（solid boundaries / theme contract / renderer-architecture / runtime-boundaries / css-var / theme-fields / plugin-manifests / context-panel / hook-anchor） |
| check:ipc | ✅ 216 注册 / 147 invoke / 52 豁免，双向一致 |
| cargo test | ✅ pylon **828**、pylon-session **151**、pylon-foundations **84**（含新增正身语义单测 3 例）、pylon-acp **152**（含新增码表稳定性测试）、integration **27**（auto_reconnect 5 + golden-traces + gateway/inject/model_switch/issue110/issue53） |
| 新增测试 | ✅ AcpError 码表稳定性（pylon-acp + host error.rs）、原子写正身语义 3 例（foundations） |
| cargo fmt/clippy | ✅ 全部改动文件 fmt；clippy 仅既有 5 项（agent_detection/routing/create.rs），零新增 |

## 测试处置

- 未修改、未删除任何既有测试（前端 4955 与 Rust 各套件全部原样通过）。
- 新增：AcpError 码表稳定性测试 ×2（pylon-acp/error.rs、host error.rs tests 内）、原子写正身语义测试 ×3（foundations/atomic_write.rs）。

## 证据

- commit：`bc4b31a7`（①）、`9f17f9fb`（②a/②b）、`9bceecc3`（②c 后端）、`05af1ab2`（②c 前端）、`0888381b`（③）、`7a916c6c`（④）
- 行数：主泵 1003→约 360；dispatcher/mod.rs 3676→2854；agentWorkbenchSession.ts 1465→约 760
- 说明：Rust 验证因 G 盘满（incremental 缓存 11G 清理后恢复）与 aws-lc-sys 在 D 盘缓存缺测试二进制，最终全部在主树 G 盘 target 完成；`cargo test` 需先 `cargo build --bin pylon-fake-agent --features test-agent`（harness 前置，见 test_utils.rs:56）

## 与 spec/ADR 的偏差

- ②收编对象精确数为 15 条四件套命令（spec 写 17：EventError 7 + MessageError 2 + UserDataError 4 + RetentionError 4 = 17，其中 2 条 MessageError 计入后为 15 条 UserData/Retention/Event + 2 MessageError——口径差异，总数一致 17）。
- ④落地为 6 个子模块（与 ADR 目标形态一致）；权限分支独立成 permission_route.rs（spec 允许 5-6 模块，取 6）。
- 其余与 spec 一致。

## 未解问题

- **localStorage/SQLite 双写**：按 D4 剥离另立 issue（identity 双写、保留策略按模式分叉、审批模式真源分裂在两层），需 ADR 级讨论。
- pylon-foundations 若未来引入更多宿主下沉需求，建议评估 workspace 依赖 feature 收敛（windows-sys 特性当前仅 Win32_Storage_FileSystem）。
- 共享树遗留：G 盘空间紧张（已清 incremental 缓存 11G；29G target 为可再生缓存，是否清理留仓主决策）。

## 并行交集

- 本批次全程无他人在途文件域冲突（#315/#316 已出园；ADR 通审任务已收口）。
- `scripts/` 下的临时提取脚本已即时删除，未入库。
