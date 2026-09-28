# Dev Record — #401 `check:acp-shadow` 同活多算收口

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/401-acp-shadow-single-form.md`

## 元信息

- issue：#401（refactor）——https://github.com/AlchemistCxC/Pylon-co-works/issues/401
- 分支：`kumo/prometheus`
- 提交范围：`3b4dff26`（L.md 声明）→ `41ed6056`（脚本 + CI env + 配置注释 + 说明书 + ADR-0032）；本记录随后单独一笔。工作树同时有 #398 批的在途改动（未触碰）
- 日期：2026-09-27
- ADR：`.agents/decisions/0032-acp-shadow-single-form.md`

## 目标与范围

**做什么**：把 #399 诊断中点出的「同活多算」三类一次性收口——① 影子步内统一 cargo 选择口径（背压探针并入 fixture 的同一选择 + 两条探针合并为一次调用）；② 一份 trace 两用（generator 的两轮产出供 parity 复用）；③ dev 调试信息口径单一真源（删 CI 的 `CARGO_PROFILE_DEV_DEBUG`）。

**不做什么**：不动 Rust 源码、golden 基线、夹具场景与 wire 契约；不动 `构建 fake agent` 步与 rust-test / rust-clippy job 的命令；不做跨 job artifact 传递 / sccache / rust-cache 改造；不 pin `CARGO_INCREMENTAL`。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `scripts/generate-acp-golden-trace.mjs` | 新增 `--keep-dirs=<父目录>`（保留两轮运行目录、清理责任交给调用方）；`generateInto` 自报 `elapsedMs`/`testMs`；summary 增 `dirsKept` 与 `runs[]` | 修改 |
| `scripts/check-acp-shadow-parity.mjs` | 主流程改为消费 `generator --check --keep-dirs` 的两轮产出（删 `runFixtureInto` 与自跑 fixture）；`runBackpressureCheck` 合并为一次调用并改用同一选择；守卫改为按测试名自识别结果块；报告字段去掉 `fixtureElapsedMs`、增 `fixtureSource`/`cargoInvocations` | 修改 |
| `.github/workflows/ci.yml` | 删除 workflow 级 `env: CARGO_PROFILE_DEV_DEBUG`，注释改为指向 `.cargo/config.toml`（单一真源 + 成因） | 修改 |
| `.cargo/config.toml` | 补「口径约定（#401）」注释：debug 以本文件为准、`CARGO_INCREMENTAL` 的口径与代价 | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | 「验证」节一句（#401 收口后的影子步形态） | 修改 |
| `.agents/decisions/0032-acp-shadow-single-form.md` | 新 ADR（含备选方案实测读数） | 新增 |
| `.agents/records/401-acp-shadow-single-form.md` | 本记录 | 新增 |
| `.agents/L.md` | 在途声明（单独提交 `3b4dff26`） | 修改 |

## 方案要点

1. **形态统一选 `-p pylon -p pylon-acp`（而非 `--workspace`）**：实测单次调用成本 —— 前者复用主形态的 `prism_desktop_lib-*.exe`、只多编 pylon-acp 的 lib test target（1 crate / 8.7s）；后者 2 crate / 58.7s 且把全 workspace 的 lib test 目标拉进影子步。交替调用 0/0/0/0（各 ~1s）。
2. **一份 trace 两用**：generator 的 `--check` 本就要跑两轮隔离 fixture（A/B 逐字节 + 与已提交基线比），parity 直接消费这两份做 9 字段比对——判据不缩水（确定性、基线漂移、字段比对三者都在），少的只是重复的那两轮执行。
3. **守卫不因合并调用而放水**：改为**按测试名自识别结果块**——定位含探针名的结果块，要求它报告 `tests.length` passed，且每条名字都以 `... ok` 出现。负向实测两条（探针名 / fixture 名）都硬失败。
4. **超时保护随迁**：fixture 的挂死上限从 parity 的单次 600s 改为包住整段 generator 的 900s（两轮 + 冷编译）。
5. **debug 口径单一真源**：实测 `-C debuginfo=1`（CI env）与 `-C debuginfo=line-tables-only`（配置）是**不同 flag 串**、翻转整图重编（9-crate 图 9/9），故删 env 让配置成为唯一真源；`CARGO_INCREMENTAL` 只进本地 unit 指纹（实测翻转 1 unit + 重链 42–67s），CI 由 rust-cache 恒置 0，只文档化不 pin。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 形态切换探针（主形态 ↔ 新探针形态交替） | ✅ **0 / 0 / 0 / 0** 次重编，各 ~1.0–1.3s 墙钟（此前 50 crate / 23.7s 与 1 crate / 40.9s） |
| 实跑 `bun run check:acp-shadow` | ✅ **exit 0**；`ok`/`deterministic` true、8 scenario × 9 字段 parity 全 true；`cargoInvocations: 3`、`generatorElapsedMs: 4081`（含两轮 fixture）、`fixtureTestMs: [380, 370]`、`backpressureElapsedMs: **1385**`（对照此前 51029）、`fixtureSource` 标注复用 |
| 守卫判别力（负向） | ✅ 探针测试名改错 → `passed=1/2 missing=<错名>`、exit 1；fixture 测试名改错 → `generator did not produce initialize.jsonl`、exit 1 |
| 既有行为测试全绿且未被修改 | ✅ `git diff` 不含任何 `*test*` 路径；本批未改任何 Rust 文件 |
| 门禁 | ✅ `cargo fmt --all --check` exit 0；`bun run check:clippy` exit 0（6 crate `added: []`，见证据） |
| 未新增白名单豁免 | ✅ 无 |

## 测试处置

- 新增测试：无（本批改的是门禁脚本自身；验证走实跑 + 形态探针 + 负向注入）。
- 修改/删除既有行为测试：无。

## 证据

- commit：`41ed6056`（代码 + ADR）；本记录单独一笔 `docs(record)`
- 形态交替探针（同一 target，`CARGO_INCREMENTAL=0`，cargo 1.98.1）：
  1 主形态 1338ms / Compiling=0；2 新探针形态 1054ms / 0；3 切回主形态 1089ms / 0；4 再切探针 1082ms / 0
- `bun run check:acp-shadow` 报告（exit 0）：`"ok": true`、`"deterministic": true`、
  `"fixtureSource": "generator --check 的两轮产出（未重跑 fixture）"`、`"cargoInvocations": 3`、
  `"generatorElapsedMs": 4081`、`"fixtureTestMs": [380, 370]`、`"backpressureElapsedMs": 1385`、`parity.*` 全 true
- 负向注入（临时副本跑完即删，未入库）：`/tmp/neg1.log` → `backpressure probe did not observe the expected tests: passed=1/2 missing=engine::tests::spill_overflow_terminates_connection_RENAMED`（exit 1）；
  `/tmp/neg2.log` → `Error: generator did not produce initialize.jsonl`（exit 1）
- 归因实验（形态轴 / env 轴）：9-crate 图上 `debuginfo=1` ↔ `line-tables-only` 翻转 **9/9 整图重编**；
  `CARGO_INCREMENTAL` 翻转在真实 workspace 上 1 unit（`pylon`）+ 重链（42–67s）；探针旧形态 ↔ 主形态 50 / 1 crate
- CI 侧对照（迁移前，run 36319970454 / 36317357926 / 36312288458）：`check:acp-shadow` 一步 784 / 766 / 758s，
  其中 generator 419/367/357s、fixture A 305/294/297s、fixture B 1.2/1.1/1.1s、背压 58/51/52s，测试本体 0.27–0.36s
- 环境注记（**共享树**）：施工期间 G: 盘被写满（剩 2.2MB，链接报 `LLVM ERROR: IO failure on output stream: no space on device`——由陈旧多形态产物的 PDB 堆积所致）。应急处理：删 `src-tauri/target/debug/incremental`（1.2GB）、删陈旧变体的 `prism_desktop_lib-*.{exe,pdb}`（29 份 → 保留最新 2 份；pdb 4.9GB → 142MB）与 `pylon_acp-*.{exe,pdb}`（18 份 → 2 份）；**未动** `target/release`。处理后可再生日用空间 2.2MB → 8.0GB。

## 与 spec 的偏差

1. **首次实跑失败（我自己的守卫 bug）**：守卫最初按 `Running …` 行分段定位结果块，而 cargo 的 `Running` 行走 **stderr**、测试输出走 stdout，导致 `passed=?/2` 误判。已改为按**测试名自识别**结果块（不依赖两条流的顺序）。这次失败反证守卫不会假绿。
2. **未 pin `CARGO_INCREMENTAL`**（spec 已定不 pin）：归因实验表明全局轴是 debug 口径，incremental 只牵动本地 unit；pin 反而让本地 ad-hoc `cargo test` 与门禁互相作废。
3. **spec 未列的 s 第二处 `-p pylon`**：spec 只写了"合并两条探针名"，实施时同时把选择口径对齐为 `-p pylon -p pylon-acp`（这是 50-crate 作废的真正解药，已在 spec 的"方案"里体现）。

## 未解问题

1. **`构建 fake agent`（build）与测试形态之间的相互作废未处理**：CI 该步实测 17s、编译 7 个 crate（zmij/hashbrown/…/serde_json/pylon-fake-agent）——build 与 test 是不同 target kind，其形态自成一类。若仍值 17s/run，另立条目评估。
2. **CI 首次 run 的指纹变化**：③ 会把三个 Rust job 的 dev 调试信息串由 `1` 改为 `line-tables-only`（语义等价、体积更小），各付一次冷编译。
3. **CI 侧表现未实测**：本批的 5.5s 是本地读数；CI 上 `check:acp-shadow` 一步的实际值待合入后 run 观察（预期：generator 两轮共用一份构建 + 背压一次调用，落在一份构建 + 3 次 cargo 启动的量级）。
4. **`--keep-dirs` 失败路径不留证**：失败时 parity 的 `finally` 会清掉两轮 trace（沿用旧行为）。需要现场取证时可手动跑 `node scripts/generate-acp-golden-trace.mjs --check --keep-dirs=<dir>`。

## 并行交集

- **他人在途**：#398 批（`src-tauri/**`、前端 `src/**`）未触碰；本批全程 pathspec 提交。
- **共享文件**：`docs/说明书/Pylon-模块维护地图.md` 与 #375/#376/#380 声明域重叠——只改「验证」节一句（`git diff --numstat` = 1+/1−），提交前核 `git diff` 确认不含他人 hunk。
- **共享构建目录的判断性处置**：见"环境注记"——删除的是**可再生的陈旧变体产物**；若他人正要复用某个被删变体，cargo 会重编（成本换空间）。`target/release` 与 `deps/` 里的 `.rlib`/`.lib` 一律未动。
- **未碰**：`.agents/records/issue-184-*.md`（历史记录不改写，本批在 ADR-0032/记录里承接其决定）、任何 Rust 源码、`package.json`。
