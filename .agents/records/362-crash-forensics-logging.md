# Dev Record — #362 崩溃取证：panic hook / 落盘轮转日志 / 日志自反馈回路

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/362-crash-forensics-logging.md`

## 元信息

- issue：[#362](https://github.com/AlchemistCxC/Pylon-co-works/issues/362)
- 分支：`kumo/prometheus`
- 提交范围：本批（#361/#362/#363 单 PR）自 `82631455` 之后
- 日期：2026-09-27

## 目标与范围

**做什么**（对齐 issue 三条期望行为）：

1. **落盘的轮转日志文件**：每日轮转、保留 30 个文件、每日 512 MiB 上限，且**从当日既有文件尺寸 resume 计数**。
2. **同步写盘的 panic hook**：不经 tracing 的异步 appender（其 `flush` 是 no-op、发送端 lossy）。
3. **日志自身 target 排除出 hub** + 给 broadcast `Lagged` 告警加前缘节流。

**不做什么**：

- 不改 hub 容量语义（`DEFAULT_CAPACITY = 2000` 不变）、不加 Logs viewer UI、不做 Codeg `logging.level` 那条「日志级别持久化设置」链。
- 不引入 `tracing-subscriber` 的 `json` feature：文件 sink 用与既有 stderr 同族的**纯文本行**（时间戳/级别/target/message），人可读可 grep，且少一个 feature。
- 不动 `panic = "abort"`（issue 只要求让最可能丢的那条不丢）。
- 不迁 Codeg 的 credential-target 结构过滤（Pylon 无对应 target）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/logging/mod.rs` | 模块头、自身命名空间与 target 常量、共享文件定位、`note_to_stderr`、`append_line_sync` | 新增 |
| `src-tauri/src/logging/budget.rs` | 每日预算状态机（纯逻辑）、文件名、`resume_point`、env 上限 | 新增 |
| `src-tauri/src/logging/file_sink.rs` | 每日轮转 writer、历史清理、通报出口、`build_file_sink` | 新增 |
| `src-tauri/src/logging/panic_hook.rs` | 同步落盘 panic 记录、自有额度、hook 安装与串联 | 新增 |
| `src-tauri/src/logging/throttle.rs` | 前缘节流状态机 | 新增 |
| `src-tauri/src/lib.rs` | `init_tracing()` 重写（三 sink）、`LogGuard`、日志目录漂移检查、启动兜底 `eprintln!` → `note_to_stderr` | 修改 |
| `src-tauri/src/main.rs` | 绑定 `LogGuard` | 修改 |
| `src-tauri/src/paths.rs` | `APP_IDENTIFIER` / `platform_data_root` / `log_dir_candidates` / `first_writable_dir` / `resolve_log_root` | 修改 |
| `src-tauri/src/runtime_log/mod.rs` | Layer 自反馈隔离、`push_synthetic_warn` | 修改 |
| `src-tauri/src/session/mod.rs` | lag warn 前缘节流 | 修改 |
| `src-tauri/Cargo.toml` | `tracing-appender = "0.2"` | 修改 |
| `src-tauri/vendor/acp/ORIGIN.md` | §6 出处登记（Apache-2.0 / codeg 设计来源） | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | Native host 行登记 `logging/` | 修改 |

## 方案要点

