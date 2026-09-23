# Dev Record — #260 后端+前端开销清偿第二批（14 项）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：https://github.com/AlchemistCxC/Pylon-co-works/issues/260
- 分支：`kumo/prometheus`（堆叠于 PR #257；#258 同支先行合入）
- 提交范围：`9bf7b125..84b2591d` + fmt 补丁（批次 A `4b51770d`、批次 B `809d865e`、fmt `—`、批次 C `84b2591d`、批次 D `—`）
- 日期：2026-09-23

## 目标与范围

#258 子 agent 双向扫描遗留全集 14 项一次清偿（后端 7 + 前端 7），全部满足：不改契约、不改行为、不改插件架构。不做：`StderrTail` 保留策略、echo 宏分支、#155/#238/#259 域。

## 改动清单

| 批次 | 文件 | 性质 |
| --- | --- | --- |
| A | `pylon-acp/src/wire_trace.rs`：canonical_correlations `HashMap`→`BTreeMap`（逐出取首键=min）、`correlate_many` 新增、`WireIdentity`（Arc<str> 五字段 + client_generation）、WireRecord 身份字段改 `Arc<str>`、新增 2 条钉子测试 | 修改 |
| A | `src-tauri/src/lifecycle/mod.rs`：wire_trace_snapshot 改批量 correlate（一次持锁） | 修改 |
| A | `pylon-acp/Cargo.toml`：serde +`rc`；`acp/{golden_trace_tests,tests}.rs`：字面量/断言类型跟随 | 修改 |
| B | `pylon-acp/src/engine.rs`：publish_inbound 双锁合并 + `receiver_count()>0` 才 clone+send | 修改 |
| B | `src/hook_bridge.rs`：emit 前留存标量句柄、emit 移动原值 | 修改 |
| B | `pylon-acp/src/{stderr_tail,client}.rs`：`has_recent_evidence(max_bytes)` 零分配判定 | 修改 |
| B | `pylon-acp/src/turn_ledger.rs`：drop_generation 单遍 retain | 修改 |
| C | `domains/tool/toolPresentation.ts`：`countNonEmptyLines` 单遍计数器；`components/chat/toolPresentationModel.ts` 复用 | 修改 |
| C | `renderers/solid-workbench/chat/GenerationFooter.solid.tsx`：configuredVerbs/graphemes/activeIndex memo 化、两处冻结数组防御性展开删除 | 修改 |
| C | `components/chat/{spinnerMachine,spinnerFrames}.ts`：resolveFrame/resolveSpinnerMarker 形参放宽 `readonly string[]` | 修改 |
| C | `components/sidebar/SessionsPanel.tsx`：一次遍历 Map 分组 + liveGenerating Set | 修改 |
| D | **删除** `components/chat/spinnerVerbs.ts`（全仓零消费方，删除前再核实） | 删除 |
| D | `plugin-runtime/storage/pluginStorageApi.ts`：TextEncoder 模块级单例 | 修改 |
| D | `components/PetCompanion.tsx`：WeakMap 序列化缓存（save 无变化短路） | 修改 |
| D | `identityStore.ts`：`ownerHintsFromSheetStates()` 提取三份拷贝 | 修改 |

## 方案要点（对扫描建议的两处修正）

1. **wire_trace 逐出不采用插入序 FIFO**（子 agent 原案）：canonical ordinal 来自共享 event repo，对单 hub 不保证单调；FIFO 按「最早插入」逐出、现状按「最小 ordinal」，乱序时结果不同。改 BTreeMap 首键——**逐出对象与 `keys().min()` 逐一相同**，零顺序假设；乱序钉子测试 `canonical_eviction_drops_smallest_ordinal_even_when_inserted_out_of_order` 钉住（最小键 2 被逐出、最早插入的 7 保留）。
2. **工具行数不复用 render 结果**（子 agent 原案）：两处统计对象不同（`tool.output` vs `collectToolOutput` 结果），复用会在「toolOutput 空但 contentBlocks 有输出」时改变计数。改为共享单遍实现，两处各自消费。
3. **client kill 判空语义边界**：`tail_since(0,1,512)` 的字节预算使「最新行超长」时也判空——`has_recent_evidence` 精确保留该语义（`lines.back().len() <= max_bytes`），不做朴素 `is_empty`（那是行为变化）。
4. **GenerationFooter 防御性展开删除引出 readonly 放宽**：`check:solid` 抓到 `appearance.frames` 是 `readonly string[]` 而两函数形参可变——展开本只为过类型。两函数只读，形参放宽 `readonly string[]`（后向兼容全部调用方），删每 tick 纯拷贝。
5. 其余等价性论证（receiver_count 门控的订阅先于 load 不变量、correlate_many 锁中毒全 None、WeakMap 依赖 setPet 纯替换、PetCompanion persistable 纯投影）见 spec 承接于本记录上文与代码注释。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `cargo test --workspace` | ✅ 1413 passed / 0 failed（含新增 wire_trace 2 条钉子；#258 前基线 1411） |
| `cargo fmt --all -- --check` | ✅ 干净 |
| clippy 基线 | ✅ 汇总与基线一致，触碰文件零警告 |
| vitest 全量 | ✅ 626 文件 / **4712 passed** / 0 failed（1 skipped/1 todo 为存量） |
| `bun run check:frontend:static`（tsc/lint/build/边界） | ✅ rc=0 |
| `bun run check:solid` | ✅ rc=0（首轮抓出 readonly 类型问题，已修正后复跑） |
| 既有测试零降级 | ✅ 除类型跟随（golden 字面量 `.into()`、身份断言 `&*`）外零修改 |

## 测试处置

- 新增：`wire_trace.rs` 乱序逐出钉子 + `correlate_many_matches_per_record_correlate`。
- 修改：`acp/tests.rs:741-742`、`wire_trace.rs` 身份断言加 `&*`（Arc<str> 解引用，非断言降级）；golden 字面量 `.to_string()`→`.into()`。
- 删除：`spinnerVerbs.ts`（无对应测试文件）。

## 证据

- 提交：批次 A `4b51770d`、批次 B `809d865e`、fmt 补丁、批次 C `84b2591d`、批次 D（spinnerVerbs 删除等 4 文件）。
- 门禁输出：上表（fmt rc=0；cargo 全量 passed=1413 failed=0；vitest rc=0 4712 passed；static/solid rc=0）。

## 与 spec 的偏差

- spec 把 Cargo.lock 列为批次 A 触碰面——实际 feature 开关不改依赖图，Cargo.lock 零变化。
- `resolveFrame`/`resolveSpinnerMarker` 的 `readonly string[]` 放宽是 spec 未预写的必要跟随（check:solid 发现），已在上文方案要点 4 说明。

## 未解问题

无新增。扫描候选至此全部清偿；后续如再发现同类，另行立项。

## 并行交集

- 本次触碰面见 L.md [2026-09-23 07] 条目。
- 观察到不碰：`src-tauri/src/session/**`（#261 在途域，其条目亦声明不碰 #260 域，互不干扰）。
