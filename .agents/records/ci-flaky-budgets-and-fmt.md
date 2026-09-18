# Dev Record — CI 红：进程类测试预算被饥饿击穿 + main 的 fmt 门禁

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/ci-flaky-budgets-and-fmt.md`

## 元信息

- issue：**#157**（同类 flake 的归口 issue：`bug(test): Rust 全量并行下 flaky`）；本任务由用户在会话中直接授权「在本次 PR 内解决」
- 分支：`Ru5t/Reflector`
- 提交范围：`2c5f2ea9..a2dac410`
- 日期：2026-09-18
- 署名：Borges

## 目标与范围

CI 的 Rust job 在 PR #160 上为 failure，用户怀疑是「没跑 fmt」。排查后确认**不是 fmt 漏跑，而是两个彼此独立的既有故障**，两者在 main 上同样存在：

1. **进程类测试的硬编码 3s 等待窗口被饥饿击穿**（flake）。
2. **`cargo fmt --check` 门禁本身为红**（确定性），只是长期被第 1 个故障挡在步骤序列后面、从未跑到。

目标是让 Rust job 能连续变绿。

**不做什么**：不改任何断言与被测契约；不改 CI 编排（`.github/workflows/ci.yml`）；不动这两个文件里未被证据指向的等待（见「未解问题」）；不碰其他 crate。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-core/src/agent_detection.rs` | 仅 `managed_probe_cleanup_kills_descendant_processes`：提出 `PROBE_READY_WAIT` / `PROBE_EXIT_WAIT` 两个具名常量，替换内联的 3s / 1s 两处 deadline | 修改（测试内） |
| `src-tauri/src/plugin_process/tests.rs` | 文件头新增 `SPAWN_WAIT_MS` / `TREE_REAP_WAIT_MS` 常量；替换 5 处 `3_000`·`from_secs(3)` 与 1 处 `sleep(250ms)` | 修改（测试内） |
| `src-tauri/src/session/turn_rollup.rs` | `cargo fmt` 输出（一处 `assert_eq!` 拆行） | 修改（纯格式化） |

无重命名。

## 方案要点

### 故障一：为什么是「放宽预算」而不是别的

- **它是预算，不是契约。** 两个测试被验的都是语义：`managed_probe_...` 验「cleanup 杀掉了孙进程」，`checked_in_json_rpc_example_...` 验「内嵌示例包能起来并回应」。3s 只是等它就绪的窗口。放宽窗口不放宽断言，因此**不构成弱化门禁**（`dev-standards` §验证与交付要求「不弱化门禁」，此处严格遵守：六处断言一字未改）。
- **为什么是放大而不是轮询重构。** 归档旧板对此已有定论：「vitest+cargo 双套件并发满载时 Rust 等待预算型测试会被饥饿击穿（独立运行零失败）——CI 编排可议**串行或放大**」。本次取「放大」：改动局部、不拖慢所有人的 CI、不引入新结构。串行编排作为另一条路留给用户（见「未解问题」）。
- **取值口径对齐既有惯例**，不是拍脑袋：`plugin_process/tests.rs` 其余等待本就在 `10_000`（165 行）/ `20_000`（248 行）量级，被改的 3s 几处本就是偏紧的异类；故统一到 30s。`agent_detection` 的「孙进程收敛观察」从 1s 提到 10s——杀进程树 + 进程退出的传播同步本身慢于空闲假设。

### 故障二：fmt 门禁的红不在本 PR、也不在本分支

- `cargo fmt --all --check` 实际 `rc=1`，**唯一**不合格式的文件是 `src-tauri/src/session/turn_rollup.rs`。
- 归属已逐版回溯钉死：上一版（`16698998`）经 `rustfmt --check` 为 **rc=0**，`be9db4bf`（该提交给此文件新增 261 行）为 **rc=1**。
- 且**分支版与 main 版逐字节相同**（`git diff` 为空）——所以 main 的该门禁同样是红的。它能潜伏至今，是因为 job 的步骤顺序是「Rust 测试与构建」→「fmt」→「clippy」，测试那步 exit 1 就短路了，fmt 从未执行。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| CI 同款命令 `cargo test --workspace --lib --features test-agent` 本地全绿 | 通过：1090 / 93 / 61 passed，**0 failed** |
| `pylon-core` 单套（含被改模块） | 通过：93 passed / 0 failed（CI 上原为 92/1） |
| `plugin_process::tests` 全套（含 CI 上失败项与改过 250ms 的那条） | 通过：8/8，含 `checked_in_json_rpc_example_is_runnable` 与 `job_object_kills_descendant_process_tree` |
| `session::turn_rollup`（被格式化的文件） | 通过：6 passed / 1 ignored |
| `cargo fmt --all --check` | 通过：**rc=0**（修前 rc=1） |
| 断言有无改动 | 无：六处等待全部只换数值，断言与判据一字未改 |

## 测试处置

