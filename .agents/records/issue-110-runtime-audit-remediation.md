# Dev Record — #110 运行时体检 5+3 项处置（F1–F8）

> 入库保留。规格文档 `.agents/spec/issue-110-runtime-audit-remediation.md` 不保留，
> 其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：[#110](https://github.com/AlchemistCxC/Pylon-co-works/issues/110)（bug；含并入的 #56）
- 分支：`Ru5t/Reflector`
- 提交范围：`bb778095..<head>`
- 日期：2026-09-17
- 基准：施工开始前工作树与 `github/main` 逐字节相同（`git diff --quiet github/main HEAD` 通过）

## 目标与范围

把 #110 的 8 项（F1–F8）逐项闭环，每项有可判定的数据层验收证据。

**不做什么**（2026-09-17 用户裁决的边界）：

- **中控区一律不改**：`src/renderers/solid-workbench/input/**`（底部输入区、状态条及其模型 /
  推理 / 权限胶囊）零改动。F4/F5 的 UI 侧验收（chip 显示是否正确、状态条是否出现
  `unconfigured-model` 字样）移出本 issue。
- 不改部署实例 `F:\A-I\Platform\Pylon` 的配置与数据（只读取证）。
- 不重写 `canonical_events` 历史行（append-only 契约，见 F7）。
- 不动 `tools/webview2-mcp/src/**`（Brahe 的文件域，见「并行交集」）。

## 改动清单

| 文件 | 范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/acp/negotiated.rs` | 模块 doc、`CapabilityKind` 新增 `BooleanOrObject`、`CAPABILITY_MATRIX` 的 `list`/`close` 条目、新增矩阵测试 | 修改 |
| `src/infrastructure/acp/agentContracts.ts` | raw 兜底投影 `list`/`close` 改双形状 | 修改 |
| `src/infrastructure/acp/__tests__/agentContracts.test.ts` | F2 双形状用例（object 可用 / 非法值仍 fail-closed） | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchLifecycle.ts` | 就绪等待 + 单次退避重试（新增两个导出常量与三个私有成员） | 修改 |
| `src/sheets/agent-workbench/__tests__/agentWorkbenchLifecycle.recoveryRace.test.ts` | F1 六条竞态/重试用例 | 新增 |
| `src/infrastructure/acp/sessionClient.ts` | `ColdMountTurnSnapshot` 类型 + `normalizeColdMountTurnSnapshot` + 归一化器透传 | 修改 |
| `src/infrastructure/acp/__tests__/sessionClientColdMountTurn.test.ts` | F4 透传契约用例 | 新增 |
| `src/domains/workbench/session/sessionSurface.ts` | 新增 `resolveContextUsage`（上下文用量单一派生源） | 修改 |
| `src/domains/workbench/__tests__/sessionSurfaceProjection.test.ts` | F4 同源派生用例 | 修改 |
| `src/domains/workbench/normalizers/acpNormalizer.ts` | `session_info_update` 增 `session.model-updated` 事实 + `sessionModelOf` 提取器 | 修改 |
| `src/domains/workbench/normalizers/__tests__/acpNormalizer.test.ts` | F5 三条事件产出用例 | 修改 |
| `src/renderers/solid-workbench/chat/content/SessionSurfaceCard.solid.tsx` | 上下文行改走 `resolveContextUsage`（同一组数，无视觉变化） | 修改 |
| `src-tauri/src/session/create.rs` | `resolve_established_model`（纯函数）+ `ingest_established_model_event` + `create_session_slot` 挂钩 + 优先级测试 | 修改 |
| `src-tauri/src/session/event_repo.rs` | `session_info_update` 落 `typed_payload.model`；`unknown` 归因打点；三条回归测试 | 修改 |
| `src-tauri/tests/issue110_establishment/mod.rs` | F5 建立期 journal 端到端用例 | 新增 |
| `src-tauri/tests/integration.rs` | 注册新测试模块 | 修改 |
| `src-tauri/src/session/msg_repo/mod.rs` | 删除联动清扫事件；`TOMBSTONE_EVENT_GRACE_DAYS`、`TombstonePurgeOutcome`、`purge_tombstoned_events`、`checkpoint_wal`、`run_journal_maintenance` | 修改 |
| `src-tauri/src/session/del03_local_first_delete.rs` | 删除契约测试更新 + 三条 F3 新用例 + `checkpoint_wal` 幂等用例 | 修改 |
| `src-tauri/src/session/del01_schema_audit.rs` | 基线测试的 canonical_events 断言按 F3 新契约更新 | 修改 |
| `src-tauri/src/lib.rs` | setup 增事件库维护 watcher（每 10 分钟 + 启动即跑） | 修改 |
| `src/components/chat/messagePersistence.ts` | `MESSAGE_STORAGE_KEY_PREFIX`、`pruneOrphanMessageSnapshots`、`settleInterruptedSnapshot`；browser repository `load` 接中断归一 | 修改 |
| `src/components/chat/__tests__/messageRepository.test.ts` | F6 七条 GC / 中断归一用例 | 修改 |
| `src/app/bootstrap/hydrateIdentityAndWorkspace.ts` | sessions 水合后回收孤儿消息快照 | 修改 |
| `tools/webview2-mcp/README.md` | 环境变量章节按实机复核重写 + 故障排查表两行 + 开头一句 | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | §8 冷挂载 turn 透传表述；§7 存储域 `deleted_sessions`/`retention_policy` 条目 | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | Native ACP / Native session 两行补 F2/F3/F5 事实 | 修改 |
| `.agents/L.md` | 文件域登记 + 对 Brahe 的报备 | 修改 |

## 方案要点

### F2 capability `list`/`close` 被 fail-closed 误杀

`CAPABILITY_MATRIX` 里 `resume`/`fork`/`load` 是 `Object`，`list`/`close` 却是 `Boolean`——
同一种线上形状两种裁决。新增 `CapabilityKind::BooleanOrObject`（object 或显式 `true` 皆算广告，
`false`/`1`/字符串/`null` 仍 fail-closed），`list`/`close` 改用它，诊断文案改为实际接受集
「object 或 boolean true」。

选双形状而非「改 Object」的理由：ADR-0004 决定 3 已经写了 sessionClose「显式 `true`/object
才为可用」，实现只收 Boolean 属实现落后于决策；同时线上仍有显式 `true` 的旧广告，单收 object
会造成回归。TS 侧 raw 兜底投影（`agentContracts.ts`）同步为同一语义，避免两份矩阵漂移。

### F1 启动竞态：恢复先于 runtime 就绪

`activate` 在首屏占位（本地 canonical 读）之后、发恢复请求之前插入 `waitForAgentReady`：
已就绪立即返回；未就绪订阅 runtimeStore 变更直到 `agentStatuses[agentId].status === 'connected'`，
上限 `AGENT_READY_TIMEOUT_MS`（15s）。放「占位之后」是为了不给首帧加延迟。

就绪判据取「只有**显式已知的非 connected** 才算未就绪」：状态缺失/非字符串时不阻塞。理由是
不能把「还不知道」当成「未就绪」（在没有状态源的环境里会把恢复永久挂起），同时这也是
`sessionCreationPaths.test.ts` 等既有测试的构造形态（`agentStatuses.owner = {generation: 7}`），
不阻塞即不改变它们的语义。

首败另排一次 `RECOVERY_RETRY_DELAY_MS`（2s）后的退避重试，守卫齐备才排（该 source 未用过额度、
仍是当前 load generation、会话仍是当前绑定）；成功即清零额度。上限 1 次，避免无限重放。

### F4 冷挂载 turn 快照透传 + 上下文用量同源

`normalizePersistedSessionLoadResult` 此前丢弃后端的 `turn` 字段（图灵在 L.md 报备的缺口）。
新增 `ColdMountTurnSnapshot` 类型与 `normalizeColdMountTurnSnapshot`：只透传已知字段、逐字段
类型守卫、缺失不留空键（避免下游深相等回归）。`turn` 为 `null`（会话无已知 turn）与字段缺失
是两种不同事实，前者透传为 `null`。

chip 与百分比不同源的数据侧收口：新增 `resolveContextUsage(usage)` 作为上下文用量的唯一取数
入口（`used`/`limit`/`percent` 由同一份快照派生，`percent` 显式值优先、缺失时由 used/limit 算）。
体检现场的同一条 `usage.updated`（used=21793, size=1000000）下 `0.0 k` 与 `2.3%` 并排，
根因是 token chip 自选了 `totalTokens`/输入+输出字段——**该渲染位属中控区，本 issue 未改**；
数据层现在保证两个显示位拿到同一组数，中控区负责人把 chip 的取数改成 `contextUsed` 即可。

### F5 模型解析链闭合

改前：`session_info_update` 在 live 归一化里只产 mode/status，模型事实整个丢掉；后端
`typed_payload` 也不提取 model——即便 agent 推了当前模型，journal 里也没有可投影的模型事实。

三处闭合：

1. `acpNormalizer` 把 `models.currentModelId`（camel/snake/current 别名）或扁平 `model` 作为
   **独立第三个事实**产出 `session.model-updated`（与 mode/status 并列，不合并）。
2. 后端 `event_repo` 为 `session_info_update` 提取同样的变体写进 `typed_payload.model`——
   这是 cold replay 路径（`canonicalRowToWorkbench` 从 rawPayload 重归一）与语义投影注册表的
   唯一取值来源。
3. 建立期按「agent 显式 `model`（agents.yaml）> profile 传来的 `model` > 响应回显的 current model」
   解析（`resolve_established_model`），非空时走既有 `EventService::ingest_event` 落一条
   `session.model-updated`。写失败只 warn——模型事实缺失不得让已建立成功的会话失败。

### F3 已删会话事件永不清理

两处：

1. **删除联动**：`delete_session_with_state` 在写 tombstone 的同一事务内
   `DELETE FROM canonical_events WHERE owner_key = ?`。只对 `owner_scope='exact'` 生效——
   legacy 墓碑只有裸 `session_id`，同 source 多 owner 会互相误伤（DEL-02 隔离契约），宁可不清。
2. **兜底维护**：新增 `purge_tombstoned_events(grace_days)`（只扫 `state='deleted'` 且
   `owner_scope='exact'` 且超过宽限期的墓碑）+ `checkpoint_wal()`（`PRAGMA wal_checkpoint(TRUNCATE)`），
   由 `lib.rs` 维护 watcher 每 10 分钟执行、启动即跑一次。**墓碑行本身不删**——迟到写 gate 依赖
   其存在性，删墓碑等于允许已删会话复活。

宽限期 `TOMBSTONE_EVENT_GRACE_DAYS = 7`：留误删取证窗口。
`retention_policy` 默认仍是永久保存（D-15 契约未动）——本 GC 不是用户保留策略，它只作用于
「会话已被删除」这个语义上必然的垃圾。

### F6 孤儿消息缓存

删除链路（`removeSessionTransaction → clearMessages`）**本来就已连通**，F6 的残留是「早于该
联动落地的删除」留下的孤儿键。新增 `pruneOrphanMessageSnapshots`，在 sessions 水合后按活会话
集合回收 `pylon-msgs-*` 前缀键（只碰这个前缀，非运行态键一概不动）。

中断归一：`settleInterruptedSnapshot` 把恢复时仍 `running` 的消息收敛为终态——工具消息补
`cancelled`（视觉状态表的「已取消」），而不是像 canonical 终态路径那样补 `completed`，因为
「没有终态行」意味着结局未知，谎报完成比报取消更糟。接在 `browserMessageRepository.load`。

### F7 `unknown` 事件归因

**只读取证结论（关键）**：库内 31 行 `unknown` 的 raw 形状全部是
`{"sessionId": …, "update": {"sessionUpdate": "…"}}`，其判别符分别是 `usage_update` /
`available_commands_update` / `config_option_update` / `session_info_update`——**全部是现行分类器
认识的形状**（`extract_update` 有 `root.get("update")` 分支）。这 31 行的 `created_at` 集中在
2026-08-31～09-02，而同期之后的同形状事件被正确分类成 `usage.updated` 等。结论：这 31 行是旧构建
留下的历史错标，不是现行分类缺口（原始 830 行中的其余 ~799 行属于已删会话，已在 F3 的一次性
清扫中删除）。

处置：在 `_ => "unknown"` 分支加结构化 warn（owner + 判别符 + update 键集合），此后新形状一出现
即可定位，无需逐条反查 raw。事件行契约不变（仍记 `unknown`、raw 完整保留）。

**未做**：不重写这 31 行历史（append-only 契约；改写历史行会破坏 journal 的可审计性）。

### F8 webview2-mcp README 环境变量结论

用只读方式实测复核（不改配置、不重启）：运行中实例的 `msedgewebview2.exe` 命令行**同时**含
wry 默认参数（`--autoplay-policy=no-user-gesture-required`、
`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`）**和**
`--remote-allow-origins=* --remote-debugging-port=9222`。本仓库 `tauri.conf.json` 无
`additionalBrowserArgs`，代码里也没有任何地方设置 `additional_browser_args` → 这两个 flag 的
唯一来源就是环境变量。故运行时 153.0.4234.32 的行为是**追加**，不是「字段非空就忽略环境变量」。
README 原断言（含 wry 行号论证）按事实重写，写明版本边界，并把复核命令写进文档。

「配置字段是整串替换」这一条**仍然正确**（wry `unwrap_or_else` 只在 `None` 时用默认值，
`wry-0.55.1/src/webview2/mod.rs:294`）——两条结论并存，README 明确了「配置=替换 / 环境变量=追加」。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 1（F1）冷启动恢复无「恢复会话失败」；就绪后即完成恢复 | ✅ 就绪门控 + 退避重试落地；`agentWorkbenchLifecycle.recoveryRace.test.ts` 6/6（含「未就绪不请求 / 就绪即请求 / 已就绪不订阅 / 会话切换放弃等待 / 首败重试成功 / 重试上限」）。**实机连续 3 次冷启动未做**——需要重启用户正在使用的便携实例，见「未解问题」 |
| 2（F2）object 形状广告 negotiated/usable=true，诊断无类型错误；Boolean 形状不回归；非法值仍 fail-closed | ✅ `negotiated.rs` 11/11（新增 `list_and_close_accept_object_and_boolean_shapes`，覆盖 object / `true` / `false`/`"yes"`/`null`/`1`）；TS `agentContracts` 37/37（含两条 F2 用例） |
| 3（F3）删除会话后该 owner 事件数为 0；库内 orphan 为 0；WAL 小于主库 | ✅ 删除联动：`del03` 11/11（含「另一 owner 隔离」「legacy 不清扫」）；墓碑清扫 + 宽限期：`purge_tombstoned_events_respects_grace_period_and_keeps_tombstones`；WAL：`checkpoint_wal_is_idempotent` + 维护 watcher。**24h 长跑未做**（见「未解问题」） |
| 4（F4）冷挂载首渲即可取到用量值；chip 与百分比同源（数据层） | ✅ turn 透传：`sessionClientColdMountTurn.test.ts` 5/5（含真实 wire 形状、`null` 与缺失区分、字段级守卫、无 turn 时不新增键）；同源派生：`sessionSurfaceProjection.test.ts` 8/8（含 Hermes 现场值 21793/1000000 → 2.18%） |
| 5（F5）journal 新增一条 `session.model-updated`，取值符合「agent 显式 > profile」 | ✅ 优先级：`established_model_priority_is_agent_then_profile_then_response`；端到端：`tests/issue110_establishment` 通过（fake agent 建立会话后 journal 恰有一条 `session.model-updated`，`typedPayload.model = m-1`）；typed 载体：`kernel_ingest_session_info_update_carries_model_fact`；live 产出：`acpNormalizer` 22/22 |
| 6（F6）删除会话后 `pylon-msgs-*` 键不存在；含 `running:true` 的缓存经恢复加载后全为终态 | ✅ `messageRepository.test.ts` 20/20（孤儿回收 4 条 + 中断归一 3 条，含实测两条孤儿形状） |
| 7（F7）`unknown` 有归因，不再无声增长 | ✅ 归因打点（判别符 + update 键集合）；形状证明：`kernel_ingest_recognizes_legacy_unknown_wire_shapes`（四种真实 raw 形状全部正确分类）；真未知仍保留 raw：`kernel_ingest_truly_unknown_discriminator_keeps_raw`。归因结论见「方案要点 F7」 |
| 8（F8）README 与复测事实一致，给出实测通过的运行时版本 | ✅ README 环境变量章节重写 + 实测版本 153.0.4234.32 + 只读复核命令；故障排查表两行同步 |
| 统一回归项：不改中控区 DOM 与视觉 | ✅ `src/renderers/solid-workbench/input/**` 零 diff（`git diff --stat` 可验） |

## 测试处置

修改的既有测试（逐个点名，均因新契约不再成立而更新断言，非放宽）：

1. `src-tauri/src/session/del03_local_first_delete.rs::begin_delete_writes_deleting_tombstone_and_keeps_canonical_events`
   → 改名 `begin_delete_removes_canonical_events_for_the_same_owner`，断言由「事件留存 1 条」
   改为「该 owner 事件为 0 且另一 owner 不受影响」。
2. `src-tauri/src/session/del01_schema_audit.rs::tombstone_gate_and_delete_semantics_baseline`
   → `canonical_events` 计数断言 1 → 0（迟到写仍被 tombstone 拒绝，故为 0）。
3. `src/domains/workbench/normalizers/__tests__/acpNormalizer.test.ts` 的既有
   `session_info_update` 用例：断言未变、仍全绿（新增的是并列事实用例，未改既有语义）。
4. `src/infrastructure/acp/__tests__/agentContracts.test.ts` 既有 35 条：`list`/`close`
   的 bool `true` 期望未变、仍全绿。

spec 点名但**不需要**改的：

- `src/sheets/__tests__/OverviewSheetView.resumeError.test.tsx`：断言的是 Overview 事务冲突
  呈现，不经 `waitForAgentReady` 路径 → 1/1 仍绿。
- `src/components/settings/__tests__/agentStatusEventMatrix.test.ts`：F2 只改矩阵形状接受集、
  未改诊断文案结构 → 全绿。
- `negotiated.rs` 既有 10 条矩阵测试：全绿（共 11/11）。

新增：Rust 8 条（negotiated 1、event_repo 3、create 1、del03 3）+ 集成 1 条；TS 20 条
（F1 6、F4 10、F5 3、F6 7 中的重复计数以文件为准）。

## 证据

- commit：见本记录的提交 SHA（`git log --oneline bb778095..HEAD`）
- 测试（均退出码 0）：
  - `cargo fmt --all --check` ✅
  - `cargo test --workspace --lib` → 1084 + 93 + 61 / 0 failed
  - `cargo test --workspace --tests --features test-agent` → 1084 / 0 failed（含新增
    `issue110_establishment`）
  - `cargo clippy --workspace --all-targets` + `check-clippy-baseline.mjs`（pylon/pylon-core/
    pylon-foundations/pet-core）→ `added: []`
  - `bun run check:acp-shadow` ✅
  - `bunx tsc -b` ✅ / `bun run lint` → 0 error（1 条既有无关 warning）
  - `bun run check:solid` ✅（运行时边界、CSS 消费、ZONE_FIELDS、插件 API、hook 锚点全绿）
  - `bun run check:ipc` ✅ / `bun run check:docs` ✅
  - `bunx vitest run` → 572 files / 3816 tests / 0 failed
- 手工验证（只读）：
  - 部署实例 `pylon-data-v1.sqlite3`（`mode=ro&immutable=1`）核对 F3/F7 事实；
  - 运行中实例的 `msedgewebview2.exe` 命令行核对 F8 结论（命令写进 README）。

## 与 spec 的偏差

1. **F3「retention_policy 提供默认策略」未按字面做**：`retention_policy` 默认仍是永久保存。
   原因：D-15 契约「禁止因默认值变化自动删除历史」优先，且 spec 括注的语义（「墓碑超 7 天的事件
   可清」）是**墓碑驱动**的 GC，与用户保留策略无关——按后者实现会错误地改动用户可见的设置默认值。
   实现落在 `purge_tombstoned_events` + 维护 watcher。
2. **F4「chip 显示 21.8 k」未做**：属中控区（2026-09-17 裁决移出）。只做数据层同源。
3. **F5「状态条不出现 `unconfigured-model`」未做**：同上，属中控区。
4. **F7「补解析或显式 drop」未按字面做**：归因证明现行分类器已覆盖全部实测形状，故做的是
   「归因打点 + 形状回归锁」，未改写历史行（append-only）。
5. **F6 的中断归一只落在 localStorage 快照路径**：Tauri 主路径的 canonical 投影已有
   `settleMessages`（终态事件清除 running）。「中断回合没有终态行」这一残余在 canonical 主路径
   仍在（前端 `ReplayLoadOutcome.hasCanonicalTurnTerminal` 已具备判据但适配器未消费，属 P52 D4
   的既有退化），未在本轮展开——见「未解问题」。
6. **未追加 ADR**：F2 的双形状是 ADR-0004 决定 3（sessionClose「显式 `true`/object 才为可用」）
   的实现补齐，不是新决策；F3 的删除语义变更属 issue 内的处置裁决。两者都已在 issue 评论与
   本记录登记。

## 未解问题

1. **实机冷启动 3 次验收未跑**：需要重启用户正在使用的便携实例（`pylon.exe` 13372 在跑，
   9222 已开）。F1 的判据已由注入测试（延迟就绪 + 就绪即恢复）覆盖，但「真机连续 3 次冷启动
   无该错误」这条是在真实竞态下才算数——留给下一次自然重启时回读 `webview_console` 增量确认。
2. **F3 的 24h 长跑未做**：checkpoint 与清扫的周期是 10 分钟，判据「连续运行 24h 后 WAL 小于主库」
   需要真实运行时长方能满足。已用幂等单测 + 维护任务接线替代，实际时长效果待观察。
3. **F6 残余**：canonical 主路径上「中断回合无终态行 → 工具卡永久 running」。判据
   （`hasCanonicalTurnTerminal`）已存在但被 P52 D4 的 no-op 适配器丢掉；接上它需要与中控区/渲染
   负责人对齐（会改变会话页视觉），未擅自动。
4. **F8 的 `tools/webview2-mcp/src` 提示词未改**：`src/main.rs:174`、`src/error.rs:15` 仍只
   指引改配置。属 Brahe 文件域，已在 L.md 报备请其处置。
5. **历史 31 行 `unknown` 未清理**：append-only 契约下不改写历史；如需清库，走一次性只读备份 +
   人工确认的路径（与 F3 遗留清扫同规格）。

## 并行交集

本轮碰过、可能与他人冲突的文件：

- `tools/webview2-mcp/README.md` —— **Brahe（#85）声明域**。只改环境变量章节 + 故障排查表两行 +
  开头一句，未碰 `tools/webview2-mcp/src/**`；已在 `.agents/L.md` 报备。
- `src-tauri/src/session/msg_repo/mod.rs`、`del03_local_first_delete.rs`、`del01_schema_audit.rs`
  ——删除域（DEL-01/02/03）。本轮改了删除的事务内容与两条断言，若后续有人动 DEL 系列请先读本记录。
- `src-tauri/src/session/event_repo.rs` ——事件归一化域（#99/#81 都碰过）。本轮改了
  `session_info_update` 的 typed 提取与 `unknown` 分支。
- `src-tauri/src/session/create.rs` ——会话建立域（#97 的初值 model 规划在此）。本轮在其后追加
  建立期模型事实落盘，未改既有初值下发链。
- `docs/说明书/Pylon-项目架构参考.md`、`Pylon-模块维护地图.md` ——§7/§8 与模块表三处；
  与 #116（前端）无重叠。
- `.agents/L.md` ——按 §2.3.5 只追写。
