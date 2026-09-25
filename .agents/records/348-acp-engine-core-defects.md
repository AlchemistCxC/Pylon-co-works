# Dev Record — #348 协议引擎核（pylon-acp）缺陷批次

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 规格原稿：`.agents/spec/348-acp-engine-core-defects.md`（不计入版本库）。

## 元信息

- issue：[#348](https://github.com/AlchemistCxC/Pylon-co-works/issues/348)
- 分支：`kumo/prometheus`
- 提交范围：`b130b2bd`（代码；L.md 声明与本记录另计）
- 日期：2026-09-26
- 来源：ACP 连接四域对照审计（Pylon vs Codeg vs 官方 `agent-client-protocol` crate）C1 / C4 报告的可施工清单

## 目标与范围

**目标**：清零 `pylon-acp` 协议引擎核内的四处缺陷（写侧崩溃终因不可达、版本声明漂移、spawn 缺 `CREATE_NO_WINDOW`、reducer 漏类），外加审查追加的两项。

**不做什么**：不改任何 ACP wire 帧形状、方法名或错误码取值；不改依赖版本约束策略（保持 caret）；不动 `dispatcher/**`、`pylon-session/**`、前端。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/Cargo.toml` | agent-client-protocol / schema 版本声明与注释 | 修改 |
| `src-tauri/pylon-acp/Cargo.toml` | 同上 | 修改 |
| `pylon-acp/src/engine.rs` | `crash_control_frame` / `transport_failure_reason` / 收尾任务接线 / `CrashReason` 词表 / 常量注释 | 修改 |
| `pylon-acp/src/cause.rs` | 崩溃终因映射与词表测试、`WriterFailed` 文案 | 修改 |
| `pylon-acp/src/turn_ledger.rs` | `TurnTerminalCause` 词表同步 | 修改 |
| `pylon-acp/src/process.rs` | 新增 `hide_console_window` | 修改 |
| `pylon-acp/src/terminal_runtime.rs` | terminal shell spawn 应用该配置 | 修改 |
| `pylon-acp/src/state.rs` | `available_commands_update` 显式臂 + 注释 + 单测 | 修改 |
| `pylon-acp/src/error.rs` | `is_method_not_found` 收窄 + 单测 | 修改 |
| `pylon-acp/src/initialize_plan.rs` | `SUPPORTED_PROTOCOL_VERSIONS` 白名单 + 单测 | 修改 |
| `src-tauri/src/acp/tests.rs` | G1-03 用例按裁决改写 + 新增 connect 级拒绝用例 | 修改 |
| `src-tauri/vendor/acp/ORIGIN.md` | 版本矩阵与失效 rmcp 约束 | 修改 |

## 方案要点

- **A1 接产生者而非删词表**：`CrashReason::WriterFailed` 此前全仓无构造点，却能从远端 `params.reason` 被 `crash_reason_from_code` 认领——词表与实现不一致。现由子侧传输收尾任务在「非干净关闭」的 `Err` 上经既有 `InboundRelay` 控制通道发崩溃帧，构造收敛为 `crash_control_frame(reason)` 单点（`terminate_overloaded` 复用）。`WriterTimeout` 因不引入写超时语义即无产生点，按纪律摘除。
- **A6 的落点在计划层**：白名单断言放在 `build_initialize_plan`，拒绝发生在发出 `initialize` **之前**，故不构成 wire 行为变更。全仓配置面核查确认无任何内置 catalog/profile 使用非 1 的值。
- **A3 收敛为单点**：`hide_console_window` 覆盖三处生产 spawn，避免「下次又只在某一处加」。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 每个 `CrashReason` 变体有可指出的产生点，或已移除 | **部分达成**：`WriterTimeout` 已摘除；`PendingLockPoisoned` 无产生点但保留——记录豁免（见「与 spec 的偏差」） |
| 全仓版本表述与 `Cargo.lock` 实际解析一致 | 达成（2.2.0 / 1.9.1；rmcp 失效约束已改写） |
| Windows spawn 设置 `CREATE_NO_WINDOW` | 达成（3 处生产 spawn） |
| `available_commands_update` 不再落 `Unknown` | 达成（显式臂 + 注释 + 单测） |
| `cargo fmt --all --check` 无差异 | 达成（exit 0） |

## 测试处置

- 修改：`src-tauri/src/acp/tests.rs` 的 `custom_protocol_version_and_client_info_reach_wire` —— `protocol_version` 由 `Some(2)` 改 `Some(1)`（A6 生效后 2 被拒）。该用例的版本一半因此与默认同值、不再具区分度，已在 doc 注释如实标注；`client_info` 覆盖保留。**这是 #348 唯一改动的域外既有测试**，由发起方按裁决指派（施工 agent 无权改域外文件，已正确上报）。
- 修改：`pylon-acp/src/cause.rs` 词表测试（随变体摘除同步）、`engine.rs` 传输失败分类用例更名为 `transport_failure_reason_delegates_to_the_sdk_closed_marker_predicate`。
- 新增：`state.rs` 的 `available_commands_update` 不落 `Unknown` 用例；`error.rs` 的 `is_method_not_found` 正反例；`initialize_plan.rs` 的白名单拒绝用例；`acp/tests.rs` 的 `unsupported_protocol_version_fails_connect_before_wire`（connect 级 Err + `!retryable` + trace 中不出现 `initialize` 行）；`engine.rs` 的真实干净关闭用例 `clean_child_transport_close_completes_ok_without_failure`。
- 删除：无（`WriterTimeout` 相关断言随变体同步改写，未留死断言）。

## 证据

- commit：`b130b2bd`（12 文件，+367 / −63）
- 测试：
  - `cargo test -p pylon-acp --lib` → `159 passed; 0 failed`（基线 152）
  - `cargo test --lib -p pylon` → `848 passed; 0 failed; 4 ignored`
  - `cargo fmt --all --check` → exit 0
- 门禁：`bun run check:rust`（fake-agent 构建 + `cargo test --workspace --lib` + 全量 build + `check:acp-shadow` + fmt）与单独复核的 `bun run check:acp-shadow` 均绿；8 个 golden-trace 场景（initialize / new_load / prompt / tool / permission / done_error / cancel / reconnect）稳定。
- 手工验证：无（本批不涉及 UI 行为）。

## 与 spec 的偏差

1. **`PendingLockPoisoned` 保留而非摘除**（验收标准 1 因此只是部分达成）。它与 `WriterTimeout` 同性质（全仓无产生点；release 为 `panic = "abort"`，锁中毒即进程终止，其描述的「保守收敛」不可达），但**前端错误码词表仍引用该 code**（`src/app/errorCodeExplanations.ts` 及其测试），而前端域属在途 #351、规格明令不碰。故按「保留并记录豁免理由」处理：豁免理由已写入 `engine.rs` 变体 doc，待前端词条清理（#357）后一并摘除。
2. **补做 `src-tauri/src/acp/tests.rs`**（域外文件）：规格未预见 A6 会撞上该既有测试；由发起方裁决后执行（见「测试处置」）。
3. **追加 A5 / A6 两项**：来自 C2 报告的追加清单，规格附录已登记。

## 未解问题

1. **是否引入写超时**（让 `DEFAULT_WRITE_TIMEOUT_SECS` 真正保护物理写）：需改 wire bridge 与出站队列，风险高于本批，另议。本批只做了词表一致性与常量注释勘误。
2. 审查观察（未修，非阻断）：一次真实传输失败会经「控制帧 + watch 兜底」两路各记一条 error 日志（reason 不同，final `last_error` 为 last-write-wins）。幂等防护只约束重连调度与状态事件，不约束日志条数。

## 并行交集

本批触碰的共享文件：`src-tauri/Cargo.toml`、`src-tauri/vendor/acp/ORIGIN.md`、`src-tauri/src/acp/tests.rs`，以及整个 `src-tauri/pylon-acp/**`（**不含 `src/adapter/`**——该子目录归 #349）。未触碰 `dispatcher/mod.rs`、`pylon-session/**`、前端（属在途 #351）。

审查期间观察到另一工作流（#351）在同一分支提交前端改动（`e0538758` 等），其 L.md 条目声明「不碰 `src-tauri/**`（#348/#349 在途）」，双方边界互认。
