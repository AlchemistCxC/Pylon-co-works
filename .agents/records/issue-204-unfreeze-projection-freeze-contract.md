# Dev Record — #204③ 解冻投影冻结契约（freezeDocument 快路 + legacy 派生门控 + 终态 O(1)）

> 入库保留。规格文档（spec）不保留；目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#204（症状③投影层结构性残留，用户裁决「授权解冻基线并开工」+ 追加「探查 legacy 链，无人使用则删除」）
- 分支：`Ru5t/Reflector`
- 日期：2026-09-22

## 目标与范围

消掉 live 每帧的 O(N) 分配/冻结地板（前轮实测：40k 行文档全路径 76ms/帧，其中 applyDocument
占 76ms − reduce 0.7ms ≈ 75ms）。**不做什么**：不改 `insertBySequence` 的不可变数组拷贝
（每帧一份新数组是渲染引用稳定契约的根，保留）；不动投影语义与幂等判据。

## 审计结论（legacy messages 链）

- **生产无写入者**：P52 D4 后 replay commit 适配器是文档化 no-op
  （`agentWorkbenchLifecycle.replayAdapter`，注释明示）；
- **派生值无有效读取者**：`SolidWorkbenchApp.viewMessages` / `streamingDisplayScheduler`
  的 legacy 分支都是 document 缺席时的 fallback，而 runtime 恒有 document
  （`documentFromLegacy` 构造时物化）；`WorkbenchMessage` 无 tool 角色 ⇒ tool 行合并恒空转；
- **字段本身存活**：预览宿主经 `createWorkbenchRuntime(initial)` / `update({messages})`
  写入 legacy messages 是**输入面**（`documentFromLegacy` 据此物化文档），且预览 fixture
  依赖「文档就位后派生接管 legacy 字段」（fixture 的 3 条消息靠派生覆盖才不与 canonical
  合并成双份）。

**处置**：派生改**按需门控**——`mergeWorkbenchRuntimeSnapshot` 仅当 `previous.messages`
非空（宿主真的在用）才调 `projectLegacyMessages`（带单条消息 WeakMap memo + 源数组级
memo）；生产恒空数组 ⇒ 零派生成本。字段、`documentFromLegacy`、`update()` legacy 路径
全部保留（预览兼容零变化）。

## 关键发现（本轮的性能真凶）

1. **JSC 对大数组 `Object.freeze` 是 O(N) 高成本操作**：40k 行数组单次 freeze 实测
   **18.5ms**（微观探针）。旧 freezeDocument 每帧对 timeline/messages/legacy 三个大数组
   各做一次 `Object.freeze(items.map(...))` ≈ 55ms/帧的主体。
2. **冻结数组转入字典元素模式**：一旦大数组被 freeze，其后每一帧的 `[...]` 拷贝与逐位
   访问都按哈希走（实测同数组遍历退化 ~100×）且**跨帧不恢复**——首帧初始化的那次
   map-fallback 冻结把整个会话的数组永久拖慢。
3. **`Object.isFrozen(未冻结大数组)` 同样是 O(N) 遍历**——任何以它为前置判定的快路
   都会被自己的守卫吃掉。

## 改动

| 文件 | 内容 |
| --- | --- |
| `workbenchProjector.ts` | `freezeDeepSnapshot` 迁入并导出；reduceMessage/reduceReasoning/settle 系列/refreshOrphans 的**新文档项构造点冻结**（O(新项数)）；`insertBySequence` 冻结新时间线条目 |
| `workbenchRuntime.ts` | `freezeItems` 重写为**两遍扫描前缀快路**（稳态 O(N) 指针比对、零克隆、零分配、不冻结大数组；大数组经 `freezeLargeAware` 免整体冻结，≤2048 保持原契约）；替换位与追加位区分（替换位不得凭 isFrozen 跳过——曾引入 optimistic echo 替换失效回归，见下）；legacy 派生按需门控 + `runningStateOf` 无分配单趟；`hasTerminalDocumentState` 由每次 publish 的 O(N) timeline 扫描改 O(1)（终态是投影器吸收态：timeline 终态 session 条目 ⇔ session.status 终态，等价性由吸收态论证 + 套件验证） |

## 测试处置

- **新增断言场景**：无新增文件；`workbenchRuntime.test.ts`「reuses message projections…」
  末段断言改为门控语义说明（宿主非空 ⇒ 派生行为与此前一致）。
- **过程中发现并修复的回归**：freezeItems 首版把「替换位的新冻结项」凭 isFrozen 误判为
  未变化，导致乐观 user 行的 authoritative echo 替换失效
  （`authoritative user echo confirms…` 抓住）——修正为 isFrozen 短路仅适用于追加位。

## 验收结果

- 核心套件（replay + workbench + agent-workbench + solid renderers）：**1758 passed / 0 failed**
- 全量 `npx vitest run`：4660 passed / 7 failed —— 7 例全部位于 `scripts/code-stats.test.mts`
  （他人在途 #231 未跟踪新文件，与本轮无关）；lint 0 error（1 条存量 warning 非本域）；
  `tsc -p tsconfig.solid.json` 绿。

## 性能对照（40k 行文档、100 帧 live 流式，bun 1.4.0）

| 相位 | 解冻前 | 解冻后 | 加速 |
| --- | --- | --- | --- |
| R 纯归约（reduceWorkbenchEvent） | 736µs/帧 | 736–829µs/帧 | 持平（Stage A 已含） |
| A applyDocument（变更文档） | **76,134µs/帧** | **5,941µs/帧** | **12.8×** |
| F applyDocument（同文档地板） | 27,568µs/帧 | **5µs/帧** | ~5500× |
| 全帧（R+A） | 76.7ms | 6.7ms | **~11.6×** |

对 #204③ 立项前基线（c88d4fe9，同口径全路径 44.4ms/帧 @40k）：**~6.6×**。

## 完整基准复测（解冻提交后，与 #226 批次同一 scratch 口径，两次采样一致）

| live 全路径（reduce + apply + publish，每帧 µs） | 基线 c88d4fe9 | 解冻前（Stage A–C 后） | 解冻后 | 对基线加速 |
| --- | --- | --- | --- | --- |
| seed 5k | 4,342 | 3,762 | **99** | ~44× |
| seed 20k | 18,963 | 18,963* | **344** | ~55× |
| seed 40k | 44,410 | 42,894 | **697** | **~64×** |

（*解冻前与基线在同规模处接近——Stage A 消掉的扫描项被冻结/字典退化地板掩盖，
解冻移除地板后归约项的收益才显影。）

| 其余项 | 基线 | 解冻后 |
| --- | --- | --- |
| bind 聚合 20k（batch 1602 行） | 947–1554ms | 272.7ms（~3.5–5.7×，与解冻前持平 ⇒ bind 成本在归一/展开，非冻结） |
| bind 逐 chunk 20k（控制组） | 936–1625ms | 1027ms（持平） |
| bind 堆留存 batch / per-chunk | 23.5 / 14.5MiB | **4.1** / 18.4MiB（持平） |

## 未解问题

1. `insertBySequence` 的每帧 O(N) 数组拷贝仍在（不可变数组的最后一道地板）；稳态每帧
   剩余 ~6ms 中主要是它 + 两遍指针比对 + GC。进一步需持久化数据结构或渲染契约变更，另议。
2. legacy `messages` 字段的长期归宿（预览输入面是否收敛为显式 document 注入）属渲染
   契约演进，另行裁决。
