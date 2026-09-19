# Dev Record — #163 切走 Agent 误报 crashed + #157 writer_failure 全量并行 flaky

## 元信息

- issue：#163、#157
- 分支：`Ru5t/Reflector`
- 提交范围：`7c4612e3..本次 PR head`
- 日期：2026-09-18

## 目标与范围

- #163：被切走（主动停）的 Agent 在 `list_agents` 报 `crashed:true` 且长期保持。目标：`crashed` 只在**意外退出**时为 true；主动停报未激活（disconnected）。**不新增** wire 状态枚举（不引入 `stopped` 状态值）。
- #157：`acp::tests::writer_failure_signals_watch_and_pending_settles` 全量并行偶发 panic（`prepare_rpc 不依赖进程状态: ConnectionClosed`）。目标：全量并行下稳定，**不加 retry、不改断言预算**。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/acp/client.rs` | AcpClient 新增 `stopped` 字段；`kill()` 先置位；`is_crashed()` 收窄为「意外退出」；新增 `is_dead()`；prepare_rpc/prepare_prompt/send_notification 三处守卫换 `is_dead` | 修改 |
| `src-tauri/src/acp/replay.rs` | `begin_replay_capture` 守卫 `crashed` 原始标志 → `is_dead()`（与其他发送守卫一致） | 修改 |
| `src-tauri/src/permission.rs` | `check_pending_permission_timeouts` 的 runtime 死亡判据 → `is_dead()`（被切走 agent 的挂起权限同样要清理） | 修改 |
| `src-tauri/src/lib.rs` | 仅 `acp_is_crashed` 文档注释（语义同步，零逻辑改动） | 修改 |
| `src-tauri/src/bin/pylon-fake-agent.rs` | 新增 `close-stdin-after-init` 场景（main 拦截分支 + `close_stdin_read_end` 纯 std 实现 + alive 家族纳入 + usage 文本） | 修改 |
| `src-tauri/src/acp/tests.rs` | 重写 `writer_failure_signals_watch_and_pending_settles`；新增 `intentional_stop_is_not_reported_as_crashed` | 修改 |

## 方案要点

**#163**：子进程死亡本身无法区分「主动停」与「意外崩溃」——kill 与意外退出触发**同一** exit watcher / EOF 信号。修法是在 `AcpClient` 上留「主动停」证词：`kill()` 先置 `stopped` 再杀进程（先立证词后动手），`is_crashed()` = `crashed && !stopped`，`is_dead()` = `crashed || stopped`。语义分野：

- `is_crashed()`（意外崩溃）→ 状态消费方：`list_agents`、`agent_status_payload`、`detect_and_record_crashes`——被切走 agent 报 disconnected 而非 crashed，且不会被事后翻成 Crashed。
- `is_dead()`（连接不可用）→ 发送守卫与 pending 清理：prepare_rpc / prepare_prompt / send_notification / begin_replay_capture / permission 超时清理——主动停的连接同样送不达，fail-fast 行为不变。

dispatcher 的崩溃→pet/告警/自动重连路径不动：其已被「先 abort notification_task 再 kill」的 C7 不变量保护（stop_agent_runtime 与 replace_agent_client 两处均先退 dispatcher）。

**#157**：根因不是等待预算被饥饿击穿，是**构造性竞争**——旧 `crash-after-init` 场景子进程在 initialize 后立即退出，测试必须在 exit watcher / EOF 把 crashed 置位**之前**调 prepare_rpc 才能走写失败路径；全量并行下调度推迟该窗口 ⇒ 守卫先拒绝 ⇒ `expect` panic。且旧构造下断言信号（crashed/watch/settle）可由 EOF/exit watcher 代答，写失败路径实际未被隔离验证。新场景 `close-stdin-after-init`：应答 initialize 后**关闭自身 stdin 读端并驻留**（Windows 用 `OwnedHandle::from_raw_handle(stdin().as_raw_handle())`，Unix 用 `File::from_raw_fd(0)`，纯 std 无新依赖）——进程不退出 ⇒ 竞争消失，Pylon 写入必 broken pipe，断言信号**只能**来自写失败路径（测试实际变强）。断言一字未改。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 全量 `cargo test --workspace --lib --features test-agent` 全绿 ×5 连跑 | ✅ 1091 passed / 0 failed（另有 pylon-core 93、插件包 61 全绿） |
| 新用例 intentional_stop_is_not_reported_as_crashed | ✅ ok |
| 重写用例 writer_failure_signals_watch_and_pending_settles | ✅ ok |
| `cargo fmt --check` | ✅ rc=0 |
| `cargo clippy --lib --bins --features test-agent` | ✅ 无新增警告（余量均为既有：test_harness/test_utils 死代码等） |
| 实机：连 fakea → 切 fakeb → list_agents | ✅ fakea `crashed:false, active:false, available:false`（修复前此处 true） |
| 实机：反向切换 + 重复查询 | ✅ 双向对称，多次查询稳定 |
| 实机：后端日志 | ✅ 切换全程 0 条 error |

## 测试处置

- 新增：`intentional_stop_is_not_reported_as_crashed`（kill 后 is_crashed=false / is_dead=true / 发送守卫拒绝）。
- 重写：`writer_failure_signals_watch_and_pending_settles`——场景 `crash-after-init` → `close-stdin-after-init`，断言零修改，测试名保留（#157 归口引用）。

## 证据

- 测试：`cargo test --workspace --lib --features test-agent` → `1091 passed; 0 failed` ×5（root suite），exit 0。
- 实机验收（webview2 MCP，构建 `D:/pylon-acceptance-target/debug/pylon.exe` + 专用 `PYLON_AGENTS_CONFIG` 两 fake agent）：
  - 切换前 fakea：`{active:true, available:true, crashed:false}`
  - 切到 fakeb 后：`fakea {active:false, available:false, crashed:false}`、`fakeb {active:true, available:true, crashed:false}`
  - 切回 fakea 后：`fakeb {crashed:false}`，重复查询稳定；backend logs error 级 0 条。

## 与 spec 的偏差

无。`begin_replay_capture` 的守卫统一（spec 未点名，施工中按「发送守卫一律 is_dead」补齐）与 permission 清理同属一处语义，已记录如上。

## 未解问题

- #157 的 CI 真验证仍需下一次 CI 跑（本机无法完全复现 CI 争抢；但新构造已消除竞争本身，而非放大预算）。
- terminate_overloaded（过载终态）继续按 crashed 报告——它有独立 reason 链路且 UI 需要收敛展示，不属「主动停」。

## 并行交集

- `src-tauri/src/acp/client.rs`、`replay.rs`、`tests.rs`、`permission.rs`、`lib.rs`（注释）、`bin/pylon-fake-agent.rs`。已在 `.agents/L.md` 声明（2026-09-18 22 条目），合入后移除。