1. **轮转与命名自己做，只借 `tracing-appender` 的异步通道**。理由是硬约束：panic hook 必须落到**同一个当日文件**，而文件名若由两处各自推导（我们的 hook 猜上游 crate 的命名格式）迟早分叉。所以 `budget::daily_file_name` 是唯一命名源，`file_sink::DailyRotatingWriter` 自己开文件、自己轮转，`tracing_appender::non_blocking` 只用来把写操作挪到 worker 线程（日志不该阻塞调用方）。
2. **resume 从既有文件尺寸续算**（issue 点名的关键细节）：`DailyRotatingWriter::new` 读当日文件的 `metadata().len()` 作为计数器种子。不这么做时，appender 以 append 模式重开同日文件、每次重启重新发一份 512 MiB 额度——崩溃循环能把盘写满（Codeg 记录过 34 GB / 8.8 小时）。续算值已越限则当日第一条就丢弃（`DayBudget::resuming` + `admit` 的跃迁判定），这正是想要的。
3. **超限丢弃而非截断**：截断会把一行切成半个、破坏「一条记录一行」；部分写会让计数与文件内容脱钩。丢弃在调用方看来是一次成功写入（`Ok(buf.len())`）——报错会让 tracing 打印自己的写失败，那又是一条日志，恰是额度耗尽时最不该发生的事。
4. **panic hook 同步写盘**：直接 `OpenOptions::append` 打开当日文件、写完 flush，完全绕过 non_blocking。采集线程名、`file:line:col`、payload（非字符串有兜底）、`std::backtrace::Backtrace::force_capture()`（不依赖 `RUST_BACKTRACE`，无需外部 crate）。两条截断都在 char 边界回退。自有额度 1 MiB（`AtomicUsize` reserve-then-write）防 panic 风暴绕过每日预算。全程零 `unwrap`。
5. **自反馈隔离两道**：① `RuntimeLogLayer::on_event` 增加「日志子系统自身 target 前缀（带 `::` 边界）不进 hub」；② lag 告警走前缘节流（前缘无条件放行、窗口内折叠、抑制数搭下一条车，窗口 10 秒，per-callsite 实例）。文件 sink 的通报（额度耗尽/跨日重开）刻意**不经 tracing**——它就跑在 subscriber 的 file sink 里，回灌即回路；出口是 `note_to_stderr` + 直接推一条合成 WARN 进 hub。
6. **日志目录必须在 Tauri 之前解析**（`init_tracing` 早于 `setup()`），所以 `paths` 复现了 Tauri `app_data_dir()` 的拼法（`<平台数据根>/<identifier>`）。identifier 与 `tauri.conf.json` 的一致性由单测钉住（`include_str!` 读配置），另有 `setup_install_data_dirs` 的运行时漂移告警兜底。
7. **`eprintln!` 在 GUI 子系统下会 panic**（#361 引入的耦合）：release 双击启动的进程没有控制台，stderr 句柄无效，Rust 的 `eprintln!` 写失败即 panic。在 `non_blocking` 的 worker 线程里 panic 会**永久关掉落盘 sink**，而唯一会走到那里的路径恰是「额度耗尽/跨日重开」通报——正是最需要日志仍在工作的时刻。所以全部改成 `logging::note_to_stderr`（忽略写失败 + 同步追加到当日文件）。启动兜底的 6 处 `eprintln!` 一并改（它们本来就声明「不依赖 tracing subscriber，保证任何入口下 stderr 必达」，而在 release 里 stderr 已经不存在——现在改成「stderr + 日志文件」）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 生成 `pylon.<YYYY-MM-DD>.log`，内容为含时间戳/级别/target 的文本行 | 通过（`writes_lines_and_appends_across_reopen`） |
| 同名文件已存在时重启，计数从既有尺寸续算 | 通过（`reopened_writer_over_a_used_file_does_not_get_a_fresh_quota`：端到端穿 writer 断言既有文件不增长） |
| 超过每日上限后丢弃且只通报一次；跨日恢复并报告上一日丢弃量 | 通过（`exceeding_the_limit_drops_and_latches_with_one_notice`、`day_rollover_resets_and_reports_the_closed_day_losses`） |
| panic 后当日文件出现含线程名/location/payload/backtrace 的记录 | 通过（`append_writes_the_record_to_todays_file_with_all_four_fields`：真实调用落盘路径，目录由该路径自建，第二条断言是追加非覆盖） |
| 日志子系统自身 target 的事件不进 hub，panic target 仍进 | 通过（`layer_skips_logging_self_targets_but_keeps_the_panic_target`、`self_target_matches_the_namespace_and_its_children_only`） |
| lag warn 前缘立即放行、窗口内折叠、窗口外上抛累计 | 通过（`inside_the_window_hits_fold_and_ride_the_next_emit` 等 5 条，注入 `Instant`） |
| 保留 30 个历史文件 | 通过（`prune_history_keeps_only_the_newest_files`，含「非本命名空间文件不得被删」） |
| workspace 单测全绿 | 通过（见「证据」） |

## 测试处置

- 新增：`logging/{budget,file_sink,panic_hook,throttle}.rs` 与 `logging/mod.rs` 共 28 条；`paths.rs` 4 条（identifier 同源、候选顺序、首个可写、data_root）、`runtime_log/mod.rs` 2 条（自身 target 隔离、合成 WARN）。
- 修改/删除既有测试：**无**（`layer_skips_agent_stderr_echo_target_but_keeps_other_errors` 原样保留，新增一条并列用例）。

