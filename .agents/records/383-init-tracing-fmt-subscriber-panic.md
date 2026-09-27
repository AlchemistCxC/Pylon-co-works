# Dev Record — #383 启动即崩：`init_tracing` 把过滤层挂到 `fmt::Subscriber`

> 入库保留。规格（spec）不保留；本文件承接目标、范围、方案与验收。

## 元信息

- issue：**#383**（bug：HEAD 启动即 panic，凡日志根可写必现）
- 分支：`kumo/prometheus`
- 提交范围：`563e6bd6..`（本 issue 只改一个文件；同批次另有 #380 的提交）
- 日期：2026-09-27
- 发现途径：#376/#375 内存批次的实机验收（裁决 #4「用项目自带 MCP 对实机合成注入取数」）——
  从源码构建的 debug 二进制起不来，追因追到 `init_tracing`。

## 目标与范围

**目标**：让「日志根可写」的正常环境下进程能启动，并恢复落盘日志链（#362 的崩溃取证依赖它）。

**做到**：改 subscriber 的组装方式（基底 `Registry`）、把三处 `set_global_default` 分叉收成一个
可测构造函数、补 4 条测试（含负向对照）。

**不做什么**：不改 `logging/**`、`runtime_log/**` 的实现（只调用其公开 API）；不动 `main.rs` 的
`LogGuard` 绑定；不改任何日志级别/目标过滤的**语义**（只换挂载方式）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/lib.rs` | `init_tracing()` 重写为「解析落盘 sink → `build_subscriber` → 装全局」；新增私有 `build_subscriber(hub_layer, file_sink)`；新增 `#[cfg(test)] mod init_tracing_tests`（4 测） | 修改 + 新增 |

## 方案要点

- **病因**：`fmt::Subscriber` 上的 `LookupSpan::register_filter` 是**默认实现、直接 panic**
  （`tracing-subscriber` 的 `registry/mod.rs`：`"{type} does not currently support filters"`）。
  原代码 `file_layer.with_filter(...).with_subscriber(base)` 的 `base` 就是 `fmt::Subscriber`，
  于是「拿到可写日志根」这条分支一走就崩。触发条件不苛刻：portable（`<exe>/data/logs`）与回退
  AppData 两条路都满足，**与 debug/release profile 无关** ⇒ 从当前分支构建的发行包 100% 起不来
  （已安装的发行包早于引入该代码的提交 `86fbcb9e`，所以线上没暴露）。
- **修法**：基底换成 `tracing_subscriber::registry()`，三个 sink 平铺挂上——`RuntimeLogLayer`、
  stderr `fmt::layer()`、落盘 `fmt::layer()`。`Registry` 支持 per-layer filtering，落盘层的
  `with_filter` 得以保留。
- **语义逐条对齐**（评审要核的点）：
  - stderr 仍是 INFO 上限：`fmt::Layer` 没有 `with_max_level`，改用 `with_filter(LevelFilter::INFO)`
    ——层内过滤，观感等价；`RuntimeLogLayer` 内部本就有 `level > INFO return` 守卫，故 hub 仍只收 INFO；
  - 落盘层仍按 target 去掉 `PANIC_TARGET`（panic 记录由 hook 同步落盘，是它唯一的落盘者）；
  - `LogGuard._worker` 的生存期、`panic_hook::install()` 的调用时机、`set_global_default` 失败被
    `let _ =` 吞掉的降级行为，全部保持原样。
- **可测性**：`set_global_default` 每进程只成功一次，「构造这条订阅栈不 panic」正是回归点，所以把
  组装抽成 `build_subscriber`，测试用 `tracing::subscriber::with_default` 直接驱动它（hub 用
  `RuntimeLogLayer::with_hub` 注入，避免并行测试争全局注册点）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 带过滤层的落盘 sink 能构造且事件双达（hub + 文件） | PASS（`file_sink_subscriber_builds_and_routes_without_panicking`） |
| `PANIC_TARGET` 不进落盘文件 | PASS（`panic_target_events_stay_out_of_the_file_sink`；断言文件内容） |
| 无落盘 sink（日志根不可写）仍可起、只挂 hub+stderr、不交 guard | PASS（`subscriber_without_file_sink_keeps_hub_and_stderr`） |
| **病因本身**留在 CI（负向对照） | PASS（`#[should_panic(expected = "does not currently support filters")]`） |
| 实机：**日志根可写、无任何绕行**下启动成功 | PASS（进程起、CDP 9222 可达、窗口渲染） |
| 实机：真正落盘 | PASS（`<data_root>/logs/pylon.2026-09-27.log` 1716 B，含 `startup_phase` 各行） |
| 修前同一配方必崩 | 已复现（`thread 'main' panicked at tracing-subscriber-0.3.23/src/registry/mod.rs:149`，exit 101） |

