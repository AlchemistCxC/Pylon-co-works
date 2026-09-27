# ADR-0028 假 ACP agent 迁出主 crate：测试夹具与生产依赖图解耦

- **日期**：2026-09-27
- **状态**：已采用（实施见 #382；ADR-0005 决定 1 的**载体迁移**，该决定的实质——feature 门控、发行包不含夹具——不变）

## 背景与约束

测试夹具 `pylon-fake-agent`（假 ACP 子进程 agent）是 2100 行 Rust，源码只 `use serde_json` + `std`，无 `env!` / `include_str!`，与生产代码零耦合。但它原先是主 crate `pylon` 的一个 `[[bin]]`，因此吃到了 Cargo 的一条隐式规则：**包内的 bin 会隐式链接本包 lib**（`cargo build --bin X` 先把本包 lib 编成 rlib，再给 bin 传 `--extern <libname>`；已用一次性 crate 复现）。后果是编这个夹具等于编整个 app。

实测（CI run 36254730282，2026-09-26，绿）：

| job | 步骤 | 耗时 | 该步 `Compiling` |
| --- | --- | --- | --- |
| Rust（ACP shadow parity），job 合计 15m08s | 构建 fake agent | 5m26s | 405 个 crate（tauri 2.11.6 / rusqlite / reqwest / tokio / pylon-acp …） |
| Rust（fmt + 测试 + 构建） | Rust 测试与构建（4 条 cargo 命令） | 4m46s | 20 行（9 个 workspace crate） |

采样 2026-09-24 ~ 09-27 的 12 个 run（main + 各分支，成功与失败都有）：该步骤稳定 3.9–5.7 min。附带代价：夹具编译被迫前置整条前端构建（主 crate lib 里 `tauri::generate_context!()` 要求 `../dist` 存在）。

约束：不改夹具的场景语义与任何测试断言；运行期定位契约不变（`PYLON_FAKE_AGENT_BIN` 覆盖 → 否则沿 `current_exe()` 祖先目录找 `target/<profile>/pylon-fake-agent(.exe)`）；发行包不含该 bin；`--features test-agent` 门控语义保留。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 预构建产物 + 注入（artifact / actions-cache → `PYLON_FAKE_AGENT_BIN`） | 只省掉"构建 fake agent"那一步，省不掉 fixture 自身那次主 crate 编译；artifact 要给消费 job 加 `needs:`（串行化，前置 job 早失败就没信号）；cache 路线必须把夹具源码纳入 key，否则跨 commit 复用旧夹具 = 静默假绿；且 `cargo test --tests` 仍会把这个同包 bin 当测试靶再编一遍 |
| 只修 rust-shadow job 的 rust-cache 僵尸条目（`prefix-key` 换代） | 治表象：任何冷缓存、新分支、fork 仍付全量；夹具的依赖面本身仍然是错的 |
| 维持现状 | 每 run 白付约 5.5 min，且这笔开销在源码里看不出来（bin 没有任何 `use prism_desktop_lib`），后来者会反复重新发现 |

## 决定

1. 夹具迁为独立 workspace member crate `src-tauri/pylon-fake-agent`，依赖只有 `serde_json`；源码 `git mv` 自 `src-tauri/src/bin/pylon-fake-agent.rs`。
2. 保留 `test-agent` feature + `[[bin]] required-features` 门控（默认构建/发行不含它），因此该 feature 在新 crate 内是空 feature，只为门控存在。
3. 主 crate 删除该 `[[bin]]`，**保留** `test-agent = ["tauri/test"]`（主 crate 的 lib 测试仍需 mock runtime，见 `lib.rs:50,53` 等多处 `cfg(any(test, feature = "test-agent"))`）。
4. 命令入口由 `--bin pylon-fake-agent` 改为 `-p pylon-fake-agent`（CI ×2、`package.json` check:rust、文档与失败提示）。
5. 新 crate 显式声明 `serde_json` 的 `preserve_order` feature：主 crate 图里该 feature 是**其他依赖**开启的（feature 统一），迁出后自动失去；失去它就等于换了序列化器行为——`json!` 按字面顺序构造的响应体会退化成字典序，golden trace 基线（逐字节比对）当场漂移（实测 `cancel.jsonl` 第 7 行 `update` 的两个键换位）。这是本次唯一的**非机械**改动。

## 后果

- 正面：冷编实测 **4.24s**（本机，全新 target 目录）对照 CI 的 326s；夹具编译不再需要前端 `../dist` 前置；依赖面写进 manifest 一行，可读；夹具的 11 条单测仍被 CI 的 `cargo test --workspace --tests --features test-agent` 选中（实证：`pylon_fake_agent-…exe` 11 passed），另在本地 `check:rust` 里加了显式 `-p` 一行补上本地口（该脚本原先只跑 `--workspace --lib`，从不跑夹具自身单测）。
- 负面：workspace 多一个成员；旧命令 `cargo build --bin pylon-fake-agent` 由"可用"变为报错（`no bin target named ... in default-run packages`，并给出指向新包的提示）。
- 教训：package 边界同时是一条**隐式 feature 边界**。夹具的 wire 字节序曾依赖"主 crate 图里有别的依赖开了 `preserve_order`"这一事实，任何拆包动作都必须把用到的 feature 显式化，否则最隐蔽的失败是"JSON 语义相同、字节不同"——只有逐字节基线能抓住。
- 风险：无 wire / 持久化 / 公开 API 影响。回滚 = 还原 `[workspace] members` 与主 crate 的 `[[bin]]` 声明、把文件挪回原位。

## 证据

- 隐式链接规则：临时 crate 复现（`cargo build --bin <x> -v` 先 `--crate-name <lib>` 再给 bin `--extern`）
- CI 数字：run 36254730282（job 108439239045 「构建 fake agent」16:17:04→16:22:30；`Finished ... in 5m 25s`；405 行 `Compiling`）；采样 12 run 见 #382 正文
- 本地冷编：`CARGO_TARGET_DIR=<空目录> cargo build -p pylon-fake-agent --features test-agent` → 4.24s
- 门控与选择语义：无 feature 时报 `requires the features: test-agent`；主包 `--bin pylon-fake-agent` 报 `no bin target named`
- feature 统一的实证：`cargo tree -e features -i serde_json`（主 crate 图含 `preserve_order`，经 `indexmap`）对照 `-p pylon-fake-agent`（只有 `default`+`std`）；`PYLON_GOLDEN_TRACE_DIR=<tmp> cargo test --lib --features test-agent acp::golden_trace_tests::golden_trace_baseline_generation -- --exact` 后与 `src-tauri/tests/golden-traces/*.jsonl` 逐字节比对：修前 9/10 不一致（`initialize.jsonl` 恰好无键序敏感字段），补 `preserve_order` 后 **10/10 一致**
- 代码：`src-tauri/Cargo.toml`（members + 删 `[[bin]]`）、`src-tauri/pylon-fake-agent/Cargo.toml`、`.github/workflows/ci.yml`、`package.json`、`src-tauri/src/test_utils.rs:33`
