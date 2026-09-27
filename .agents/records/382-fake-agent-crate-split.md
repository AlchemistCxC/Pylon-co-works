# Dev Record — #382 假 agent 拆独立 crate

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/382-fake-agent-crate-split.md`

## 元信息

- issue：#382（refactor）——https://github.com/AlchemistCxC/Pylon-co-works/issues/382
- 分支：`kumo/prometheus`（沿用既有 PR #374 的共享分支）
- 提交范围：`f93f3775`（会话起点）→ `19b49d22`（本次）；区间内另有他人提交 `c77f571b`（merge github/main）/ `49bfffe4` / `5ddf0381`，非本批
- 日期：2026-09-27
- ADR：`.agents/decisions/0028-fake-agent-crate-split.md`（并给 ADR-0005 决定 1 加了载体指迁移针）

## 目标与范围

**做什么**：把测试夹具 `pylon-fake-agent` 从主 crate `pylon` 的 `[[bin]]` 迁为独立 workspace member crate，使其编译不再连带整棵 Tauri 依赖树。

**不做什么**：不动夹具的场景语义与旗标；不动其他 `[[bin]]`；不处理 rust-shadow job 的 rust-cache 僵尸条目；不做"预构建产物 + artifact 分发"；不改任何既有 Rust 测试断言与 golden 基线。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-fake-agent/Cargo.toml` | 新 crate manifest（deps 只 serde_json + preserve_order；`test-agent` feature + `[[bin]] required-features`） | 新增 |
| `src-tauri/pylon-fake-agent/src/main.rs` | 原 `src-tauri/src/bin/pylon-fake-agent.rs` 全文迁移 + 头部构建命令与迁出说明 | 重命名 |
| `src-tauri/src/bin/pylon-fake-agent.rs` | 旧位置（已迁走） | 删除 |
| `src-tauri/Cargo.toml` | `[workspace] members` 增员；删 `[[bin]] pylon-fake-agent`；`test-agent` feature 注释改写 | 修改 |
| `src-tauri/Cargo.lock` | 新增 `pylon-fake-agent` package 条目（仅此 7 行） | 修改 |
| `.github/workflows/ci.yml` | 两处构建命令 `--bin` → `-p`；#382 成本注记与 #106 P1 注释对齐 | 修改 |
| `package.json` | `check:rust`：`--bin` → `-p`，并补一条显式夹具单测（见"与 spec 的偏差"） | 修改 |
| `src-tauri/src/test_utils.rs` | 模块文档改述独立 crate；`fake_agent_bin()` 的 panic 提示命令改 `-p` | 修改 |
| `src-tauri/pylon-acp/src/engine.rs` | 同上 panic 提示文案（1 行） | 修改 |
| `src-tauri/tests/integration.rs` | 头注前置命令改 `-p` | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | §16 测试入口命令段（`--bin` → `-p` + 说明） | 修改 |
| `.agents/skills/code-stats/SKILL.md` | 夹具路径判据描述随迁 | 修改 |
| `scripts/code-stats.mts` | `isTestPathRust` 判据：`src-tauri/src/bin/pylon-fake-agent.rs` → `src-tauri/pylon-fake-agent/` 前缀 | 修改 |
| `scripts/code-stats.test.mts` | 对应用例断言随迁 + 补一条负向断言（`Cargo.toml` 不算测试文件） | 修改 |
| `.agents/decisions/0005-unified-test-harness.md` | 状态行加 ADR-0028 载体迁移指针 | 修改 |
| `.agents/decisions/0028-fake-agent-crate-split.md` | 新 ADR | 新增 |

## 方案要点

