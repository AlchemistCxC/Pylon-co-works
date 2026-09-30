# Dev Record — #445 搜索命中定位下沉后端

> 入库保留。规格文档（`.agents/spec/445-search-hit-rows-backend.md`）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#445（refactor(search): 搜索命中定位下沉后端——消候选 owner 全量过 IPC 与两阶段口径分叉）
- 分支：`kumo/prometheus`
- 提交范围：`d817df3b..4bfc63ae`（含 L.md 声明提交 96c21446）
- 日期：2026-09-30

## 目标与范围

搜索两阶段原本是「后端 `evt_search` LIKE 出候选 owner（≤50）→ 前端对每个候选
`loadAllPreferUnits` **全量拉整个会话事件流**过 IPC → 投影 → `includes` 匹配」：
数据移动量随会话增长线性恶化，且后端在 raw/typed payload 的 JSON 原文上匹配、前端在
投影文本上复核——后端命中的行投影文本里未必含查询词（漏配对）。

本次把 `evt_search` 升级为返回**命中行**（owner 三元组 + sequence/eventType/occurredAt/
matchOffset），前端按命中行定向拉行后投影复核：IPC 从「50 会话全量」降到「命中行集」，
匹配与命中同源。

**不做**（issue 明示）：不动投影/归一（ADR-0018 投影不下沉）、不动 browser
snapshotSearch、不引入 FTS5/trigram、不改 wire 命令名与参数（返回形状 additive 扩展）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-session/src/event_repo/row.rs` | `EventSearchOwner` → `EventSearchHit`（重命名 + 4 字段 additive） | 修改+重命名 |
| `src-tauri/pylon-session/src/event_repo/repo.rs` | `search_owners` → `search_hits`：SELECT 增命中行定位与 instr 偏移、ORDER BY owner_key,sequence；WHERE 三列与 pattern 构造一字不改 | 修改+重命名 |
| `src-tauri/pylon-session/src/event_repo/service.rs` | spawn_blocking 门面随签名换型 | 修改 |
| `src-tauri/pylon-session/src/event_repo/mod.rs` | re-export 换型 | 修改 |
| `src-tauri/pylon-session/src/event_repo/tests.rs` | 既有搜索测试改写为命中行测试组（4 测） | 修改 |
| `src-tauri/src/session/mod.rs` | `evt_search` 命令体与 doc 注释（签名/wire 名不变） | 修改 |
| `src/infrastructure/events/canonicalEventRepository.ts` | `CanonicalEventSearchHit` 类型；接口与实现 `searchOwners` → `searchHits` | 修改 |
| `src/infrastructure/events/__tests__/canonicalEventRepository.test.ts` | invoke 形状测试改命中行；fake 随迁 | 修改 |
| `src/domains/search/searchService.ts` | `searchAllMessagesTauri` 阶段 2 重写：定向拉行 + 合流投影 + includes 复核 | 修改 |
| `src/domains/search/__tests__/searchService.test.ts` | 新增（6 测） | 新增 |

## 方案要点

- **recall 保真**：SQL WHERE 三列（event_type/raw_payload/typed_payload LIKE NOCASE）与
  `%query%` pattern 构造保持一字不改，命中集合（召回）与候选 owner 版完全一致；refactor
  不扩召回。
- **排序截断语义保真**：保持 v15 的「全量命中 → 按 (profile, agent, local) 排序 → 截断」；
  SQL 只做 `ORDER BY owner_key, sequence`，Rust 侧**稳定**排序按三元组重排（保留 owner 内
  sequence 升序）后 truncate。LIMIT 不下推 SQL——那会在三元组排序前截断、改变 owner 组成。
- **matchOffset**：`NULLIF(instr(lower(列), lower(?query)), 0)`；SQLite `lower()` 是 ASCII
  折叠，与 NOCASE 语义对齐，raw/typed 列命中的行 offset 必非 NULL；仅 event_type 列命中
  时为 None。advisory 字段，前端 v1 不消费（定位与 snippet 一律以投影文本为准）。
- **前端定向拉行**：命中行按 owner 分组、sequence 去重；每命中行一次
  `evt_load_compact(ownerKey, sequence-1, 1)`——恰好取回该位置的 compact 有效行（命中行
  自身，或覆盖它的 `turn.unit` 单元行，trim 中间态命中不丢）。回读行按 sequence 去重后
  **合流投影**（同 owner 的行集一次 `projectMessagesFromCanonical`，delta 聚合/工具卡折叠
  语义不变），逐 message 走既有 `getMessageSearchText` + `includes` 复核，snippet 仍由
  `snippetAround` 从投影文本生成。
- **单行投影可行性**（核实过）：孤儿 `tool.call.updated/completed/failed` 在投影规则里自建
  工具卡；`turn.unit` 经 `expandTurnUnitRows` 展开（delta-run 段展开为整段文本行）；
  `user.message` 单行即完整用户消息。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 后端命中行单测（含中文查询、snippet/偏移边界） | ✅ 4 测：行粒度+大小写折叠、中文精确匹配（instr 偏移 12）与 ASCII 折叠偏移（10）、仅 event_type 命中 offset=None、三元组排序截断、300 行会话命中 2 行的载荷读数 |
| 前端搜索结果与既有行为等价（同查询同命中） | ✅ 匹配函数与复核口径未动（同一 `getMessageSearchText`+`includes`）；后端 recall 不变。已知收窄见下节 |
| 单次搜索 IPC 载荷从「候选 owner 全量行」降为「命中行集」 | ✅ 读数佐证：`search_hits_payload_is_hit_row_set_not_full_stream`——300 行会话命中 2 行时搜索返回 2 行（全量 compact 读 300 行）；前端 6 测断言只发单行 compact 读、不触发 loadAllPreferUnits |
| `bun run test` 绿 | ✅ 5179 passed / 664 files |
| `cargo test` 绿 | ✅ pylon-session 216 passed；主 crate 970 passed |
| `bun run check:clippy` 绿 | ✅ 基线外新增诊断 0（修掉一处自引入的 `unnecessary_to_owned`） |

其余门禁：`bun run check:frontend`（lint/csp/ipc/bundle 等）与 `bun run check:solid` 通过；
`cargo fmt --all --check` 通过；`cargo check --workspace` 通过。

## 测试处置

- 改写：`search_owners_matches_content_case_insensitive_and_dedupes` →
  `search_hits_returns_hit_rows_case_insensitive_and_keeps_row_granularity`（owner 去重语义
  随契约退役，断言改为行粒度返回）+ 新增 `search_hits_matches_chinese_query_and_reports_exact_offsets`、
  `search_hits_orders_by_owner_triple_then_sequence_and_truncates`、
  `search_hits_payload_is_hit_row_set_not_full_stream`。
- 修改：`canonicalEventRepository.test.ts` 的 searchOwners invoke 形状测试 → searchHits 命中行形状。
- 新增：`src/domains/search/__tests__/searchService.test.ts`（此前 searchService 无测试）。

## 证据

- commit：96c21446（L.md 声明）、4bfc63ae（实现）
- 测试：`cargo test -p pylon-session --lib` 216 passed；`cargo test --lib` 970 passed；
  `bun run test` 5179 passed；`bun run check:clippy` EXIT=0；`bun run check:frontend` /
  `bun run check:solid` EXIT=0
- 手工验证：未做实机验收（纯读路径重构，行为等价由双侧单测覆盖；如需实机复验可走
  webview2-acceptance 流程）

## 与 spec 的偏差

- 验收判据原文「后端命中行单测（含中文查询、snippet 边界）」按 issue 风险节的**首版行定位
  方案**执行：后端不产 snippet（raw JSON 文本提取质量差，issue 明示首版可不做），snippet
  边界由前端 `snippetAround`（既有函数）在测试中覆盖；后端侧对应覆盖为 instr 偏移的中文
  与 ASCII 边界断言。

## 未解问题

- **已知收窄（首版接受）**：查询词跨 delta 行（单词被流式切成多个 delta chunk 且尚未折叠成
  `turn.unit`）时，后端无单行命中 → 旧版经全量投影聚合可命中、新版不命中。回合折叠后
  （L3 裁剪常态）段文本完整，无此收窄。如需覆盖，后续可在后端做相邻 delta run 的拼接
  LIKE 或前端按命中行邻域扩拉——留作后续档，不在本次 refactor 的 recall 承诺内。
- 后端 snippet（SQL `instr`+`substr` 从原文提取）留作后续优化档（issue 明示）。

## 并行交集

- `src-tauri/src/session/mod.rs`：仅 evt_search 命令体 hunk；该文件其他区域未动。
- 共享树在途的 #444（export/sanitize 域）、#471（pack_release 域）改动未卷入本次提交；
  `src-tauri/src/lib.rs`（#463 在途）未触碰——evt_search 的命令注册行不涉及类型导入。
