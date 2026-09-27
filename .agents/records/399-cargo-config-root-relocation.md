# Dev Record — #399 `.cargo/config.toml` 上移仓库根（cwd 决定的构建指纹分叉）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/399-cargo-config-root-relocation.md`

## 元信息

- issue：#399（refactor）——https://github.com/AlchemistCxC/Pylon-co-works/issues/399
- 分支：`kumo/prometheus`
- 提交范围：`52d52c87`（会话起点）→ `b5ab171f`（config 搬迁 + ADR）；本批另有 L.md 声明提交 `ef39929f` 与本记录提交。区间内含他人提交 `6dd5a6cf`（#398 功能批）、`5f8c2579`（#398 记录），非本批；工作树同时有 #398 批的在途改动。
- 日期：2026-09-27
- ADR：`.agents/decisions/0031-cargo-config-repo-root.md`

## 目标与范围

**做什么**：把 `.cargo/config.toml` 从 `src-tauri/.cargo/` 上移到**仓库根**，消除「cargo 配置可见性由 cwd 决定」造成的两套构建指纹——`cd src-tauri && cargo …` 与 `cargo --manifest-path src-tauri/Cargo.toml …` 从此命中同一份配置。

**不做什么**：不改任何 cargo 调用点的 cwd 与参数（shadow / clippy 脚本原样）；不合并重复运行（generator 与 shadow 各跑一遍同一 fixture、背压两次 cargo）；不动 CI job 结构、rust-cache 作用域、shadow 比较逻辑与 golden 基线；不采用 `CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER` 环境变量方案；不改 `tools/webview2-mcp` 源码。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `.cargo/config.toml` | 自 `src-tauri/.cargo/config.toml` 上移（两个键值一字未动）+ 「位置约定（#399）」注释 8 行 | 重命名 |
| `src-tauri/.cargo/` | 旧目录（随重命名清空） | 删除（同一次重命名） |
| `docs/说明书/Pylon-模块维护地图.md` | 「验证」节 cargo 指纹那句（单行，补配置位置与成因）——**已被 #398 批提交 `6dd5a6cf` 连带带入库**，故本批 PR diff 看不到它（内容在库，见「并行交集」） | 修改 |
| `.agents/decisions/0031-cargo-config-repo-root.md` | 新 ADR（备选方案与否决理由） | 新增 |
| `.agents/records/399-cargo-config-root-relocation.md` | 本记录 | 新增 |
| `.agents/L.md` | 在途声明（单独提交 `ef39929f`） | 修改 |
| `.agents/spec/399-cargo-config-root-relocation.md` | 规格（不入库） | 新增 |

## 方案要点

1. **根因（可复现）**：cargo 的配置发现**从 cwd 逐级向上**，`--manifest-path` 只换 manifest、**不**携带 manifest 目录的 `.cargo/`。局部探针：cwd=仓库根 + `--manifest-path sub/Cargo.toml` 时 manifest 目录内的配置完全不加载；cwd 自身/祖先目录的配置正常加载。
2. **为什么会互相作废**：`-C linker` 参与每个 unit 的 rustc flag 哈希，而 `-C extra-filename` 不含 linker ⇒ 两形态写**同一批产物路径**。同一 target 目录实测：形态 S（`cd src-tauri`）编 9 → 切形态 R（仓库根 `--manifest-path`）再编 9 → 切回 S 又编 9（`pylon-fake-agent` 图 9 个 crate 全量）。
3. **选仓库根而非改脚本 cwd**：cargo 走 cwd 向上，仓库根是两侧 cwd 的公共祖先，一次搬迁同时修好 `scripts/check-clippy.mjs`、CI clippy job（`ci.yml:400`）与 `ci.yml:306` 的 `cargo check --manifest-path`，且不要求后续调用点了解这条规则。备选与否决理由见 ADR-0031。
4. **调用点零改动**：`scripts/**`、`.github/workflows/**` 一行未动（`git diff` 可核）。
5. **副作用面**：`tools/webview2-mcp`（不属 `src-tauri` workspace）从仓库根构建时也会吃到该配置 → 实测其 release 构建通过（见证据）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 双 cwd 指纹一致性（同 target 交替调用重编数） | ✅ **9 / 9 / 9 → 0 / 0 / 0**；扩测子 crate cwd（`src-tauri/pylon-acp`）亦为 0；全新 target + 仓库根 cwd 的 rustc 命令行含 `-C linker=rust-lld` **12 次**（配置确已在根 cwd 生效） |
| 实跑 `bun run check:acp-shadow` | ✅ **exit 0**；`ok`/`deterministic` true、8 scenario × 9 字段 parity 全 true（`false` 字面量仅 `legacyFallback:false`）；`fixtureElapsedMs` **[3865, 2394] ms**（对照迁移前 CI 295–305s）、`generatorElapsedMs` 191304、`backpressureElapsedMs` 51029 |
| `tools/webview2-mcp` release 构建 | ✅ `cargo build --manifest-path tools/webview2-mcp/Cargo.toml --release` → exit 0（`Finished release profile in 30.10s`，产物 3.29MB 更新） |
| 既有行为测试全绿且未被修改 | ✅ 本批未新增/未修改任何测试文件（`git diff` 无 `*test*` 路径） |
| 门禁全绿 | ✅ `cargo fmt --all --check` exit 0；`bun run check:clippy` **exit 0**，6 crate（pylon / pylon-core / pylon-acp / pylon-session / pylon-foundations / pet-core）均 `added: []` `removed: []` |
| 结构目标达成 | ✅ 仓内 cargo 调用不再因 cwd 分叉（四种 cwd 命中同一指纹）；旧路径 `src-tauri/.cargo/` 目录已不存在 |
| 未新增白名单豁免 | ✅ 无 |