1. **根因**：Cargo 的"包内 bin 隐式链接本包 lib"——`cargo build --bin X` 会先把本包 lib 编成 rlib 并给 bin 传 `--extern`（用一次性 crate 复现）。夹具源码只 `use serde_json` + `std`，但命令驱动的是整个 app。
2. **载体迁移而非决定反转**：保留 `test-agent` feature 与 `required-features`，因此"默认构建/发行不含该 bin"（ADR-0005 验收项）原样成立；在新 crate 内该 feature 是空 feature，只为门控存在。
3. **定位契约零改动**：workspace 共享单一 `target/`，member bin 仍产出 `target/<profile>/pylon-fake-agent(.exe)`，`test_utils::fake_agent_bin()` 的祖先目录搜索不受影响。
4. **显式声明 `serde_json/preserve_order`（唯一非机械改动）**：主 crate 图里该 feature 由其他依赖开启（feature 统一），迁出即失去；失去后 `json!` 的 Map 由 IndexMap 退化 BTreeMap，响应体键序由插入序变字典序 —— golden trace 基线是**逐字节**比对，当场漂移。实测漂移点：`cancel.jsonl` 第 7 行 `update` 的两个键换位。manifest 已注明"不要顺手删"。
5. **命令入口 `--bin` → `-p`**：`--bin` 在 workspace 下落在当前包（主包）上，会立刻报 `no bin target named ... in default-run packages`（并提示新包），是个安全的失败形态。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 既有行为测试全绿，且未被修改 | ✅ 无 Rust 测试改动；golden 基线 10/10 逐字节一致（未重生成） |
| 门禁全绿（`bun run check:rust`） | ✅ exit 0（夹具 11 passed；workspace lib 1556 passed / 0 failed / 4 ignored；`cargo build` Finished；`check:acp-shadow` 通过；fmt 干净） |
| 结构目标：冷编秒级 | ✅ `CARGO_TARGET_DIR=<空目录> cargo build -p pylon-fake-agent --features test-agent` → **4.24s**（对照 CI 326s / 405 crate） |
| 主包不再有该 bin 靶 | ✅ `cargo build --bin pylon-fake-agent --features test-agent` → `no bin target named pylon-fake-agent in default-run packages`；`cargo metadata` 主包 bins = `pylon/pylon-cli/pylon-detect` |
| 默认构建/发行不含夹具 | ✅ 无 feature 时 `-p pylon-fake-agent` 报 `requires the features: test-agent`；`cargo build` 全过程中 `Compiling pylon-fake-agent` 出现 0 次 |
| 夹具单测仍被 CI 选中 | ✅ `cargo test --workspace --tests --features test-agent` 产出 `Running unittests src\main.rs (pylon_fake_agent-….exe)` → 11 passed |
| 未新增白名单豁免 | ✅ 无 |

## 测试处置

- 修改的既有测试：`scripts/code-stats.test.mts`「Rust 文件级判据（tests 目录与假 agent）」——夹具路径断言随迁（旧路径已不存在），并补一条负向断言。属**工具契约变更**（判据的路径形态变了），非行为测试放水。
- 删除的测试：无。Rust 侧测试文件与 golden 基线零改动（基线仅在"修复 preserve_order 前"短暂漂移过，修好后逐字节复原，未落盘任何基线变更）。

## 证据

- commit：`19b49d22`（本记录单独一笔）
- 命令与结果（均带退出码/计数）：
  - `CARGO_TARGET_DIR=<空> cargo build -p pylon-fake-agent --features test-agent` → `Finished dev profile in 4.24s`
  - `bun run check:rust` → **exit 0**；途中 `test result: ok. 11 passed`（夹具）、913/185/9/36/133/87/22/0/171 = **1556 passed, 0 failed, 4 ignored**（workspace lib）；`check:acp-shadow` 通过（`generatorElapsedMs`: 2998）
  - `cargo test --workspace --lib --features test-agent` → exit 0
  - `cargo test --workspace --tests --features test-agent` → exit 0（含 28 集成 + 11 夹具）
  - `bunx vitest run scripts/code-stats.test.mts` → 20 passed
  - golden 逐字节：`PYLON_GOLDEN_TRACE_DIR=<tmp>` 跑 `acp::golden_trace_tests::golden_trace_baseline_generation --exact` 后与 `src-tauri/tests/golden-traces/*.jsonl` 比对 → **10/10 一致**（补 `preserve_order` 前 9/10 不一致）
