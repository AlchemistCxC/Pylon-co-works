# Dev Record — #184 CI 提速与质量收口

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#184（refactor）
- 分支：`Ru5t/Reflector`
- 提交范围：`349fb092..<head>`
- 日期：2026-09-19

## 目标与范围

基于 100 次 CI run 的实测调查，落地 8 项速度/质量改进：Rust job 拆四个并行 job、shadow fixture 指纹对齐、缓存清理制度、fmt 前置、覆盖率迁 main、dependabot bun、timeout 收口、debug 产物收敛 + CI 侧 `CARGO_PROFILE_DEV_DEBUG=1`。**不做**：sccache（待新基线再议）、跨 job target artifact 传递、stub dist、测试内容与门禁脚本逻辑变更。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | 全文重构：单 rust job → rust-test / rust-clippy / rust-shadow 三并行 job；新增 workflow 级 `CARGO_PROFILE_DEV_DEBUG=1`；各 job timeout-minutes；fmt 前置（cache restore 之前）；Defender 排除步骤；覆盖率步骤 main-only；debug 产物 main-only；clippy 证据包随迁 clippy job | 修改 |
| `.github/workflows/cache-cleanup.yml` | 新增：每日定时（03:23 UTC）+ 手动；删非 main ref 且 2 天未访问、及 14 天未访问的缓存；报告余量 | 新增 |
| `.github/dependabot.yml` | npm ecosystem → bun（含历史说明与 #184 依据注释） | 修改 |
| `package.json` | `check:frontend` 链中 `test:coverage` → `test`（覆盖率拆到 CI main 专用步骤；`test:coverage` 脚本本体保留） | 修改 |
| `scripts/check-acp-shadow-parity.mjs` | `runFixtureInto` 与 `runBackpressureCheck` 的 cargo test 参数加 `--features test-agent`（对齐 rust-test job 指纹） | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | 「验证」节 CI 结构表述同步（四 job、覆盖率位置、shadow 指纹统一） | 修改 |

## 方案要点

1. **拆分依据**：Rust job 的 9.5 min 测试步骤中测试真实执行仅 ~35s（1098 lib tests 17.6s + 集成套件秒级），耗时是编译；clippy（check 模式）与测试构建指纹互不共享，串行等于两次全量编译排队。三 job 并行后关键路径 = 最慢的 rust-test（~12-14 min）。
2. **shadow 9.2 min 分解**（run #35431357987 实测 JSON）：generator 135s + fixture A 330s + fixture B 83s + backpressure 1.5s，而 fixtureTestMs 仅 [200, 180] ms——耗时全是 cargo 进程开销与 feature 错配重编。fixture A（330s）与 B（83s）同命令差 4 倍即「A 重编、B 复用」的直接证据。对齐 `--features test-agent` 后与 rust-test job 的 lib test 构建共享指纹，跨 run 缓存命中。
3. **Defender 排除**：Windows runner 实时扫描对 target 指纹校验征重税（脚本注释自证：本机测试 0.22s、进程 128s）。对 ephemeral runner 排除 `src-tauri/target` 与 `~/.cargo`，是 rust-cache 生态的常规提速手段。
4. **缓存制度**：分支作用域使 rust-cache 每分支一份副本，10GB 配额被吃到 9.79GB 互相驱逐 → 冷编译长尾（p50 23 min / max 29 min）。清理策略保留活跃 PR（2 天未访问才删）与 main 热缓存（14 天门限，rustc 周更使旧 key 永不命中）。
5. **覆盖率迁 main**：PR 反馈环省 ~3 min（4:54 → 裸 vitest ~2:30），阈值门禁仍在 main push 闭环——低于阈值的 PR 合入后 main 必红。**已获用户明示批准**。
6. **`CARGO_PROFILE_DEV_DEBUG=1`（line-tables-only）**：全量 PDB 生成是 Windows MSVC 链接大头；证据链只需行号回溯。env 注入不改 Cargo.toml，本地开发不受影响；首次合入因指纹变化一次性重编。
7. **dependabot bun**：npm 模式只改 package.json 不动 bun.lock，每个 npm 升级 PR 必死于 `bun install --frozen-lockfile`（100 run 内 10 次）。bun ecosystem（2025-02 GA）同步冻结 bun.lock。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 脚本语法 / YAML 校验 | `node --check` 通过；三个 YAML python-yaml 解析通过 |
| 本地 `bun run check:acp-shadow` | 通过（对齐 feature 后 parity 与确定性结论不变，见证据） |
| 四 job 真实 PR run 全绿 | 待本 PR 的 CI run 证明（PR 开后观察） |
| 关键路径 ≤ 15 min | 待 PR run 数据 |
| shadow job ≤ 6 min | 待 PR run 数据 |
| 缓存总量回落 | 待 cache-cleanup 首次 dispatch |

## 测试处置

无测试修改/删除。`check-acp-shadow-parity.mjs` 仅改 cargo 参数与注释，比较逻辑未动。

## 证据

- commit：见提交记录
- 本地验证：`node --check scripts/check-acp-shadow-parity.mjs`（exit 0）；`bun run check:acp-shadow`（结果回填 PR/issue 评论）
- CI 基线数据：run #35431357987 步骤耗时与 shadow JSON 字段（generatorElapsedMs 134884 / fixtureElapsedMs [330572, 83352] / fixtureTestMs [200, 180] / backpressureElapsedMs 1482）

## 与 spec 的偏差

1. spec 预想给 shadow 脚本「补 testMs 输出」——核查发现脚本早已输出 generator/fixture/backpressure 耗时字段，无需新增；本项缩减为纯指纹对齐。
2. spec 未列 Defender 排除——调查收尾阶段从「fixture A/B 同命令差 4 倍 + 测试本体 0.2s vs 进程 80-135s」证据链追加，属用户「增加编译速度」授权范围。
3. generator（`generate-acp-golden-trace.mjs`）的 cargo 调用**未**对齐 feature：其 `--check` 模式对比的是已提交基线（无 feature 时代生成），若基线随 feature 漂移会引入假红；保守保留原指纹，它也跨 run 缓存命中。

## 未解问题

- `CARGO_PROFILE_DEV_DEBUG=1` 对失败回溯信息的实际影响（line-tables 保留行号，理论无碍）——首次真实失败 run 时留意证据包可读性。
- dependabot bun 对本仓 workspace 布局的实际行为——首个 bun 升级 PR 验证。
- sccache 是否仍有必要——四 job + 指纹对齐 + 缓存清理落地后看 2-3 周基线再议。

## 并行交集

本次碰过的共享文件：`package.json`（scripts 字段，无依赖变化）、`.agents/records/`（新增本记录）。Huygens 的 #110 文件域（前端/后端源码）与本次无交集。
