# Dev Record — #155 T3 跨窗口消息聚合与临时片段

## 元信息

- issue：#155，T3
- 分支：`codex/issue-155-t3`（隔离工作树）
- 提交范围：以本分支 PR diff 为准
- 日期：2026-09-25
- 署名：Codex

## 目标与范围

让同一条助手 text/thinking 消息跨 dispatcher 的 32 条／8 ms 窗口累积，到类型、owner、identity、非 delta、终态或 48 KiB／2000 chunk 预算边界才提交正式历史。流式期间先持久化临时片段再显示；崩溃遗留的片段由用户明确保留为历史或丢弃。正式历史仍只来自 `canonical_events`，不改 `evt_*` 历史读、`expectedRevision` 和 ACP wire 语义。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-session/src/msg_repo/{mod,migrations,tests}.rs`、`del01_schema_audit.rs` | v16 临时表、v15 原位升级、删除／保留策略清扫 | 修改 |
| `src-tauri/pylon-session/src/event_repo/{draft,draft_bench}.rs`、`{repo,service,error,mod}.rs` | 追加片段、跨窗口提交、原子清除、`draft_pending`、存储基准 | 新增／修改 |
| `src-tauri/src/dispatcher/{draft_flush,canonical_flush,mod}.rs`、`runtime.rs`、`session/{prompt,control,mod}.rs`、`lib.rs` | 16 chunk／800 ms 在途 run、终态／显式关闭屏障、IPC | 新增／修改 |
| `src/infrastructure/events/{canonicalEventFeed,canonicalEventRepository,canonicalEventSink}.ts` | 临时 seam、提交交接、外部写入重试 | 修改 |
| `src/sheets/agent-workbench/**`、`src/domains/workbench/**`、`src/renderers/solid-workbench/**`、`src/components/chat/messageTypes.ts` | 临时内容投影、冷恢复、中断操作按钮 | 修改 |
| `.agents/decisions/0027-cross-window-history-and-draft-fragments.md`、`docs/说明书/Pylon-项目架构参考.md` | 用户裁决与实际契约 | 新增／修改 |

## 方案要点

1. 首 chunk 立即登记临时片段，锁定同 owner 的到达顺序。后续累计 16 chunk 或经过约 800 ms 任一先到便追加片段，持久化成功后才显示。消息边界立即处理。
2. 临时表与正式历史分离：draft 不推进 revision、不进入 cursor／插件历史。正式 batch 与相应片段删除同一 SQLite 事务，提交前校验已落盘前缀。
3. prompt 终态和显式关闭通过 dispatcher 屏障等待前序 delta 收口，避免终态插序。无终态退出保留已落盘片段；在途活动登记簿防止用户误处理活跃 draft。实机发现 ACP SDK 也可能以字符串错误响应报告连接关闭，已将该形态归为 ConnectionLost，防止错误路径把崩溃残段提交为历史。
4. 同 owner 外部 `evt_append` 收到稳定 `draft_pending`，调用方保留待写批次并重试。重启后片段标为中断，用户可“保留为历史”或“丢弃”。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 跨窗口正式行数 | 真实 EventRepo 600 chunk 基准：原窗口 19 行，T3 为 2 行（48 KiB 分行） |
| WAL 权衡 | 原窗口 428,512 B；4／8／16／32 chunk 每片段分别 1,858,152／1,751,032／914,672／552,112 B；用户选 16 chunk／约 800 ms |
| 草稿隔离与恢复 | 后端测试覆盖 draft 不推进 revision、原子提交与删除、冷读取、中断保留／丢弃、活跃门禁；实机强制结束假 Agent 后 25 片段／368 chunk 仍在临时表，`evt_draft_list` 返回 `interrupted=true` |
| 终态顺序 | 后端测试验证先提交 draft 为 sequence 1、再写 `done` 为 sequence 2 |
| 前端交接 | 单测覆盖冷恢复、预算分行后的中断标记、正式行到达后无重复正文 |

## 测试处置

- 未删除既有测试；新测试加入后端 schema／事件仓库／prompt 屏障及前端 feed／Workbench。
- `cross_window_draft_storage_bench` 是可复现实测，断言正式历史行数；WAL 与耗时只打印，不设机器相关阈值。

## 证据

- commit：功能本体 `c8b4ccbe`；合入主线两次——`48170945`（#331/#334–336/#325–329/#339）与 `a754e8f4`（#338/#345/#346，PR 冲突解除后 GitHub 才会重建 pull_request 工作流）。
- CI（PR #347，head `a754e8f4`）：六项全绿——clippy 基线门禁、Rust fmt+测试+构建、ACP shadow parity、vitest 分片 ×2、前端静态门禁。仓库既有的 `docs.yml` 在 main 推送上同样 startup_failure（0 job），与本分支无关。
- clippy 基线门禁（CI `rust-clippy` job 同款：`cargo clippy --workspace --all-targets` + `scripts/check-clippy-baseline.mjs` 逐 crate）：修复 `runtime.rs` 的 `draft_flush_tx` 嵌套泛型 `clippy::type_complexity` 新增（抽 `DraftFlushSender` 别名）后，六个 crate 全部零新增。
- `bun run check:all`：退出码 0——前端 vitest 652 个测试文件通过（1 skipped），cargo test --workspace --lib 各 crate 全绿（pylon 841、pylon-session 等均 0 failed），shadow parity、cargo fmt --check 与全部 solid/边界守卫通过。
- `cargo test --manifest-path src-tauri/Cargo.toml -p pylon-session --lib cross_window_draft_storage_bench -- --nocapture`：退出码 0，1 passed，600 chunk 生产形态基准见上。
- 手工验证：`bun run build` 后 `cargo build --manifest-path src-tauri/Cargo.toml`，将当前 `pylon.exe` 放到隔离 portable 目录（`data/pylon-data-v1.sqlite3` 空库），以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9235 --remote-allow-origins=*` 与隔离的 `WEBVIEW2_USER_DATA_FOLDER` 启动。CDP `Runtime.evaluate` 确认 `typeof window.__TAURI_INTERNALS__.invoke === 'function'`，且 `evt_draft_list` 已注册。配置 `pylon-fake-agent --scenario stream-forever --chunk-interval-ms 50` 并通过真实 `send_message` 启动；运行期间临时表有 8 片段／112 chunk（正式历史仅用户输入），强制结束 Agent 后临时表为 25 片段／368 chunk、`interrupted=true`，正式历史末行仍为已提交 batch（sequence 401），没有 `turn.failed`。调用 `evt_draft_keep` 后返回 1 条正式 batch、revision 769，临时表 0 行。

## 合入主线（2026-09-26）

main 在隔离期间合入 #331/#334–#336/#325–#329/#339，合并提交 `48170945` 的融合要点：

- dispatcher 已被 #336 重构为 `NotificationPump` 结构体——draft 集成按新结构嫁接：`draft_flush_rx`/`draft_run` 提升为泵字段，两个 draft select 臂与崩溃臂/路由链的收口点迁入 `pump_step`/`route_frame`，draft 节流 `interval` 因需 tokio 定时器上下文留在 `run()` 内构造并以参数传入 `pump_step`。
- `DraftFlushContext` 与 #335 的 `CanonicalFlushContext` 字段面完全相同，删除独立定义直接共用；泵内装配点以字段级宏 `pump_flush_context!` 展开（方法形式会把借用覆盖整个 self，与 `&mut self.draft_run` 不兼容），字段清单仍唯一处。
- #334 P2 把 `KernelEventInput.raw_payload` 改为 `Arc<Value>` 共享——draft 链路全线对齐（`DraftCommitChunk`/`draft_candidate` 入参、bench 与测试构造）；draft 提交不经 ingest 故不预取共享，chunks 在提交后释放引用让发布侧 `Arc::try_unwrap` 保持零拷贝。
- ADR 编号撞车（main 已用 0026 给文档站）：本 ADR 重编为 **ADR-0027**，说明书与开发记录引用同步。

## 与 spec 的偏差

- 第二轮对齐（`a754e8f4`）：新 main 只动 TS/文档/脚本，重叠面仅 `canonicalEventSink.ts`（#338 删 recovery 硬编码行 × 分支加 `draft_pending` 守卫，自动合并互不干扰）、说明书（#346 刷新 + 本任务 schema 段与 `retention_policy` 措辞，均保留）与 L.md（冲突按「同一 #155 条目取分支新版」解决）。

- 用户看过真实 EventRepo 基准后，把最初的 200 ms 策略调整为 16 chunk／约 800 ms；ADR、说明书与实现同步采用最终裁决。

## 未解问题

- 实机验收已覆盖 Tauri IPC、崩溃恢复和“保留为历史”的后端路径；Workbench 中断按钮的真实点击未在隔离实例中复验（该实例直接发 `send_message`，未建前端 user_data 会话），其绑定与投影由前端测试覆盖。

## 并行交集

- `session/prompt.rs`、Workbench 与 #324 重叠；dispatcher 与 #334–#336 重叠；`lib.rs` 与 #331 重叠。已在 `.agents/L.md` 声明，隔离工作树施工，PR 前复核远端 main。