- 手工验证：
  - `cargo metadata --no-deps` 成员与 bin 清单（见上表）
  - `cargo build --bin pylon-fake-agent` 无 feature / 有 feature 两种失败与成功形态
- 环境注记：**G: 盘 99% 满（剩 1.2G）**，本次 Rust 门禁一律 `CARGO_TARGET_DIR=D:/pylon-382-target`（沿用仓内既有做法），未在共享 `src-tauri/target` 里堆新产物。

## 与 spec 的偏差

1. **新增 `serde_json/preserve_order` 显式声明**：spec 的"方案"是按纯结构迁移写的，没有预见 feature 统一会随包边界消失。这是本批唯一改变夹具构建输入的改动——不补它就等于改变夹具输出行为（见方案要点 4）。
2. **`check:rust` 增一条 `cargo test -p pylon-fake-agent --features test-agent`**：spec 未列。理由：该脚本只跑 `--workspace --lib`，夹具自身的 11 条单测在本地门禁里从来没有入口（CI 有，靠 `--tests`）。
3. **多改了两处 spec 未列的文件**：`scripts/code-stats.mts` 与其单测硬编码了夹具旧路径（spec 只发现 `SKILL.md` 那份），以及 `src-tauri/Cargo.lock`（成员新增的必然产物）。
4. **撤销了一处我自己先加的 CI 行**：曾据一次被中断的测试输出判定"夹具单测会从 `--workspace --tests` 选择里掉出"，据此在 CI 的测试步加了一行显式 `-p` 并写了成因注释；后经完整输出核实（`pylon_fake_agent-….exe` 11 passed）确认该判断错误——那是一条约 `managed_probe_cleanup_kills_descendant_processes` 失败后 cargo 中止后续靶的假象。错误的注释与 CI 行已撤除，本地 `check:rust` 的补口保留（理由见偏差 2）。

## 未解问题

1. **rust-shadow job 的 rust-cache 僵尸条目未处理**：该 job 的 `构建 fake agent` 步即使迁出后也仍会在冷缓存/条目失效时重编；根因（旧条目 + 不可改写）与本批正交，建议单独开 issue（一行 `prefix-key` 换代即可验证）。
2. **G: 盘 99%**：本地 Rust 门禁已改用 D: target 规避；共享树的 `src-tauri/target` 若继续膨胀会阻塞他人，建议仓库主评估清理策略。
3. **观测到一条既有 flake**：`pylon-core::agent_detection::tests::managed_probe_cleanup_kills_descendant_processes` 在 `--workspace --tests --features test-agent` 连跑多靶时失败过一次（`Os { code: 32, 另一个程序正在使用此文件 }`），隔离复跑与后续各轮均绿。与本批无关（pylon-core 不依赖主 crate），但 CI 也跑同一条命令，值得单独立项。

## 并行交集

本次碰过的共享文件（供其他贡献者避让）：

- `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`（成员与锁）
- `.github/workflows/ci.yml`、`package.json`
- `docs/说明书/Pylon-项目架构参考.md`（仅 §16 命令段两行）
- `src-tauri/pylon-acp/src/engine.rs`（仅 1 行提示文案；该文件在批内一度出现**他人在途的未解冲突标记** `<<<<<<< HEAD … >>>>>>> github/main`，导致本批首次 `check:rust` 编译失败——已由对方解掉，本批未触碰其 hunk）
- `src-tauri/src/test_utils.rs`、`src-tauri/tests/integration.rs`
- **共享树观测**：施工期间他人有在途改动（`scripts/perf-bench/**`、`src-tauri/pylon-session/src/event_repo/**`、`src/domains/workbench/**`、`src/sheets/agent-workbench/**`）并有 staged 内容停留在共享 index；本批全程 pathspec 提交、提交后 `git show --stat` 核对仅含本批文件。另：共享 index 曾出现"index 比 HEAD 旧"的 stale 形态（他人在途），本批未做任何 index 复位操作。
