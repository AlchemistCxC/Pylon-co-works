# Dev Record — #204③ 投影/事件层收口 + #226 batch 行段级展开

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/<issue>-<slug>.md`

## 元信息

- issue：#226（主体）；#204 症状③投影/事件层；关联 #155（见「未解问题」）
- 分支：`Ru5t/Reflector`
- 提交范围：`b64e8b0b..73344a3e`（三个独立 commit：Stage A / Stage B / Stage C）
- 日期：2026-09-21

## 目标与范围

用户原话：「可以都做 由你来实现」（针对评估结论：live 投影四项局部修复、batch 行段级展开、
foldLog 保留策略、#155 T3 内核写侧聚合）。

**做什么**：把 live 单事件流式路径的每帧超线性成本压回对数级；把 journal batch 行的读侧
展开从逐 chunk 收敛为段级（冷重放信封数随折叠比下降）；把 foldLog 的留存收敛到 journal
权威集。

**不做什么**：不动 live 投递粒度 / durable-before-project / per-frame 语义（ADR-0018 修订 1
边界）；不动 `insertBySequence` 的不可变数组拷贝与 `freezeDocument` 冻结契约（#204③ 后续，
涉及渲染引用稳定契约）；不动渲染层（graftBases 预算 / 长代码窗口化 / 流式代码块折叠另行）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/workbench/workbenchProjector.ts` | `timelineHasBetween`（sequence 有序 timeline 二分定位区间 + 区间内扫描）；`textStreamContinues`/`hasToolBetween` 无索引回退改走二分；`refreshOrphans` id 集合按 activities 数组引用挂 WeakMap | 修改 |
| `src/domains/workbench/workbenchRuntime.ts` | `legacyFieldsFromDocument` 两处 `[...].reverse().find()` → 倒序循环免分配；`projectLegacyMessages` 按单条 WorkbenchMessage 引用 WeakMap memo | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts` | `expandCanonicalBatchRow` 段级展开（归一单源 + 收割 + 单信封 + 偏离回退）；refresh 成功路径 foldLog 整体替换 | 修改 |
| `src/__tests__/replay/agentWorkbenchSession.batch.test.ts` | 契约随 #226 更新（消息面/appliedRanges 逐字节 + timeline 按聚合行对应）；新增归一偏离回退护栏 | 修改/新增 |
| `src/__tests__/replay/documentLayer.test.ts` | 同上契约更新（快照增加 appliedRanges/timeline 序列+kind） | 修改 |
| `src/sheets/agent-workbench/__tests__/agentWorkbenchSession.test.ts` | 新增 foldLog 替换回归 | 新增用例 |
| `docs/说明书/Pylon-项目架构参考.md` | `canonical_events` 一节 batch 行读侧展开表述同步（#226） | 修改 |

## 方案要点

### 一、live 单事件路径（Stage A，全部语义等价）

`reduceWorkbenchEvent` 取不到批量路径的 `ProjectionContext`（#205 有意不合流），三处回退分支
是超线性所在：

1. `textStreamContinues` / `hasToolBetween` 的整条 `timeline.some`：命中区间在 timeline 尾部
   而扫描从 0 起，无边界时恒走满 O(N)。改 `timelineHasBetween`：先二分定位首个
   `sequence > after` 的条目，再在区间内扫描。live 流式的区间几乎恒空（相邻 sequence），
   每帧 O(N) → O(log N + k)；谓词语义逐条不变。
2. `refreshOrphans` 每帧重建 `Set(activities ids)` + 全量 map：delta 帧不改 activities，
   数组引用跨帧稳定 → 按引用挂模块级 WeakMap，O(1) 命中（与 #205 批量路径按同一性短路同构）。
3. `legacyFieldsFromDocument`（每次 publish 都走）：两处反向数组分配改倒序循环；
   `projectLegacyMessages` 原按 messages **数组**引用 memo，delta 每帧新数组 ⇒ 恒 O(M)
   全量重建——改按**单条 WorkbenchMessage 引用** memo，每帧只重投影变化行，数组拷贝
   只剩指针复制。

### 二、batch 行段级展开（Stage B，#226）

`expandCanonicalBatchRow` 原按 `seqSpan` 逐 chunk 展开信封（每行最多 2000 个）：#205 的 SQL
读侧折叠把下发行数压到数百后，JS 侧事件数被这一步弹回数万。改为：

- **归一规则不另起第二套**：仍逐 chunk 过 `normalizeAgentEvent`（claudeCode/hermes/peri/acp
  四方言 + pylon 扩展分发原样生效），只收割语义 `parts` 与 `identity`；
- 整段 run 合成**一个**信封（对齐 `turn.unit` delta-run 段形）；
- 等价性论证：run 内 sequence 相邻 ⇒ chunk 之间不存在 timeline 边界条目 ⇒ fold 决策单次
  求值等价；parts 拼接满足结合律（coalesce 是相邻同型折叠）⇒ 投影器一次性 coalesce 与
  逐 chunk 增量 coalesce 终态一致；message identity 终态 = 末个非空 chunk（append 覆盖
  语义）；time/occurredAt 取行值 = 首 chunk（`buildBatchRow` 保留首条时间戳）；
- **偏离回退**：任一 chunk 归一偏离期望形状（方言跨界 / 多事件 / 角色不符）→ 整行退回
  逐 chunk 展开，raw 保真不丢（护栏用例钉死）。

### 三、foldLog 留存（Stage C）

调研修正了评估期的一个判断：`foldEvent`（live/乐观/.session-response 单事件折叠）**从不**
进 foldLog——log 只含 `foldPage`（bind/refresh/回滚重折）的输入集。因此真实的留存浪费是：
refresh 重建文档后，log 仍钉住 **bind 时代的旧信封实例**（与替换后的文档不共享事件对象），
等于把一整份旧事件图独占留存。修法：refresh 成功路径把 log **整体替换**为本次 journal
权威集（替换后 log 信封与文档 timeline 共享同一语义事件对象，仅余信封壳）；被拒回滚的
整页重折源因此恰好是 journal 权威集，回滚语义不变（未提交乐观行由
`withPendingOptimistic` 随后补入 log）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 既有等价矩阵全绿 | replay 25 文件 / 479 例、workbench 47 文件 / 448 例、session 套件 27 例全绿 |
| 全量前端测试 | `npx vitest run` → 621 文件 / **4649 passed** / 1 todo / 0 failed |
| lint | 0 errors / 1 warning（`RightRailHost.tsx` 存量，非本域） |
| `tsc -p tsconfig.solid.json` | 绿（exit 0） |
| 新增护栏 | 归一偏离回退（tool chunk 混入 batch 行 → 整行退回逐 chunk，工具卡与文本均保留）；foldLog 替换回归（refresh 长行后被拒回滚保留 refresh 时代事实） |

## 测试处置（契约变更说明）

- **修改**（2 个用例，均为被 #226 有意变更的旧契约）：`agentWorkbenchSession.batch.test.ts`
  「appliedEventIds 与文档和逐 chunk 存储逐字节一致」「live…文档与逐 chunk 发布一致」——
  原「文档逐字节相等」含 timeline 逐 chunk 逐字节，这正是 #226 要消除的膨胀。新契约：
  消息面（role/content/identity/sequence/running/time）与 appliedRanges/appliedEventIds
  逐字节一致 + timeline 按聚合行（sequence, kind）对应（run 条目 sequence=跨度末位、
  kind=逐 chunk 同序列条目）。`documentLayer.test.ts` 的聚合形态断言同口径拆分；
  单元形态断言不变。
- **新增**：归一偏离回退护栏、foldLog 替换回归。

## 证据

- commit：`b64e8b0b`（Stage A）、`9fb19b21`（Stage B）、`73344a3e`（Stage C）
- 测试输出见上方验收表（本机 vitest 4.1.11 实跑）

## 未解问题

1. **#204③ 结构性残留**：`insertBySequence` 尾插 O(N) 数组拷贝与 `freezeDocument` 每帧
   O(N) 冻结遍历仍在（不可变数组 + 冻结引用稳定契约的领地），本组四项修复消掉的是
   扫描与重建，不是拷贝本身。
2. **渲染层三项**（graftBases 字节预算 / 长代码尾块窗口化 / 流式代码块折叠）不在本轮，
   见 #204 ③ 记录，待裁决。
3. **#155 状态修正**：评估期「T3 写侧聚合待落地」已过时——T3-1（窗口内写侧聚合）已随
   `72b92499` 落地（行数 32×/窗口）；剩余 T3-2（跨窗口累积到回合边界）上一轮已给出
   「先不做」建议（要碰 durable 边界，读侧已由 #205 拿到行数收益），待用户裁决，**本轮
   未动**。
4. 渲染键漂移：batch 行展开的 message segmentId/timeline eventId 自 `ownerKey#(seqStart+i)`
   变为 run 级（`ownerKey#seqEnd` 派生）——与 `turn.unit` delta-run 段约定对齐；会话内
   稳定，跨存储形态不跨读（同一段历史只以一种形态存在）。