## 测试处置

新增 4 条（`src-tauri/src/lib.rs` 的 `init_tracing_tests`），**未修改**任何既有测试。

## 证据

- commit：`ad3fcbd9`（`fix(logging): #383 …`）
- 测试：`cargo test -p pylon --lib init_tracing` → **4 passed / 0 failed**（4 filtered out 之外共 921 项）
- 构建：`cargo build -p pylon` 成功（`Finished dev profile in 24.71s`）
- 实机：隔离副本（portable `data/` + 独立 `WEBVIEW2_USER_DATA_FOLDER`，**未设** `APPDATA` 覆盖、
  **未**占用 `data/logs`）→ `Get-Process pylon` 存活、`http://127.0.0.1:9222/json/version` 返回
  `Edg/154.0.4258.37`、`data/logs/pylon.2026-09-27.log` 生成且首行是
  `startup_phase phase="run_entry" elapsed_ms=5`
- 反向证据（修前）：同一配方 panic，输出见 issue #383 正文

## 与 spec 的偏差

无 spec（缺陷修复）。issue 里写的修复方向（registry 作基底）与实际实现一致；额外把组装抽成
可测函数并补负向对照，是 issue 未要求但为回归价值而加。

## 未解问题

无。未改 `logging/**` 的其余行为；`panic = "abort"` 的 release profile 行为不受影响。

---

## 评审轮（独立子 agent，对抗式）与处置

评审任务：把本次修复**证伪**（行为等价性、是否有第二处同病、测试是否恒真、修复是否完整、
证据是否够硬）。结论 **APPROVE WITH NITS**，无阻塞项。逐条处置：

| 评审发现 | 级别 | 处置 |
| --- | --- | --- |
| 全局 `max_level_hint` 由 INFO 变 TRACE（debug!/trace! 不再被全局短路，多一次 enabled 走查） | 次要 | **接受 + 已就地注释**（`lib.rs` 的 registry 基底处写明该差异、可见输出不变、以及将来要收紧时的做法）。评审实测：hub 层仍只收 INFO（内部守卫）、落盘文件三种事件均不含 debug/trace |
| 测试经 `build_file_sink` 把进程级 `FILE_SPEC`/`ACTIVE_LOG_ROOT`（OnceLock）指向临时目录，观察到跨测试残留（别人的测试往该目录写） | 次要 | **接受**：断言本就是 contains 型且只看自己的标记串；测试目录带 pid，无翻红风险。残留属测试卫生问题，已在评审记录中登记 |
| `clippy::items_after_test_module`（测试模块之后还有 `LogGuard` 等项） | 提示 | **已由外部修复**：另一 agent 以 **#384** 提交 `3b534c27` 把测试模块移到文件末尾 + rustfmt，并新增 `check:clippy` 本地门禁（`b9ff2642`）。本记录不再重复处置 |
| 记录里的 commit 哈希笔误 `ad3fcdb9` | 提示 | 已修正为 `ad3fcbd9` |
| 事件投递顺序变化（修前 stderr 先、hub 后；修后 hub 先、stderr 再、文件最后） | 提示 | **接受**：三个 sink 相互独立、无顺序契约，无消费方可观测 |
| 负向对照测试测的是库行为而非本仓路径 | 提示 | **接受**：它的价值是钉住**病因解释**（上游哪天给 `fmt::Subscriber` 实现 `register_filter`，`should_panic` 会翻红）；真正的回归锁是第一条落盘栈用例 |

评审的**独立性证据**：它自建依赖锁定同版本 `tracing-subscriber` 的脚手架，逐句复刻修前构造，
独立复现出同样的 panic 文本；并全仓排查了 `.with_filter`（仅本处）与另外 4 处 `with_subscriber`
（挂的都是无过滤层 ⇒ 不触发 `register_filter`），确认**没有第二处同病**。它未能独立复现的两项
（真实 GUI 进程的修前/修后对照、CDP 9222 可达的 artifact）已在记录证据节如实标注。
