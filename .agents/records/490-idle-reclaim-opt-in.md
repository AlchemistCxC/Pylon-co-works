# Dev Record — #490 后台回收默认关闭——24h 论据被 #379 推翻，回收改为显式 opt-in

## 元信息

- issue：#490（enhancement；维护者裁决 2026-10-01：默认值改 0）
- 分支：`kumo/490-idle-reclaim-opt-in`（独立 worktree `C:/Project/prism-team-workdir/pylon-490`——G: 盘满余 237MB，且共享树 `session_expiry_platform_tests.rs` 属 #488-② 在途域）
- 提交范围：`ea82ac88..81aecc68`（基准 `ea82ac88` = github/main；`fe912f5a` 主体 + `81aecc68` 记录补引用）
- 日期：2026-10-01

## 目标与范围

**做什么**：`PYLON_SESSION_IDLE_TIMEOUT_SECS` 缺省值从 24 小时（1440×60 秒）改为 `0`（关闭后台回收），回收变显式 opt-in；`expiry.rs` 头注按 issue 指定口径重写（删除「GUI 无断线重连」论据，改为「默认关闭——懒重连 #379 使自动回收失去必要性；开启属资源受限场景的显式选择」）；默认值测试与 `docs/说明书` 表述同步。

**不做什么**：回收链路本体不动（活跃信号豁免 / 零会话连接回收 / `platform_may_route_to` 守卫——issue：「链路保留，只是默认不再触发」）；手动停止 / `lifecycle::stop_agent_runtime` 路径不动；平台来源（gateway binding）的 `idle_minutes` 缺省 1440 **不动**——那是 binding 自身的显式配置契约（agents.yaml），不在本 issue 点名的 env 默认值范围（已作为边界在 issue 评论区明示，留维护者裁断）；`vendor/acp/ORIGIN.md` 历史出处登记不动。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/session/expiry.rs` | 模块头注（#490 段替换「两条路径的自愈能力不同」段）、`GUI_IDLE_TIMEOUT_ENV` / `DEFAULT_GUI_IDLE_TIMEOUT_SECS` 文档、常量值 `1440*60`→`0`、`reclaim_idle_connection` 保守边界注释、`platform_may_route_to` 文档 | 修改 |
| `src-tauri/src/session/session_expiry_platform_tests.rs` | `gui_idle_timeout_parsing` 断言翻转（缺省→`None`、非法值→`None`），显式值断言保留并补消息 | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | Native session 行：`（默认 24 小时，0 关闭）`→`（#490 起默认 0 关闭——#379 懒重连使自动回收失去必要性，设正秒数为资源受限场景的显式 opt-in）` | 修改 |
| `.agents/records/490-idle-reclaim-opt-in.md` | 本记录 | 新增 |

## 方案要点

1. **只动默认值常量**：`gui_idle_timeout_from` 的解析结构不变，`DEFAULT_GUI_IDLE_TIMEOUT_SECS = 0` 使缺省与非法值回退都落在「关闭」（`(seconds > 0).then(...)` → `None`）⇒ `check_session_expiry_with(state, None)` ⇒ GUI 会话循环 `continue`、`reclaim_idle_connection` 早退。watcher 周期照常空转，无额外开销。
2. **非法值 fail-safe 方向**：opt-in 只认合法正数——笔误（如 `360O`）落「关闭」，代价是资源常驻而非误杀进程。
3. **陈旧注释清理（§6.2）**：头注「连接回收不会自愈」与 `platform_may_route_to` 文档的「平台 ingest 对非 Connected 实例直接拒绝且无 fallback」已分别被 #379（`ensure_connected_for_send`，`session/mod.rs`）与 B10.3（平台侧 `ensure_runtime_ready`，lib.rs ingest handler 懒启动）推翻；guard 本身保留（回收有秒级重建延迟 + `SessionContinuity::Invalidated` 代际失效，对平台可能路由的 agent 做无谓拆除没有收益）。`route.rs` 的 `IngestReject::InstanceNotConnected` 只针对**适配器实例**绑定路径，与 agent runtime 的 Disconnected 是两个状态域——原注释把两者混为一谈。
4. **取代关系**：本记录取代 `.agents/records/363-acp-subprocess-lifecycle.md`「为什么默认 1440 分钟」一节（issue 验收建议「关联记录：#110 / #363-4 的回收测试口径随默认值调整」由本条 + 测试翻转承接；#363 记录原文保留作历史）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 缺省 = 0 = 关闭；显式设值仍生效 | ✅ `gui_idle_timeout_parsing`：`None`→`None`、`"0"`→`None`、`"300"`→`Some(300s)`、`"  60  "`→`Some(60s)`、`"不是数字"`→`None` |
| 既有回收测试口径随默认值调整 | ✅ 平台路径用例不受影响（走 binding，不吃 env）；workspace lib 全绿（下表） |
| `docs/说明书/` 表述同步 | ✅ 维护地图 Native session 行已更新（全仓 grep 无残留「默认 24 小时」活性表述，历史叙述除外） |
| 手动停止 / 生命周期释放路径不变 | ✅ 零改动（`lifecycle/**` 未触碰） |

