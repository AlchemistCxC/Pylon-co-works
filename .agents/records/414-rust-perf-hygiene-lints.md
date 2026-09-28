# Dev Record — #414 clippy 性能卫生静态门禁 + Rust 反模式审计

## 元信息

- issue：#414
- 分支：kumo/prometheus
- 提交范围：`c5f3d685..`（本批）
- 日期：2026-09-28

## 目标与范围

用户提出把七类 Rust 性能反模式变成可执行约束（原话见 spec）：①持锁 await（含异步 RwLock 读锁跨 await）②async 内阻塞 ③无节制深拷贝 ④热路径堆分配 ⑤Vec 当队列 ⑥性能敏感场景默认 HashMap ⑦无缓冲 IO ⑧循环内编译正则。

**不做什么**：不改门禁脚本与 CI 语义（仍是相对基线零新增）；不刷基线；不引入 fast-hash 依赖（架构决策留仓库主）；不动前端。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `clippy.toml`（仓库根） | 新增：`await-holding-invalid-types` 列 tokio 锁卫全家族 | 新增 |
| `src-tauri/Cargo.toml` | 新增 `[workspace.lints.clippy]`（`redundant_clone = "warn"`）+ 本包 `[lints]` | 修改 |
| 9 个 member crate `Cargo.toml` | 各接 `[lints] workspace = true` | 修改 |
| `src-tauri/pylon-acp/src/terminal_runtime.rs` | `insert` id 锁卫缩短临界区；`release_session`/`clear` 消除 `if let` 检视位临时锁卫跨 `kill().await` | 行为保持重构 |
| `.agents/dev-standards.md` | 新增「Rust 性能卫生静态门禁」节（机械/非机械分界 + review checklist） | 文档 |
| `docs/说明书/Pylon-模块维护地图.md` | 「验证」节补一句 #414 两层静态配置 | 文档 |
| 其余 38 个 `.rs`（清单见提交） | 存量 lint 修复：redundant_clone 去 clone、有意持锁跨 await 处函数级 `#[allow]` 附理由 | 修复/标注 |

## 方案要点

1. **机械/非机械分界**：clippy 能判定的进静态门禁（持锁 await 全家族、循环正则、冗余 clone）；判不了的实施规范 + grep 线索（block_on/同步 IO、热路径分配、Vec 队列、HashMap 选型、无缓冲 IO），落 dev-standards。
2. **clippy.toml 生效性实证**：临时未知键探针 → clippy 报 `unknown field` 错误，证明从仓库根发起（含子 crate manifest 路径）配置被读取。
3. **持锁 await 的两类处置**：检视位临时守卫、id 分配锁卫跨锁属**意外宽持**，真重构（3 处，均在 terminal_runtime.rs）；lifecycle/switch/creation/refresh/prompt gate/acp 发送锁属**有意串行化设计**（注释含 R9/C7/方案 5/ACP-05 依据），函数级 `#[allow(clippy::await_holding_invalid_type)]` + 理由，共 24 个函数。
4. **redundant_clone 修复判据**：编译器裁决。`AdapterFactory::create` 的 `notifier` 是按值参数、`refresh` 的 `F: FnOnce` → 工厂闭包内 clone 均可直 move（含 engine.rs `on_close`）；owned `String` 上 `to_string()`（browser/cmds.rs 20 处 `map_err(PylonError::Protocol)` 直 move）是真冗余拷贝；`state.rs::apply` 的队列与 delta 双消费是 clippy#81469 族误报，定点 `#[allow]`（全仓唯一）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `bun run check:clippy` exit 0 | ✅（6 crate `added: []`，基线文件未改动） |
| clippy.toml 生效性有探针证据 | ✅（未知键报错实证） |
| 审计报告带 file:line 落 issue 评论区 | ✅（见 issue #414 评论） |
| dev-standards 落规范条目 | ✅ |
| 触及 crate 测试绿 | 见下「证据」 |

## 测试处置

无断言/行为语义变更的测试修改：`event_repo/tests.rs`、`agent_config/tests.rs`、`catalog_driven_tests.rs`、`session_info_tests.rs`、`agent_detection.rs`/`agent_preflight.rs`/`hermes/runtime.rs`/`wire_trace.rs`/`gateway/instance.rs`/`gateway/cmds.rs`/`gateway/mod.rs`/`qq/mod.rs`/`dispatcher/mod.rs`/`permission.rs`/`workspaces/mod.rs`/`lifecycle/mod.rs` 内的测试代码仅去冗余 clone（编译器与测试裁决）。新增 1 处 `#[allow]` 于 `sessions_of_a_busy_prompt_gate_are_exempt`（测试本体即持闸门语义）。

## 证据

- commit：见 PR（本批 `chore(L)` 前置 `c5f3d685`）
- 门禁：`bun run check:clippy` exit 0；`cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check` exit 0（仅 rustfmt 本批 38 文件后）
- 测试：`CARGO_INCREMENTAL=0 cargo test --workspace --lib`（结果见 issue 评论回写）
- 审计速览：`block_on`×16 全部合法（测试/入口/spawn_blocking）；`thread::sleep` 全在阻塞线程或夹具进程；`Regex::new`×10 全部 OnceLock 静态；`.remove(0)`×8 除测试夹具外为零；async 含同步 fs 仅 `vendor/acp/acp_transcript.rs`（vendored，不在门禁域）；`File::open`×22 均一次性 `read_to_end`，无循环裸读。

## 与 spec 的偏差

无实质偏差。`state.rs::apply` 的定点 allow 是 spec「误报个案 allow 需注明原因」条款的落地实例。

## 未解问题

- std HashMap → fast-hash（rustc-hash/ahash）是否引入：留仓库主裁决，建议以 perf-bench 数据为准（当前审计未见逐条事件级哈希热点）。
- `#[allow(clippy::await_holding_invalid_type)]` 的 24 处为「有意串行化」存量；若后续对某处做无锁化改造，删 allow 即回归门禁。

## 并行交集

触及文件仅 Rust 侧 + `Cargo.toml`×10 + 文档三件；与 #410/#412（CSS 域）无交集。`docs/说明书/Pylon-模块维护地图.md` 长期多批共写，本批只追加一句。