## 测试处置

- 新增测试：无。
- 修改/删除既有测试：无。
  （构建配置位置变更，行为契约与测试断言零改动；验证走指纹探针 + 实跑门禁。）

## 证据

- commit：`b5ab171f`（config 搬迁 + ADR；本记录单独一笔 `docs(record)`）
- 双 cwd 探针（临时 target 目录，`pylon-fake-agent` 图，cargo 1.98.1 / rustc 1.98.1，`CARGO_PROFILE_DEV_DEBUG=1` `CARGO_INCREMENTAL=0`）：

  | 形态 | 迁移前重编数 | 迁移后重编数 |
  | --- | --- | --- |
  | cwd=`src-tauri` | 9 | 0 |
  | cwd=仓库根 + `--manifest-path` | 9 | 0 |
  | 切回 cwd=`src-tauri` | 9 | 0 |
  | cwd=`src-tauri/pylon-acp` | — | 0 |

  另：迁移后「仓库根 + `--manifest-path`、全新 target」的 verbose 输出里 `-C linker=rust-lld` 出现 12 次（迁移前该形态为 0 次、走默认 `link.exe`）。
- `bun run check:acp-shadow` → exit 0；报告字段：`generatorElapsedMs: 191304`、`fixtureElapsedMs: [3865, 2394]`、`fixtureTestMs: [900, 450]`、`backpressureElapsedMs: 51029`、`maxTraceBytes: 5617`（limit 4MiB，`withinBound: true`）。
- 背压两条测试单独计时（探针形态、热态）：`inbox_full_spills_then_delivers_every_frame_in_order` test 本体 0.02s / wall 2294ms；`spill_overflow_terminates_connection_with_explicit_overload` 0.00s / wall 508ms。
- `cargo fmt --all --manifest-path src-tauri/Cargo.toml --check` → exit 0。
- `bun run check:clippy` → exit 0（见上表 6 crate `added: []`）。
- CI 侧基线（迁移前，供对照）：run 36319970454 / 36317357926 / 36312288458 的 `check:acp-shadow` 一步 784s / 766s / 758s，其中 generator 419/367/357s、fixture A 305/294/297s、fixture B 1.2/1.1/1.1s、背压 58/51/52s，测试本体 0.27–0.36s。
- 环境注记：本地 G: 盘一度只剩 560MB（99% 满）。为让门禁跑得下去，删除了可再生的 `src-tauri/target/debug/incremental`（L.md 认可的处置），**未动** `target/release`（观测到他人 18:52 还在其中产出 `pylon-detect`）。

## 与 spec 的偏差

1. **第一次 `check:acp-shadow` 被中断后重跑**：首跑与另一 agent 的在途 clippy 争 `src-tauri/target` 的 build lock（日志首行即 `Blocking waiting for file lock on build directory`），同时磁盘降到 560MB，遂终止该次运行（终止形态是 rustc `0xc0000142 STATUS_DLL_INIT_FAILED`）；清掉可再生缓存、锁空出后重跑得到上表结果。故本批的本地墙钟数据是**无并发争用**的一次采样。
2. **新增 ADR-0031**（spec 只写了开发记录）：本变更改动的是 #106 P6 决定的实施载体（配置位置），且备选方案有实质取舍，按 §2.3-3 落 ADR。
3. **spec 未列的两项环境处置**：删除 `target/debug/incremental`（可再生）、首次运行中断（见偏差 1）。

## 未解问题

1. **背压探针的 ~51s 与本变更无关**：本地 51029ms 与 CI 51–58s 同量级且高度稳定，而两条探针测试本体只有 0.02s/0.00s ⇒ 这 51s 是 cargo 侧开销（两条 `-p pylon-acp --lib` 调用，与主形态的 feature 选择不同），不是 cwd 分叉。它属另一条「同活多算」线（连同「generator 与 shadow 各跑一遍同一 fixture」），建议单独立项，不在本批修（规格「未决问题 1」已预告）。
2. **CI 首次冷编译**：rust-cache 把 `.cargo/config.toml` 计入键，路径变更即换键 → 三个 Rust job 各付一次冷编译。预期一次性，由合入后的 run 观察。
3. **`check:acp-shadow` 的 generator 段（本次本地 191s）**：其中含他人 #398 批脏源码的重编，本地数字不代表干净检出；CI 上的对照值以合入后 run 为准。

## 并行交集

- **他人在途**：工作树有 #398 批未提交改动（`src-tauri/pylon-acp/src/{error,lib,negotiated,protocol}.rs`、`src-tauri/pylon-fake-agent/src/main.rs`、`src-tauri/src/{lib.rs,session/control.rs}`、前端 `src/application/**`、`src/components/**`、`src/infrastructure/acp/**`）。本批全程未触碰这些文件，提交一律 `git commit -- <paths>`，提交后 `git show --stat` 核对只含本批文件。
- **共享文件**：`docs/说明书/Pylon-模块维护地图.md` 与 #375/#376/#380 声明域重叠——本批只改「验证」节一句（`git diff --numstat` = 1+/1−）。该 hunk 在提交前被 #398 批的功能提交 `6dd5a6cf`（其标题含「说明书同步」）**连带带入库**，与 #382 批遇到的现象同型；内容正确且在库，故本批 `b5ab171f` 不含该文件。
- **对共享构建目录的影响**：施工期间与对方 clippy 争过 target build lock；为腾磁盘删除了 `target/debug/incremental`（可再生，重编一次即可恢复）。此后本批改用「空 target 探针 + 事后清理」策略，未再向共享 target 堆新产物。
- **未碰**：`.github/workflows/**`、`scripts/**`、`package.json`、任何 Rust 源码、`tools/**` 源码、`src-tauri/target/release`。
