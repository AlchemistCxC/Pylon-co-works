# Dev Record — #155 T2 schema 破坏性重建（v15：瘦身行 + 重建迁移 + 空闲页回收）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/155-t2-schema-rebuild.md`

## 元信息

- issue：#155（本切片 = ADR-0008 分期中的 **T2**；T1 已随 PR #180 合入）
- 分支：`Ru5t/Reflector`
- 提交范围：`71cc3fa7..` （L.md 登记之后的施工提交）
- 日期：2026-09-19

## 目标与范围

**达成**：schema v14 → v15 破坏性重建——
1. `canonical_events` 存储收窄：28 列 → 15 列，`(owner_key, sequence)` **WITHOUT ROWID**
   聚簇主键（取代 event_id 主键 + `UNIQUE(owner_key,sequence)` 自动索引 +
   `idx_canonical_events_session_seq` 三棵重复 btree）；`event_id`/owner 分维列/
   `schema_version`/provenance 四字段/raw_* 截断计数**改读侧派生**（wire EVT-01 的
   28 字段契约零改动，evt_* 命令签名与 expectedRevision 语义不变）。
2. 旧库（user_version < 15）打开即**重建**（ADR-0008「老数据我一个都不要了」）：
   保留 `user_data.profiles`（配置）与 `retention_policy`（设置）；丢弃 canonical
   历史、墓碑行、状态快照、`user_data.sessions` 会话列表信封、rollup 进度、全部
   legacy 归档表。重建后 `auto_vacuum=INCREMENTAL` + `application_id=0x50594C4E`
   经 VACUUM 落盘（闲置页全回收）；维护周期追加 `PRAGMA incremental_vacuum`。
3. 死表清理：`sessions`、`legacy_message_backfill_audit` 不再创建；v10–v14 全部
   补列/搬迁式迁移代码删除（重建路径取代升版）。

