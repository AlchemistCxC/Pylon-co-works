# Dev Record — #247 抽取 pylon-session / pylon-acp 纯核 crate

## 元信息

- issue：[#247](https://github.com/AlchemistCxC/Pylon-co-works/issues/247) refactor(workspace)
- 分支：`Ru5t/crate-extraction`（**叠放**于 `Ru5t/host-src-regroup`=#246 之上；PR base 指向后者——存储/协议路径依赖 #245 的目录结构，合入顺序不可倒）
- 提交范围：`0c96f603..HEAD`（L.md 声明 / S1 core 归位 `b8b4aa7e` / S2 acp 抽取 `33bafe58` / S3 session 抽取 / 收尾 `f63210e6`）
- 日期：2026-09-23

## 目标与范围

用户裁定「1，2都做吧」：① 抽取 `pylon-session`（会话存储核）；② 抽取 `pylon-acp`（协议引擎核）。零行为变更；expand-contract 保活消费者路径（本轮 Phase 1/2 合并交付——别名面以「宿主 glob 重导出」形式存续，消费者迁移另立期）。

**不做什么**：不抽 permission/hook_bridge/lifecycle/dispatcher（本质胶水）；不动 pylon-compute/markdown/canonical-types/pet-core（划分已正确）；不改 wire 格式/持久化 schema/错误码词汇。

## 改动清单（四段）

| 段 | 内容 |
| --- | --- |
| S1 `b8b4aa7e` | pylon-core 归位：`agent_config/{types.rs(AgentDef+ConfigError), mod.rs(含 DEFAULT_* 五协议常量)}`、`hermes/{mod,runtime}`、`correlation.rs`、`provider_adapter/`（catalog 投影）。宿主 agent_config/ 保留 load/patch/atomic_write 编排 |
| S2 `33bafe58` | pylon-acp 抽取：25 文件 + adapter/（engine/client/protocol/negotiated/capabilities/replay/wire_trace/turn_ledger/interaction_queue/五 policy/host_tools/fs+terminal runtime/stderr/process 等）。宿主保留 instance_registry + 4 个 harness 依赖型表征测试 |
| S3 | pylon-session 抽取：event_repo/（9）、msg_repo/（3）、turn_rollup、retention、user_data、persistence_bootstrap、storage_write_bench、del01/02/05 + `SessionError` 错误域 + `DurableSessionOwner`（owner.rs 纯值类型切割） |
| 收尾 `f63210e6` | clippy 基线对齐、CI 循环纳管新 crate、audit-maintenance 登记两新模块根、两份说明书同步 |

## 方案要点

- **历史决策对表（关键）**：pylon-foundations lib.rs 头部存有 2026-09-07 审计否决留档——`error`/`correlation` 因依赖宿主类型被否决下沉 foundations。本任务改判并留档：`error.rs`（PylonError）**留守宿主**（它聚合 gateway/plugin_cmds 等宿主错误源，否决理由依然成立）；`correlation` 落 **pylon-core**（其否决理由 = AgentDef 依赖，AgentDef 已在 core，解除条件以「同 crate」达成，API 零变形）。
- **SessionError 错误域**：存储域变体（DatabaseFutureSchema/DatabaseSchemaInvalid/DatabaseIntegrity/ReplayTruncated/ReplayLoadInProgress/RevisionConflict/StalePreview）自 PylonError 迁入 pylon-session，Display 文案与 `code()` 机器码**逐字保留**；`From<String>→protocol_error`、`From<serde_json::Error>→serialize_error` 两个历史映射保形；del05 错误码矩阵测试随迁看守。宿主 PylonError 留 `Storage(#[from] SessionError)` 委托 + CanonicalEvent/MessagePersistence 直改 pylon_session 路径。
- **唯一设计变更——RuntimeLogSink 端口**：client/stderr 的 `Option<Arc<RuntimeLogHub>>` 改 `Option<Arc<dyn RuntimeLogSink>>`（pylon-acp 内 trait，方法名与 hub 既有签名同形）；宿主 RuntimeLogHub 实现之（转发即零行为变更）。RuntimeLogContext/功能域词汇下沉 pylon-core::log_context 共享形状。
- **宿主留存物**（对照测量数据）：acp/ 保留 instance_registry（tauri 面）+ tests/golden_trace_tests/catalog_driven_tests/p1_wire_regression_tests/real_acp_smoke（test_harness 依赖）；session/ 保留 model.rs（AcpSessionState）、store.rs（runtime 簿记）、create/prompt/persist/inspector/fork/expiry/owner/control 命令编排、del03/revive_tests/session_info_tests/session_expiry_platform_tests/model_switch_wire_tests。
- **expand-contract**：宿主 `pub use pylon_acp::*`（acp/mod.rs）与 `pub use pylon_session::{msg_repo, event_repo, …}`（session/mod.rs）保活全部 `crate::acp::`/`crate::session::` 路径——dispatcher/lifecycle/lib.rs 等消费者**零改动**。别名面即 Phase 3 缩段对象（消费者迁移另立期）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `cargo test --workspace --lib` | ✅ **1328 passed / 0 failed**（pylon 805 / pylon-acp 132 / pylon-session 151 / core 118 / compute 36 / markdown 61 / canonical 9 / pet-core 16——用例总数与抽取前一致，随 crate 迁移重分布） |
| `cargo test --workspace --tests --features test-agent` | ✅ **1442 passed / 0 failed**（与基线完全一致） |
| clippy 基线门禁（CI 同款逐 crate 脚本） | ✅ 6 crate 全绿（新 crate 零警告；runtime_log 历史基线项随路径迁移补 allow+理由，沿用 #180 惯例） |
| `cargo fmt --all --check` | ✅ 干净 |
| 依赖方向（cargo tree） | ✅ acp→{core, foundations}；session→{foundations, canonical-types}；无反向边 |
| `check:maintenance` | ✅ exit 0，unmapped 空 |
| 消费者零改动 | ✅ dispatcher/lifecycle/lib.rs 等 call site 无一行变更 |

## 测试处置

无新增、无修改、无删除。全部既有用例随所属模块迁入新 crate（总数守恒 1328/1442）；宿主 error.rs 的错误码断言测试改为经 `PylonError::Storage(SessionError::…)` 断言同一 code 字符串。

## 证据

- commit：`b8b4aa7e`（S1）、`33bafe58`（S2）、S3 与收尾提交（见 git log）
- 测试：连续两轮 `cargo test --workspace --lib` 1328/0；`--tests --features test-agent` 1442/0；clippy 基线门禁脚本逐 crate exit 0
- 手工验证：cargo tree 无反向边；`check:maintenance` exit 0

## 与 spec 的偏差

- spec 初稿规划「error.rs + correlation.rs 下沉 foundations」——执行中发现 foundations 的 2026-09-07 审计否决留档后改判：error.rs 留守宿主，存储核以新 `SessionError` 承接；correlation 落 pylon-core 而非 foundations（理由见上）。两处改判均系尊重在档历史决策，非范围膨胀。
- spec 未列 provider_adapter 与 config_path/effective_config_path 的归位——执行中依引用矩阵补入（纯逻辑，同域）。
- 连续测试轮次中出现过一次单测偶发失败，紧接的重跑全绿（与本仓既有 flake 史一致），未定位到具体用例即消失；如复现按 diagnose 流程另查。

## 未解问题

- 别名面（宿主 acp/mod.rs、session/mod.rs 的重导出）为 Phase 3 缩段对象：消费者路径迁移（`crate::acp::` → `pylon_acp::` 等）另立期，迁完删别名。
- pylon-acp 尚有 2 个 `#[allow]`（from_str/len_without_is_empty）——若要根治需 API 形变（实现 FromStr / 补 is_empty），留裁决。
- CI clippy 循环仍未含 pylon-canonical-types / pylon-compute / pylon-markdown（现状保留，未扩 scope）。

## 并行交集

- 全程 pathspec 提交；本轮触碰 `src-tauri/src/{acp,session,agent_config,error.rs,export.rs,runtime_log,correlation.rs→删,hermes→删,provider_adapter→删}`、三个新 crate 目录、`Cargo.toml`、ci.yml、audit-maintenance.mts、两份说明书。
- 工作树开工时 `package.json`/`bun.lock` 已恢复干净（#243 在途改动已被其会话处置）。