## 证据

- commit：见本批 PR
- 测试：`cargo test --workspace --lib` → exit 0，`1527 passed; 0 failed; 4 ignored`（各 crate：pylon 902 / pylon-acp 171 / pylon-core 133 / pylon-session 87 / pylon-foundations 87−? 见下 / 其余 22+9+36+167）
  - 定向：`cargo test --lib logging::` → `28 passed; 0 failed`；`cargo test --lib paths::` → `11 passed`；`cargo test --lib runtime_log` → `27 passed`
- clippy：`cargo clippy --workspace --all-targets` 无本批新增告警（逐条核对剩余告警位置，只有 `src/dispatcher/routing.rs:119` 的 `large_enum_variant`，已在 `artifacts/clippy-baseline.json` 基线内；其余在 #371 的 `docs_sheet/**`）
- fmt：`cargo fmt --all -- --check` 干净
- 独立审查（子 agent，对抗式）：确认 resume 链路端到端成立、panic hook 在 `panic = "abort"` 下确实先于 abort 执行、去重与 hub 可见性正确、自反馈回路已可证有界、目录解析与 Tauri 语义等价（记录为已知近似）、层组合与过滤语义符合注释。**审查发现的必修项已全部修掉**：`eprintln!` panic（见方案要点 7）、panic 落盘用例自证（改为真实调用落盘路径）、缺 hub 隔离/throttle/续算的端到端用例（已补）。

## 与 spec 的偏差

1. **spec 说「参数可照搬 Codeg，`Rotation::DAILY` + `max_log_files(30)`」**：实际没有使用 `tracing-appender` 的 rolling appender（它无法与 panic hook 共享文件名的单一真源），改为自实现轮转 + 只借 `non_blocking`。参数（每日、30 个、512 MiB、resume）全部照搬。
2. **spec 说文件 sink 用纯文本**：保持，未引入 `json` feature。
3. **spec 未提「启动兜底 eprintln! 要改成落盘」**：实际做了——它是 #361（GUI 子系统）与本项的直接耦合，不改则启动期诊断在 release 里彻底不可见，且会 panic。
4. **spec 的「未决问题」写日志目录取 `data_root/logs`**：已按此落地（`resolve_log_root` 复用 portable 优先/AppData 回退的同一决策顺序）。

## 未解问题

1. **`%APPDATA%` 是 Tauri known-folder API 的近似**：Windows 上 Tauri v2 用 `SHGetKnownFolderPath(FOLDERID_RoamingAppData)`，本模块读 `%APPDATA%`。二者在被显式改写或服务上下文下会分叉；`%APPDATA%` 缺失时落盘 sink 直接降级为「stderr + hub」不报错。已有运行时漂移告警与单测钉 identifier，但「环境变量被改写」这一情形未覆盖。
2. **多实例并发写同一当日文件时预算是 per-process 的**：两个实例各自从启动时的文件尺寸续算，合计可写两份额度。Codeg 同样如此（无跨进程协调）。单机同时跑两个 Pylon 属非预期用法，未处理。
3. **非 panic 的异常终止仍无记录**：`abort()` 直调、栈溢出、SEH 访问违例、OOM kill 都不经过 panic hook。这是 issue 范围内公认的限制，不做兜底。
4. **`run()` 的 browser-bridge 分支走 `std::process::exit`**，跳过 `LogGuard` 的 drop，缓冲尾巴会丢（该分支在日志有意义之前就退出，影响可忽略）。

## 并行交集

- `src-tauri/src/lib.rs`：本批 hunk 与 #371 的 docs_sheet 接线同文件，按 #371 在 `L.md` 的请求连带提交其 hunk（`docs_sheet/` 已入库）。
- `src-tauri/src/session/mod.rs`：本批只改 dispatcher 的 lag warn 区段（`:408-445`）与测试尾部；#376 的 `evt_load_compact` hunk（`:841-856`）**不由本批提交**（私有 index 分账）。
- `src-tauri/Cargo.lock`：含本批 `tracing-appender` 与他人已提交 manifest 对应的 `symlink` 条目。
- `docs/说明书/Pylon-模块维护地图.md`：本批表述**未被卷入他提交**，随本批提交。
