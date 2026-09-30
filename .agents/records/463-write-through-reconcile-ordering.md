# Dev Record — #463 user_data 写穿链的并发乱序与跨会话回滚遗留

> 承接 `.agents/spec/463-write-through-reconcile-ordering.md`（spec 不入库，完成后已按惯例可删）。

## 元信息

- issue：#463（#448 审查轮 C-1/C-2 遗留，三项中的前两项；项 3 留决策口）
- 分支：`kumo/prometheus`
- 提交范围：`d817df3b..<head>`（含先行 L.md 声明提交 `0f55c5c7`）
- 日期：2026-09-30

## 目标与范围

**达成**（issue 期望行为前两条）：

1. 前端 C-1：写穿失败的本地新变更在下次启动不再被「后端赢」对账静默删除——custom-presets 与 input-prediction 两 repository 同构修复。
2. 后端 C-1：并发 `set_approval_mode`（GUI 与 CLI 桥同进程）写穿经串行原语，磁盘终值必等于内存终值。

**不做**：

- 项 3（落盘降级外部可查——set 返回持久化标志 / get 附健康位）：wire 契约变更，保持仓库主裁决口，**本 issue 不因此关闭**。
- 记录 448「未修 NIT」四条（sameSlice 键序敏感等）：不属本 issue。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/infrastructure/persistence/customPresetRepository.ts` | 未同步标志（`pylon-custom-presets-unsynced`）+ `saveToBackend` 标志跟踪 + hydrate 对账「本地赢」分支 | 修改 |
| `src/infrastructure/persistence/inputPredictionSettingsRepository.ts` | 影子日志（legacy key 保留不删）+ 未同步标志（`pylon-input-prediction-unsynced`）+ `saveChain` 链式串行 + hydrate「影子赢」分支 | 修改 |
| `src-tauri/src/lib.rs` | `AppState` 增 `approval_mode_write_lock: tokio::sync::Mutex<()>`（声明 + `build_app_state` 构造，各一处） | 修改 |
| `src-tauri/src/permission.rs` | `set_approval_mode` 改锁窗口（内存写+落盘全程持锁）+ 并发回归测试 | 修改 |
| `src/infrastructure/persistence/__tests__/*.tauri.test.ts` | 两文件各增 #463 用例组；inputPrediction 两处契约断言修正 | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | `user_data` 三个 key 的表述同步（影子日志 / 串行锁 / 对账标志） | 修改 |

## 方案要点

1. **标志语义＝「本地存在尚未成功写入后端的较新值」**。save 成功清、失败置；与数据同存 localStorage，存储被清则标志与本地副本同失，后端权威自然接管（user_data 是本机 SQLite，唯一写者即本前端，不存在「后端被第三方写新」）。
2. **custom-presets**：本地副本即 zustand persist 的 `pylon-custom-presets`（进程死亡后仍在），标志置位后对账直接本地赢 + 整份重发。**守卫**：本地空不进本地赢分支（quota 下 persist 失败可能让本地假空）——宁复活不销毁，复活是非破坏性的（再删一次即自愈）。
3. **input-prediction**：Tauri 模式原先无本地副本（迁移成功删旧 key），写穿失败的最新值随进程死亡彻底丢失。改为迁移成功后旧 key **保留转影子日志**，每次保存影子先行（仅影子写成功才参与对账——quota 下拿不出可证较新的值，宁信后端不置标志），后端 save 经 `saveChain` 链式串行（与 customPreset 写穿桥同型——原裸 `void save()` 并发完成序可逆，会让旧值后到覆盖新值并污染标志语义，属同批对齐的审查 C-2 同类面）。
4. **后端串行**：`set_approval_mode` 校验后取 `approval_mode_write_lock`（tokio Mutex 公平），临界区内完成内存写 + `service.save().await`（spawn_blocking 真实 yield 点），锁序即生效序。持锁跨 await 需 `#[allow(clippy::await_holding_invalid_type)]` 带理由注解（与 `config_write_lock` 在 `config_cmds.rs` 的既有先例同型）。
5. 已知残余（如实登记）：quota 连续故障的复合失败仍可能回退后端值（保存时有可见上报，非静默）；「后端宕机期间删空全部预设」的极端序列会复活预设（非破坏性，再删即自愈）。两者量级远低于被修复的单故障静默销毁场景。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 前端 persistence 测试（含新增 10 个 #463 用例） | 57 passed / 0 failed（vitest run src/infrastructure/persistence，exit 0） |
| pylon crate 全量 lib 测试（含新增并发用例） | 970 passed / 0 failed（cargo test --lib，exit 0） |
| clippy 基线（pylon crate，本次改动域） | added: []（check-clippy-baseline exit 0） |
| 前端全量 `bun run test` | 5173 passed / 1 file failed——失败为 `searchService.test.ts` 模块解析 flake，**单独复跑 6/6 绿**（与本次改动域无交集，属并发跑已知 flake 类） |
| lint（改动四文件） | 0 error / 0 warning |
| fmt（改动文件） | permission.rs 经 rustfmt 修正后 0 diff |

**共享树在途说明**：施工期间共享工作树出现另一 agent 的在途改动（#444 批次③ sanitize/export、event_repo，#471 pack_release）。`check:clippy` 全仓口径在其域内有新增诊断（`pylon-foundations/src/sanitize.rs` double_ended_iterator_last、`pylon-session/src/event_repo/tests.rs` unnecessary_to_owned）与 fmt diff——均非本次改动文件；本次按规范以 crate 范围验证自己的域（pylon added: []），对方域留给其收口。

## 测试处置

**新增**：

- `customPresetRepository.tauri.test.ts` #463 组 4 例：标志+本地非空 → 本地赢+重发+清标志；标志+本地空 → 后端赢（宁复活不销毁）；重发失败 → 可见上报+标志保留；桥失败置标志→成功清标志。
- `inputPredictionSettingsRepository.tauri.test.ts` #463 组 5 例：影子赢+重发+清标志；影子缺席 → 后端赢+清标志；影子与后端一致 → 清标志；后端赢时影子对齐权威；影子赢重发失败 → 上报+标志保留。另加 persist quota（影子写不进不置标志）1 例。
- `permission.rs` `set_approval_mode_concurrent_writes_keep_disk_equal_to_memory`：16 轮两任务 `tokio::join!` 交替序并发 set，join 后逐轮断言磁盘终值 == 内存终值（锁下确定性；修复前 spawn_blocking 完成序可逆，对该回归面敏感）。

**修改既有（契约变更，随 PR 说明）**：

- inputPrediction「迁移成功删旧 key」→ 改断言 **保留**（影子日志）。
- inputPrediction「persist Tauri 模式不写 localStorage」→ 改断言 **写影子**。
- customPreset 既有「后端有值且异于本地 → 后端赢」用例不变（beforeEach 清 localStorage ⇒ 标志缺席 ⇒ 行为不变）。

## 证据

- commit：见 PR（L.md 声明 `0f55c5c7`；施工提交随分支推送）。
- 测试：上表（vitest / cargo test / check-clippy-baseline 退出码全 0，flake 项附单独复跑证据）。
- 手工验证：未做实机（webview2-acceptance）——行为由三层单测钉住（对账方向、标志生命周期、并发锁序），与 #448 记录「实机验收留待按需补」同口径。

## 与 spec 的偏差

- spec 未写 `saveChain`：施工中发现 input-prediction 裸 `void save()` 的完成序可逆会污染标志语义（旧值后到清标志）且属 448 审查 C-2 已在 customPreset 修掉的同类面，按既有先例补链式串行并更新模块 docstring（原「盲写 latest-wins」表述与事实不符，顺手更正）。
- 其余按 spec 落地。

## 未解问题

1. **项 3（degraded 外部可查）留仓库主**：`pylon approval set` 成功但落盘失败时调用方不可探测（wire 契约变更：set 返回持久化标志 / get 附健康位，CLI 消费方需同步）。本 issue 不关闭，作决策口。
2. quota 长期故障下的复合失败残余（见方案要点 5），如需进一步收口需先有可观测面（依赖项 3 裁决）。
3. 实机验收（后端宕机→本地新预设→重启不丢的端到端真机时序）未走查，与 #448 记录同口径留按需补。

## 并行交集

本次碰过的共享文件：`src/infrastructure/persistence/{customPresetRepository,inputPredictionSettingsRepository}.ts` 及两 `__tests__/*.tauri.test.ts`、`src-tauri/src/permission.rs`、`src-tauri/src/lib.rs`（AppState 两处小 hunk）、`docs/说明书/Pylon-项目架构参考.md`（user_data 一条）。**未碰**：`pylon-session/**`、`event_repo/**`、sanitize/export 域、pack_release 链。施工期间观测到 #444/#471 在途改动并存，已按 pathspec 隔离提交。