## 测试处置

修改既有行为测试 1 个：`session_expiry_platform_tests.rs` `gui_idle_timeout_parsing`——缺省与非法值两断言由「回退 24h」翻转为「关闭」，显式值三断言保留。无新增/删除测试。

## 证据

- commit：见分支 `kumo/490-idle-reclaim-opt-in`（`ea82ac88` 基线上单提交）
- 测试：`cargo test --workspace --lib`（worktree 冷编译，`CARGO_INCREMENTAL=0`）→ **exit 0，9 目标合计 1662 passed / 0 failed / 4 ignored**（pylon 964 / pylon-acp 186 / fake-agent 9 / pylon-session 216 / 其余 187+92+36+22）；`cargo fmt --all --check` → exit 0；`node scripts/check-clippy.mjs` → 基线外零新增（见提交信息附注）
- 环境前置（与被测面无关）：worktree 复制共享树既有 `dist/`（`tauri::generate_context!` 编译期要求 `../dist` 存在，CI 同款前置）+ `cargo build -p pylon-fake-agent --features test-agent`（`--lib` 不构建 bin-only crate，test_utils 需要它）

## 与 spec 的偏差

- spec「未决问题」预写的「平台 binding `idle_minutes` 是否翻转」按预案保持不动并已在 issue/PR 评论区明示——无实施偏差。
- spec 未预写、实施中新增：① 同文件另外三处陈旧注释修正（§6.2 授权，见改动清单）；② 验证期发现预存竞态测试并登记 **#504**；③ 审查子 agent（双轴）三条判断题的处置——头注「两条路径都先重建连接」措辞修正为区分两路自愈（会话路 = revive、连接路 = 懒重连）、本节与元信息「提交范围」的模板补齐、以及「B10.3 不可 grep」误报的驳回（`lib.rs:1262`、`session/mod.rs:480` 等十几处在案）。

## 未解问题

1. **预存竞态测试（非本批引入，已登记 #504）**：`dispatcher::reactions::tests::prompt_path_sink_methods_match_direct_pet_calls` 在高负载下会挂——两个 `PetState` 构造点相隔微秒，而 `PetState::default` 打真实墙钟（`pet-core/src/lib.rs:619` `last_tick_at_ms: now_ms`），毫秒跳变即拆散「Debug 快照全等」断言（实测失败输出两边**仅差 1ms 时间戳**，其余字段全同；本轮空载重跑即绿）。 characterization 断言应先归零两个时间戳字段再比较。与 #490 无接触面，未顺手修。
2. **平台 binding `idle_minutes` 缺省 1440 是否随 #490 翻转**：本批按「不动」处置（见范围），留维护者裁断。

## 并行交集

共享树（`G:/…/prism-desktop`）内本批只动过 `.agents/L.md`（已随 `30eea9e1` 提交）；代码改动全部在独立 worktree 分支上，与 #487/#488（`kumo/487-488-legacy-sunset-hygiene2`）、#484/#485/#486 各在途域无文件交集。`session_expiry_platform_tests.rs` 若与 #488-② 合并：其 hunk 在 import 行与 prompt_gate 测试段，本批 hunk 在 `gui_idle_timeout_parsing`，不同区域可自动合并。