**不做**（T3，ADR-0008 明确「待用户确认、拿到 T2 读数后再决定」）：内核聚合
batch 行、`canonical_event_draft` 尾巴、`canonicalEventCursor` 跨度感知。本轮
**前端零文件改动**。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/session/msg_repo/mod.rs` | SCHEMA_VERSION=15、PYLON_APPLICATION_ID、SCHEMA_SQL（15 列 WITHOUT ROWID + 墓碑索引并入 DDL、删 sessions/audit 表）、touch_session 改纯墓碑闸、删 session_id 键控 state 三方法、delete 事务摘除 sessions、retention ByCount 改 sequence、release_free_pages | 修改 |
| `src-tauri/src/session/msg_repo/migrations.rs` | 重写：删 v10/v11/v12/v13/v14 迁移与审计回填；LEGACY_DROP_TABLES 重建路径 + user_data 保留键 + PRAGMA 头字段；validate_schema_objects / validate_db_header 拆分 | 重写 |
| `src-tauri/src/session/event_repo.rs` | 派生辅助（owner_triple/provenance_code/provenance_parts/derive_raw_metadata）、execute_insert_event 三路共用、EVENT_COLUMNS/INSERT SQL 常量、map_event_row/list_events 映射、has_authoritative 改 provenance=0、export_raw_event rsplit、search_owners 派生排序、trim SQL e.event_id 改派生 | 修改 |
| `src-tauri/src/session/storage_write_bench.rs` | 基准测试：WAL/占用/检查点/空闲页 | 新增 |
| `src-tauri/src/session/msg_repo/tests.rs` | 见「测试处置」 | 修改 |
| `src-tauri/src/session/del01_schema_audit.rs` | 表/列/索引/版本基线 → v15 | 修改 |
| `src-tauri/src/session/del02_tombstone_migration.rs` | v6 升级测试改重建语义 | 修改 |
| `src-tauri/src/session/del03_local_first_delete.rs` | 删 sessions 计数断言 | 修改 |
| `src-tauri/src/session/persistence_bootstrap.rs` | 表清单去 sessions | 修改 |
| `src-tauri/src/session/mod.rs` | 注册 storage_write_bench | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | 存储一节：v15 形态、重建语义、基准读数 | 修改 |

## 方案要点

- **派生而非砍契约**：EVT-01 wire/TS `CanonicalConversationEvent` 的 28 字段全部
  保留；存储只留 15 列。`provenance` 列编码五组合（0=local-observed/authoritative，
  1=recovery-import/unverified，2=optimistic-local，3=migration，4=plugin），
  provider/import_id 按组合派生（勘察结论：kernel 恒 provider=agent_id；TS sink
  append 不带 provenance→默认 migration；全代码域无自定义 provider 的存储往返）。
  raw_* 计数自 raw_payload 文本自描述重算（截断 stub 自带 `_pylonTruncated/
  originalBytes`）——与 `canonical_event_wire` 既有注释「截断信息由 rawPayload
  重算」同一纪律。
- **auto_vacuum 落盘语义**（实测钉死）：非空库上 `PRAGMA auto_vacuum` 设置是连接
  级的，须经**同连接** VACUUM 才写入文件头；VACUUM 前读回仍是旧值。因此
  manifest 校验拆两层——对象形状（事务内可跑）与头字段（仅 migrate 后）。
- **重建保留面**：`user_data` 只留 `profiles` 键（侧栏会话列表 `sessions` 键随历史
  丢弃，ADR 承认「重建后不会再有历史会话」）；极旧库可能无 user_data 表（守卫跳过）。
- **基准口径**：对齐 issue 的 Python 基准——`wal_autocheckpoint=0` 下量 `-wal`
  文件大小 = 累计写入；检查点频率为派生指标（WAL 总量 / 1000 页阈值）；载荷对齐
  真实行形状（~211 B 内容/行）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 既有行为测试全绿（未修改断言主体，机械适配见下） | ✅ `cargo test`（lib 1096 passed / 0 failed / 4 ignored；integration 3+5 passed） |
| 门禁 `bun run check:all` | 见 PR/issue 评论的最新证据（首轮因 G: 盘满 LNK1318/os error 112 中断，清 incremental 缓存后重跑） |
| WAL 写入 ≤ per-chunk 基线 1/8（1200 chunk） | ✅ **23,257,432 B → 1,656,272 B = 0.0712（≈1/14）** |
| checkpoint 频率同比例下降 | ✅ 隐含次数 6 → 1（比值 0.167，与 WAL 比值同向） |
| `(owner_key, sequence)` 主键 | ✅ SCHEMA + manifest PK 校验 + DEL-01 基线钉死 |
| 表占用相对基线 ≤ 60% | ⚠️ **未达**：均匀流式混合实测 **0.794**（552,960/696,320 B）。成因 = ADR T2「542→~250 B/行」对剩余固定成本的低估：保真契约列不可再砍（owner_key 聚簇键 26 B、occurred_at/received_at 原始 ISO 文本（§5.10 rule 4）48 B、event_type 21 B、remote_session_id、单元化与页内 slack ≈190 B/行）。结构性削减（冗余主键/分维列/provenance 字串/raw_* 计数/三棵→一棵 btree）已全部落地。基准对占用断言回归护栏 ≤0.85 |
| 真实库重建后闲置页 ≤ 1%、文件 ≈ 内容大小 | ✅ 重建测试 `freelist=0`；删半数行 + incremental_vacuum 后 `freelist=0`（135→134 页） |
| 裁剪前重折叠 sha256 等价（含聚合行输入） | ✅ T1 已钉（`fold_of_aggregated_row_equals_fold_of_original_chunks`），本轮折叠算法零改动、相关测试未动全绿 |
| 内核为唯一聚合生产者 + parity 契约 | ⏸ T3 范围，按 ADR 待用户裁决（本轮无聚合生产者：逐 chunk 行 + 批事务） |
| 未新增白名单豁免 | ✅ REQUIRED_INDEXES 缩减（删 idx_session_seq），无新增 |

## 测试处置

**删除**（其对象 v10–v14 升级迁移代码已删，重建路径取代）：
- `migrate_backfills_provable_legacy_messages_and_archives_all_v8_tables`（v11 回填归档）
- `legacy_archive_collision_rolls_back_without_touching_source_or_version`（v11 冲突回滚）
- `v10_migrates_legacy_state_only_when_journal_proves_one_owner`（v10 backfill）
- `tombstone_owner_key_collision_rolls_back_v12_migration`（v12 墓碑重建）
- `session_state_write_rejects_tombstoned_session_without_resurrection`（session_id 键控死表方法；owner 键控等价覆盖已在 `owner_tombstone_deletes_and_blocks_only_the_matching_snapshot`）

**新增**：
- `legacy_db_is_rebuilt_without_data_migration`（重建保留面/丢弃面/头字段/闲置页）
- `v15_storage_beats_v14_baseline_on_wal_and_footprint`、`incremental_vacuum_keeps_free_pages_below_one_percent`

**修改（schema 钉死基线随 v15 演进，非行为断言）**：
- del01 四基线（版本/表清单/列清单/索引清单）+ tombstone 行为测试去 sessions 断言
- del02 `migrate_upgrades_v6_tombstone_to_latest_owner_state` 改重建语义（墓碑丢弃、无 v11 归档）
- del03/persistence_bootstrap/msg_repo tests 的 `COUNT(*) FROM sessions` 断言移除（死表）
- `session_state_roundtrip_merge_keeps_existing_keys` 移植到 owner 键控生产路径
- `corrupt_json_columns_fail_with_event_and_column_context` 注入 SQL 改 owner+sequence 定位（event_id 列已删）
- `fresh_db_migration_includes_table_after_reopen` 列清单改 v15（15 列在、派生列不在）

## 证据

- 基准输出（`cargo test --lib storage_write_bench -- --nocapture`）：
  - v14 per-chunk：wal=23,257,432 B，db=696,320 B，elapsed=101.99 ms，implied_checkpoints=6
  - v15 windowed（32 行/窗）：wal=1,656,272 B，db=552,960 B，elapsed=43.20 ms，implied_checkpoints=1
  - ratios：wal=0.0712，db=0.794，checkpoint_ratio=0.1667
  - vacuum：pages 135 → 134，freelist=0
- 全量 Rust：`cargo test --manifest-path src-tauri/Cargo.toml` = lib 1096 passed / 0 failed / 4 ignored + tests 3+5 passed
- commit：见 PR

## 与 spec 的偏差

- spec 写「表占用 ≤ 60%」为目标断言；实测机制地板 ≈0.72（见上），改为回归护栏
  ≤0.85 + 如实上报差距，未砍契约列去凑数（occurred_at/received_at 存原始 ISO 文本
  是 §5.10 rule 4 的明文契约）。
- spec 未预见 `auto_vacuum` 头字段的 VACUUM 落盘时序与「PRAGMA incremental_vacuum
  不返回行」两个 SQLite 细节，实现中分别以校验拆层与 execute_batch 处理。

## 未解问题

1. **T3 决策（用户）**：ADR-0008 的方案 G（消息粒度历史 + draft 尾巴）仍是
   「提议，待确认」。T1+T2 后写入压力已降一个数量级（WAL 1/14），是否仍需 T3
   请按实际增长读数裁决。
2. 表占用 60% 子判据未达（0.794，均匀流式混合）——若要继续压，候选是 event_type
   编码化（牺牲「unknown 原样落盘」的简单性）或 occurred_at 派生（违反 rule 4），
   两者都需要用户拍板。

## 并行交集

- `src-tauri/resources/sdk/pylon-plugin-sdk.js`：他人在途（API 版本 2.2→2.3），
  全程未 stage、未改写、不随本 PR 提交。
- `docs/说明书/Pylon-项目架构参考.md`：本轮改了存储一节；#171/#175 在途条目如也
  动此文件请以本节（SQLite schema 列表 + canonical_events 条目）为界避让。