未修改、未删除任何测试的断言。改动仅限等待窗口的数值与具名常量的引入。

## 证据

- commit：`3ce3aa14`（测试预算）、`a2dac410`（fmt）、本记录一笔
- 失败现场（CI）：
  - 本分支 head `ae271554` → `agent_detection::tests::managed_probe_cleanup_kills_descendant_processes`，panic 在 `pylon-core/src/agent_detection.rs:3093`：`descendant pid file: Os { code: 2, kind: NotFound }`；`test result: FAILED. 92 passed; 1 failed`
  - main `42e4ea4c` → `plugin_process::tests::checked_in_json_rpc_example_is_runnable`，panic 在 `src/plugin_process/tests.rs:494`（`request(..., 3_000, ...)` 超时）；`test result: FAILED. 1089 passed; 1 failed`
  - **不同 run 挂不同测试 = flake 签名**，而非确定性损坏
- 空闲机器量级（本机，单跑）：该测试 3/3 绿，1.05s / 0.39s / 0.34s——相对 3s 预算有 3–9 倍余量
- 争抢量级：同一套 `--lib` 根套件本机 1090 项耗时 **5.47s**，CI 上 1089 项耗时 **17.39s**（≈3.2×）；CI 的 `--lib` 全程为多文件并行、runner 为共享机型
- fmt：`cargo fmt --all --check` 修前 rc=1、修后 rc=0；归属回溯见上节
- 门禁：`cargo fmt --all --check` rc=0；`cargo test --workspace --lib --features test-agent` 全绿
- **CI 实测（真验证）**：head `85b8f0e0` → Rust job `success`（步骤 10/11/12/13 全 success，14 success，15/16 skipped）、前端 job `success`。对照基线：修前 `ae271554` 的 Rust job 为 failure（测试步骤 exit 1）
- 复现入口：`bun scripts/check-doc-links.mjs`（文档面）；`cargo fmt --all --manifest-path src-tauri/Cargo.toml --check`（fmt 面）；`cargo test --workspace --lib --features test-agent`（测试面）

## 与 spec 的偏差

无 spec。偏差两处：

1. **原打算只修「证据指向的 5 处 3s」**，实际多改了 1 处：`job_object_kills_descendant_process_tree` 里「杀完睡 250ms 就断言孙进程已死」。它是同型潜伏点（固定窗口框住进程树收敛），一并放宽到 2s 并在提交与记录中披露。**未**动 `2_000` 量级的四处（154/220/314/386 行）——它们没有失败证据，属「有据才改」的边界之内。
2. **先按 §2.3-4 追加了文件域声明再动手**（两次 `L.md` 提交 `6fe6f60c`、`2c5f2ea9`）：第一次只声明两个测试文件；查明 fmt 故障后补声明第三个文件 `turn_rollup.rs`，两次都即时提交并推送，使并行会话可见。

## 未解问题

- **本机无法制造 CI 的争抢条件** → **已由 CI 实测收口**：修后 `85b8f0e0` 的 Rust job 全绿（04:46:03→05:10:21，24m18s），逐步核对 10「Rust 测试与构建」/ 11「fmt」/ 12「ACP shadow parity」/ 13「clippy」**全部 success**，14「上传 debug 产物」success，15/16「失败证据包」正确 skipped。即：30s 预算在真实争抢下成立；且第 11–13 步此前从未被执行过（被测试步骤的 exit 1 短路），本次一并证明它们本就正常——**潜伏故障确实只有两个，没有第三个**。
- **CI 编排是否应改串行**：归档旧板的建议是「串行或放大」，本次只做了「放大」。串行会拉长所有人的 CI 用时，属编排决策，留给用户。
- **`2_000` 量级的四处等待**（`plugin_process/tests.rs` 154/220/314/386 行）与本次同属「预算封顶」的形态，本次未动（无失败证据）。若后续再出现同型红，它们是第一顺位嫌疑。
- **`be9db4bf` 的提交纪律问题**：该提交新增 261 行却未过 fmt，说明当时的本地门禁没有覆盖到它（或未跑）。与「提交前跑 `cargo fmt --all --check`」应当写进日常动作有关——本次未改 `AGENTS.md`（它已在 §2.4 指向 `check:rust`，而 `check:rust` 含 `cargo fmt --check`；`check:rust` 属「改动范围大才跑全测」的另一条链），登记备查。

## 并行交集

本次碰过的文件：`src-tauri/pylon-core/src/agent_detection.rs`、`src-tauri/src/plugin_process/tests.rs`、`src-tauri/src/session/turn_rollup.rs`、`.agents/L.md`、`.agents/records/`。

**未触碰**：两个文件的非测试逻辑、其他 crate、`.github/workflows/`、`package.json`、`AGENTS.md`、`docs/说明书/`。

已按 §2.3-4 两次在 `L.md` 声明文件域并即时推送。开工时工作树无他人未提交改动（`git status --porcelain` 仅本任务的三处）。
