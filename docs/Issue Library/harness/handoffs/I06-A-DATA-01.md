# Handoff: I06-A-DATA-01

- 角色/模式：A / `longrun-a`
- 远端分支：`a/I06-A-DATA-01-msg-repo`
- Base commit：`990b456`（origin/main；2026-08-10 恢复时 rebase 至当时最新 main）
- HEAD commit：`da46a45`（rebase 后；原 `9fec591`/`b83dc96` 内容不变）
- 状态：`approved`——玉衡 03:56 已审「可合并（无阻断级问题）」，scope 偏差裁决同意放行；L1 已通过；PR 待天权合并
- 恢复记录：本分支此前未推送至 origin（本地 commit 始终完好）；2026-08-10 环境数据丢失排查后 rebase + 推送恢复，非重做。

## 已完成

- 新增 `src-tauri/src/session/msg_repo.rs`（SQLite 消息仓库，rusqlite 0.40 bundled）：
  - **D-02 schema**：`sessions` / `messages` / `send_attempts` 三表；`PRAGMA user_version` 版本化迁移（`SCHEMA_VERSION=1`，单事务内 DDL + 版本写入，半迁移不残留）。
  - **D-02 约束**：`UNIQUE(message_id)`（重启去重：`ON CONFLICT(message_id) DO NOTHING` 幂等）；`UNIQUE(session_id, seq)`（会话内单调序号，冲突拒绝——不同会话允许同 seq）；游标分页 `WHERE seq < ? ORDER BY seq DESC LIMIT ?`，无 OFFSET；Session 删除单事务 + FK `ON DELETE CASCADE` 级联清空 messages/send_attempts，不波及他会话。
  - **D-17 恢复**：`converge_interrupted` 单事务内将全部 `pending` attempt 收敛为 `interrupted`（保留已持久化内容，不伪装 succeeded，不删除）；幂等（pending 清零后二次执行 0 行）；锁 poison/连接故障返回 `Err`——调用方据此阻止发送。`begin_attempt(retry_of)` 重试创建**新** message + 新 attempt 身份，`retry_of` 指向前一 attempt 的 message_id，旧 attempt 保持 `interrupted` 不覆盖。
  - **D-16**：schema 无 chunk 存储表（测试锁定），原始 ACP chunks 不落库，仅存最终逻辑文本。
  - `next_seq`（会话内 MAX(seq)+1）、`find_by_client_msg_id`（D-06 乐观重试去重）、`finish_attempt`（pending→succeeded/interrupted，未知行报错）等读写 API 就绪。
- `src-tauri/Cargo.toml` 增加 `rusqlite = { version = "0.40", default-features = false, features = ["bundled"] }`（bundled 离线编译，无系统 sqlite 依赖）；`Cargo.lock` 同步。
- `src-tauri/src/session/mod.rs` 注册 `mod msg_repo;` 子模块（不重导出，避免命名空间污染）。
- TDD：先写 15 个契约测试（todo! 桩）跑红，再实现跑绿。

## 实际验证

| 命令/行为 | 结果 | 证据等级 | 证据路径 |
|---|---|---|---|
| `cargo test --lib msg_repo`（红：todo! 桩） | 15 failed：`not yet implemented` | L1 | 命令输出 |
| `cargo test --lib msg_repo`（绿：实现后） | 15 passed；429 filtered | L1 | 命令输出 |
| `cargo test --lib --no-run`（commands.focused） | 通过 | L1 | 命令输出 |
| `cargo test --lib`（全量回归） | 440 passed；0 failed；4 ignored；0 warnings | L1 | 命令输出 |
| `npm run lint`（commands.broader） | 通过 | L1 | 命令输出 |
| `npm run build`（commands.broader） | 通过；built in 10.91s | L1 | 命令输出 |
| `git diff --check`（commands.broader） | 通过 | L1 | 命令输出 |

## 工作区

- 分支 `a/I06-A-DATA-01-msg-repo`，实现 commit `da46a45` + handoff commit `0e0f958` 领先 base `990b456`（origin/main）。
- 2026-08-10 恢复：rebase 至 origin/main `990b456`（main 已含 I12-A-BE-01 合并与版本号 1.0.0→1.0.1，与本次改动仅版本行相交，rebase 无冲突）；随后推送 origin。原 commit 内容不变，仅 hash 更新。
- 工作区遗留 package.json/package-lock.json 修改（npm install 版本号与 esbuild allowScripts 信任标记）为环境设置噪声，已 stash，**未**纳入本任务提交。

## 阻塞与失败证据

- 无产品或契约阻塞。
- 环境阻塞（已解决）：C: 盘 100% 满曾导致 cargo 链接与管道失败；清理 git-ignored `src-tauri/target`（1.4G 构建缓存）后恢复。构建目标统一重定向 `CARGO_TARGET_DIR=/f/pylon-target/I06-A-DATA-01`，受 RAM 限制采用 `-j 2` + `CARGO_PROFILE_DEV_DEBUG=0` + `CARGO_INCREMENTAL=0`。
- scope 偏差（预期，请审查裁决）：`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 不在 scope.allow（allow 仅列 `src-tauri/src/session/**` 等源码目录），但 AC-1 要求真实 SQLite 实现，rusqlite 依赖声明是**必要的最小构建变更**；`docs/Issue Library/harness/handoffs/I06-A-DATA-01.md` 亦不在 allow 列内，系 evidence.artifacts 显式要求（I05-A-FE-01 同先例）。

## 下一条确定动作

1. ✅ 玉衡 03:56 已审「可合并（无阻断级问题）」，scope 偏差裁决同意放行（4 条建议级 + 3 条可选级，无阻断项）。
2. 分支已推送 origin，PR 已创建 → 由天权合并到 main（A 为 integrator）。
3. 解锁 `I06-A-FE-02`（冷启动与 optimistic send 收敛，直接消费本卡 `MsgRepo` API）与 `I13-A-FE-02`。

## 不得假定

- L1 测试通过不代表真实 Tauri 应用 L2/L3 已通过；仓库尚未接入 AppState 与发送路径（属 `I06-A-FE-02` 范围）。
- 本卡方法为同步阻塞 + `Mutex<Connection>`；接入 async 发送路径时须 `spawn_blocking`。
- `validate_harness.py` 可能对 Cargo.toml/Cargo.lock/handoff 路径标记 scope 违规，为上文记录的预期偏差。
