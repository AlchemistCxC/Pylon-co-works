# ADR-0032 门禁步内只允许一种 cargo 形态：`check:acp-shadow` 的单形态选择与一份 trace 两用

- **日期**：2026-09-27
- **状态**：已采用（实施见 #401；ADR-0031「构建输入不依赖 cwd」的同一原则在 cargo **选择口径**上的延伸）

## 背景与约束

cargo 的产物指纹 = f(选择口径、feature 统一结果、环境、cwd 决定的可发现配置)。任一项不同，就是**另一套构建**——
而两套构建若写同一批产物路径（同一 target 目录），会互相作废，来回切一次各付一次整图重编。

`check:acp-shadow` 一步（CI run 36319970454 实测 784s，测试本体 0.36s）残留三类同活多算：

1. **选择口径分裂**：fixture 走 `--lib --features test-agent`（实测**只选主包** pylon），背压探针走 `-p pylon-acp --lib`
   （受限依赖图形、不带 feature）。交替实测：主形态→探针 **50 crate / 23.7s**；探针→主形态 `pylon` **1 crate / 40.9s**
   （重链 ~48MB lib test 二进制）。CI 上 `backpressureElapsedMs` 恒 51–58s 即此。
2. **重复执行**：同一 fixture 一 run 跑 4 遍（generator 的 A/B + parity 再 A/B），共 6 次 cargo 进程。
3. **env 口径双真源**：CI workflow 级 `CARGO_PROFILE_DEV_DEBUG=1` 覆盖 `.cargo/config.toml` 的
   `debug = "line-tables-only"`，两者是**不同的 rustc flag 串**（实测 `-C debuginfo=1` vs `-C debuginfo=line-tables-only`），
   翻转即整图重编（9-crate 图 9/9）。CI 与本地产物因此互相作废，配置里那行在 CI 里是死值。

约束：不改比较字段与判据（9 字段 parity 全 true 的语义）、不动 golden 基线内容、**不降低守卫判别力**
（`--exact` 名失效必须仍失败）、不改 fixture 与运行时行为、不引入跨 job artifact 传递。

## 备选方案

| 方案 | 否决理由 |
| --- | --- |
| 探针并进 `--workspace --lib --features test-agent` 选择 | 实测单次 58.7s / 2 crate，且把全 workspace 的 lib test 目标拉进影子步；`-p pylon -p pylon-acp` 只需多编 pylon-acp 的 lib test target（1 crate / 8.7s）并复用主形态已构建的 pylon 二进制 |
| 保留两套形态、只把两条探针合并为一次调用 | 省一次 cargo 进程，但形态作废（50 / 1 crate）仍在，每 run 必付 |
| parity 自己重跑 fixture（现状） | 同一 fixture 4 遍执行、6 次 cargo 进程；而 generator 的 `--check` 本就要产出隔离的两轮，复用不损失任何判据 |
| 在脚本里 pin `CARGO_INCREMENTAL` | 实测它只进**本地 unit** 的指纹（翻转代价 1 unit + 重链 ~42–67s），pin 在脚本里反而让本地 ad-hoc `cargo test` 与门禁互相作废；改为一句话文档化 |
| 保留 CI 的 `CARGO_PROFILE_DEV_DEBUG=1`、把配置里的值改成 `1` 对齐 | 仍留两处真源（改配置的人看不到 CI 效果）；且 `line-tables-only` 体积更小 |

## 决定

1. 影子步内**只有一种** cargo 形态：`-p pylon -p pylon-acp --lib --features test-agent`；两条背压探针测试名合并进**一次**
   调用（libtest 接受多过滤名）。
2. **一份 trace 两用**：`generate-acp-golden-trace.mjs --check --keep-dirs=<父目录>` 保留两轮运行目录并自报
   `runs[{dir,elapsedMs,testMs}]`；`check-acp-shadow-parity.mjs` 直接消费（cargo 调用 6→3、fixture 执行 4→2）。
   清理责任归 parity；generator 未指定该参数时行为不变（自清）。
3. dev 调试信息以 `.cargo/config.toml` 为**唯一真源**，删除 CI 的 `CARGO_PROFILE_DEV_DEBUG` 注入。

## 后果

- **正面**：本地 `check:acp-shadow` 整套由（#399 后的）~246s 降到 **~5.5s**（generator 4081ms 含两轮 fixture +
  背压 1385ms）；交替形态探针 0/0/0/0（各 ~1s）。选择口径与 cwd/feature 三个轴在影子步内都不再分裂。
- **负面**：generator 与 parity 之间多了一个接口（`--keep-dirs` + summary `runs`），两脚本不可再独立演进；
  探针不再"独立于主形态"，而是共享同一次选择。
- **风险**：删 CI env 会一次性改变三个 Rust job 的构建指纹（各一次冷编译，语义等价——都是行号级调试信息）；
  形态变化使 test 二进制 metadata 变化，同样一次性重编。

## 证据

- 形态交替探针（同一 target，cargo 1.98.1）：0 / 0 / 0 / 0 次重编，各 ~1.0–1.3s（此前 50 / 1 crate、23.7 / 40.9s）
- `bun run check:acp-shadow`：exit 0；`ok/deterministic` true、8×9 字段 parity 全 true；
  `cargoInvocations: 3`、`generatorElapsedMs: 4081`（含两轮）、`backpressureElapsedMs: 1385`（此前 51029）
- 守卫负向：探针测试名改错 → `passed=1/2 missing=<错名>`、exit 1；fixture 测试名改错 →
  `generator did not produce initialize.jsonl`、exit 1
- 代码：`scripts/check-acp-shadow-parity.mjs`（`runBackpressureCheck` 单次调用 + 按测试名自识别结果块的守卫；
  主流程复用 `generator --check --keep-dirs`）、`scripts/generate-acp-golden-trace.mjs`（`--keep-dirs` 与 `runs` 自报）、
  `.github/workflows/ci.yml`（删 workflow 级 env）、`.cargo/config.toml`（口径约定注释）
