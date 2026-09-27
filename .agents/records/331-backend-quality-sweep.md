# Dev Record — #331 后端质量清偿（死数据/失效注释/参数样板/逐帧热路径）

> 入库保留。规格文档（spec，`.agents/spec/331-backend-quality-sweep.md`，gitignore）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：[#331](https://github.com/AlchemistCxC/Pylon-co-works/issues/331)（refactor，assignee AlchemistCxC）
- 分支：`kumo/prometheus`（施工）→ `kumo/issue-331-backend-sweep`（自 `github/main` 切出，cherry-pick 本批提交后开 PR——分支上同时承载 #324 已提交工作，为不卷入他人在途 issue 而单开）
- 提交范围：见「证据」commit 列表
- 日期：2026-09-25
- 施工声明：`.agents/L.md` b23d00de（合入后移除）

## 目标与范围

按 #331 验收判据逐项清偿后端质量债。**未决问题取最小路径**（验收判据已钉死的方向）：

- **U1 = (a)**：`create.rs` 四处仅补行内摘除条件，不引入参数结构体。
- **U2 = (a)**：`dispatcher/` 三个 >370 行函数继续延后，M2 只动 `run_setup_pipeline`。
- **U3 不裁决则最小执行**：D1 只做「注释与事实一致 + 删同义反复断言」，符号保留；契约双写收口方向（Rust 生成 TS 还是反转单源）留待仓库主裁决，已在注释中标注。
- **U4 = P4 例外执行**：P4 在验收判据内且改动为「派生 Eq 值比较取代序列化字符串比较」（语义恒等、grep 可判），无基准直接执行；P2/P3/P5 属收益需基准证明的优化项，**本批未做**，留待 U4 裁决。
- **U5 = 删符号 + 改注释 + 成文**：`is_empty` 两处删除；`route.rs` 两处 allow 注释改为「契约冻结、仅测试消费、BE-02 接线后摘除」；M3 以 dev-standards 成文（主形态 + 两类例外）而非 200+ 处清扫。
- **U6 = (a)**：C1（`send_message` 失真注释）落在 #324 文件域 `session/prompt.rs`，**本批未做**——#324 已提交内核部分（09242c7d）但 issue 仍 OPEN 且文件仍有未提交改动，按 AGENTS.md §2.1 绕行，待 #324 合入后单独完成（验收判据 C1 相应顺延，见 issue 评论）。

**不做什么**：不动 wire 格式/命令名/错误码/持久化格式；不动既有受控预留 `#[allow(dead_code)]`；不动 `classify_session_update`（#316 已裁定）；不做 P6。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-session/src/retention.rs` | `DEFAULT_*` 两常量、`default_policy`、`parse` 的 allow 注释改写为与事实一致（含 U3 摘除条件）；测试中删两条同义反复断言 | 修改 |
| `src-tauri/src/browser/agent/audit.rs` | 删除零调用 `AuditBuffer::is_empty` | 删除 |
| `src-tauri/src/browser/agent/refs.rs` | 删除零调用 `RefRegistry::is_empty` | 删除 |
| `src-tauri/src/gateway/route.rs` | `RouteResolveStatus`/`resolve_route_status` 两处 allow 注释改写（点名不存在的消费者 → 契约冻结摘除条件） | 修改 |
| `src-tauri/pylon-acp/src/state.rs` | 删除 `AcpSessionState.messages` 字段及 `apply` 尾部的写入块（P1） | 删除 |
| `src-tauri/src/dispatcher/canonical_flush.rs` | `should_flush_batch` 身份比较由 `owner.key()` 字符串改为 `DurableSessionOwner` 值比较（P4） | 修改 |
| `src-tauri/src/session/create.rs` | 四个超参函数补 `#[allow(clippy::too_many_arguments, reason = …)]` 行内摘除条件（M1） | 修改 |
| `src-tauri/src/lib.rs` | `run_setup_pipeline` 564 行拆为 22 行编排体 + 18 个 `setup_*` 阶段函数，失败策略逐行标注（M2） | 重构 |
| `.agents/dev-standards.md` | 新增「Rust 锁中毒处理」成文约定（M3） | 新增章节 |
| `artifacts/clippy-baseline.json` | 移除指向已不存在 `runtime_log.rs` 的 2 条、已消失的 `pylon-core needless_return` 1 条、被 M1 allow 抑制的 create.rs 4 条（G1） | 修改 |

## 方案要点

- **P1 安全性**：`AcpSessionState.messages` 全仓引用仅字段声明与写入点（`grep` 计数 2）；`SessionInfo` 无 `Serialize`，持久化快照（`dispatcher/mod.rs` session_state_to_persist）仅由 `commands_snapshot`/`usage_snapshot`/`mode` 构造，与该字段无关——删除不影响 IPC/落盘形态。`AcpStateDelta::Text/Reasoning/UserText` 变体保留（`apply` 返回值契约被 pylon-acp 与 dispatcher 内联测试钉住；dispatcher 消费点本就显式忽略三者）。
- **P4 语义等价**：`DurableSessionOwner` 已 derive `PartialEq`（`owner.rs:6`），`key()` 为三字段 JSON 串（对结构体值单射）；「合法 owner 对相等 ⇔ key 相等」在两版实现下同真。对非法 owner（validate 失败）的退化行为差异仅出现在「两个不同非法 owner 相遇」的不可达角落，且方向为更保守（多 flush）。`:172` 的批次同质性 owner_mismatch 检查原样保留。
- **M2 编排不变式**：阶段拆分逐一对应原顺序段落，语句次序、锁序、`startup_timing` 打位点、错误消息文本全部逐字保留；两处取 `AppStateHandles` 的时点由「共享同一实例」改为各自 `from_state`（纯 Arc 克隆，无可观测差异）。
- **G1 棘轮变紧**：基线只减不增，重建后六 crate `added` 全为 0。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| C1 | **顺延**（U6(a)：#324 在途文件域），其余验收不受影响；已在 issue 评论声明 |
| G1 | ✅ baseline 无 `runtime_log.rs` 条目、无 pylon-core `needless_return`；六 crate `added` 均为 0（见证据） |
| P1 | ✅ `AcpSessionState` 无 `messages` 字段；全仓引用计数 0（`grep -rn "\.messages" src-tauri --include=*.rs` 仅 pet-core 无关同名词） |
| D1 | ✅ 三处符号注释与事实一致（含 U3 摘除条件）；两条同义反复断言已删 |
| D2 | ✅ `is_empty` ×2 已删；route.rs 两处注释改写为摘除条件形态 |
| M1 | ✅ create.rs 四处具备与 `engine.rs:819` 同形态的 `#[allow(…, reason = …)]` |
| P4 | ✅ `should_flush_batch` 路径无 `serde_json::to_string` 身份比较 |
| M3 | ✅ dev-standards 成文（主形态 `lock().unwrap()` + 错误边界 `map_err` 例外 + 中毒免疫值 `into_inner` 例外） |
| M2 | ✅ `run_setup_pipeline` 函数体 23 行（≤150），18 阶段失败策略逐行标注于编排处首屏 |
| 门禁 | ✅ 全绿（见证据）；测试修改严格限于测试处置点名的 retention.rs 两处 |

## 测试处置

偏离 refactor 模板「既有行为测试全绿且未被修改」判据，逐条点名（与 issue「测试处置」一致）：

1. `retention.rs time_tiers_match_contract`——删除 `assert_eq!(DEFAULT_TIME_DAYS, 30)`（常量等于自己字面量，永不可能失败）；保留 `TIME_DAYS_TIERS` 档位契约校验。
2. `retention.rs count_tiers_match_contract`——同上删除 `assert_eq!(DEFAULT_COUNT_LIMIT, 1000)`。

未改动其他任何行为测试；未删 `parse`/`default_policy` 的测试（U3 未裁决，符号保留故测试保留）。`state.rs` 内联测试本无对 `messages` 的直接断言（测试断的是 `apply` 返回值），无需修改——这同时构成「Text/Reasoning/UserText 仍被正确返回给消费方」的新证据（spec 测试处置要求的唯一新证据点）。

## 证据

- commit：阶段一（D1/D2）、阶段二（P1）、阶段三（P4）、M1、M2、M3、G1、开发记录——逐项 hash 见 PR。
- 测试：`cargo test --workspace --lib` 退出码 0——pylon 829 passed / pylon-acp 152+9+36 / pylon-core 118 / pylon-foundations 84 / pet-core 22 / pylon-session 151，0 failed。
- fmt：`cargo fmt --all --check` 本批文件 0 差异（lib.rs 已单文件 rustfmt）；残余差异全部位于 #324 在途文件（`pylon-fake-agent.rs`、`session/prompt.rs`、`tests/prompt_cancel/mod.rs`，git status 可证非本批所改）。
- clippy：`cargo clippy --workspace --all-targets` 后六 crate `added` 均为 0；基线 `removed` 恰为预期 6 条指纹（pylon 5：runtime_log.rs ×2 + create.rs ×3，后者系 M1 `#[allow]` 抑制；pylon-core 1：needless_return），重建后基线仅剩 1 条活诊断（`routing.rs` large_enum_variant）。
- `bun run check:acp-shadow`：绿（触及 pylon-acp/dispatcher，按 spec 门禁要求执行）。
- `run_setup_pipeline` 行数：`awk` 计数函数体 22 行。

## 与 spec 的偏差

- **C1 未执行**（spec 列于阶段一）：U6(a) 生效——#324 已提交部分落在本批施工期间，`session/prompt.rs` 仍有未提交改动，按共享工作树纪律绕行。顺延已与 issue 验收判据的差异一并回写 issue 评论。
- **P2/P3/P5 未执行**：U4 未裁决；spec 阶段三本身标注「需先补基准」。P4 因在验收判据内且属语义恒等替换而例外执行。
- **U3 最小执行**：spec 阶段二第 2 步「评估匹配块删除」落地为：仅删 `messages` 写入块，delta 变体与其返回路径保留（测试钉住的契约）；dispatcher 侧 `json!` 喂食深拷贝（P2 第一处）因仍承担 tools/usage/plan/mode/model 的活状态维护而**不能**随之删除，归入 P2 待 U4。

## 未解问题

- U1–U6 的最终裁决权在仓库主；本批按上列最小路径执行，改判时不冲突（结构体收口、单源化、dispatcher 拆分、基准补齐均可在此基线上另立批次）。
- C1 待 #324 合入后补做（一处注释改写，`prompt.rs:349-353` 邻域）。

## 裁决与后续（2026-09-25 用户裁决落地，本记录随批更新）

四项裁决经 AskUserQuestion 取得，全部当批落地：

| 裁决 | 结论 | 落地 |
| --- | --- | --- |
| U3 契约单源 | **(a) Rust 生成 TS + 门禁** | `scripts/generate-retention-policy.mjs`（`--check` 双模式，锚点失效即报错）→ 生成 `historyRetentionPolicy.contract.ts`；手写文件只引入再导出；`check:retention-policy` 挂入 `check:frontend`/`check:frontend:static` 链（CI 静态门禁自动覆盖）；retention.rs 注释更新为单源定义 |
| U4 逐帧基准 | **(a) 先补基准再改 P2–P5** | `dispatcher/frame_path_bench.rs`（cfg(test) 四测试 + 跨 owner 拒绝自检，对齐 storage_write_bench 方法论：断言功能不变量、不钉墙钟）。基线读数：逐帧总入口 7,096 ns/帧、reducer 单独 1,348 ns/帧（P2 深拷贝占比 ~5.7× 的量化证据）、`should_flush_batch` 2,296 ns/帧、rawOutput 累积 12,659→17,061 ns/帧（P5 O(K²) 实证）。P2/P3/P5 解禁登记为 #334 |
| G1 相邻发现① | **修脚本解析** | `check-clippy-baseline.mjs` 补无版本 path 依赖（`pylon-core#1.0.0`）的包名解析（取 `#` 前路径尾段）。验证：旧 JSON + 新脚本 = pylon-core 诊断可见（修复前不可见） |
| G1 相邻发现② | **修 lint 代码** | `agent_detection.rs` `impl Drop for ManagedProbeChild` 重构：cfg 提到整条语句、消除早退 `return`（Windows 编译下其后无语句才触发该 lint）。验证：pylon-core 单独 clippy 零诊断；基线 `added` 全 0 |
| U1/U2 后续 | **U1b + U2b 都列入批次** | 登记后续 issue：#335（U1b 参数结构体收口，含 canonical_flush 四调用点去重）、#336（U2b 拆 `start_notification_dispatcher`）；dispatcher 大函数其余两个继续延后 |

说明书同步：`Pylon-模块维护地图.md` 新增「保留策略契约单源」行（canonical 行同形态）。

U3 无需 ADR：裁决结论是**确认** dev-standards 既有单源方向对新契约的适用，未改变依赖方向（ADR 登记标准看「改变依赖方向/数据所有权/持久化契约」——本裁决两者皆未改变）。

## 并行交集

- 施工期共享工作树存在 #324 在途改动（`session/prompt.rs`、`pylon-fake-agent.rs`、`test_harness.rs`、`tests/integration.rs`、`tests/prompt_cancel/`、`src/domains/workbench/**` 等），本批全程 pathspec 提交、未触碰。
- `.agents/L.md`、`.agents/dev-standards.md` 为共享文件；本批对后者为纯追加章节。
