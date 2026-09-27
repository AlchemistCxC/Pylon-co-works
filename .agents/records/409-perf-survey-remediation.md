# Dev Record — #409 前端性能勘探清偿批次（A 连接线 / B 行高表失效口径 / C 投影 O(A) / D P2 清单）

> 入库保留。issue：**#409**（本 issue 即勘探报告的操作化子集）；规格（不入库）：`.agents/spec/409-perf-survey-remediation.md`。

## 元信息

- 日期：2026-09-27
- 分支：`kumo/prometheus`（随共享分支 PR 走）
- 勘探底稿：双线调查（数据层 + 视图层，A/B 两项经第二轮逐文件深化复核），与 #375/#376/#380/#234/#243/#221 既存边界核对无重叠

## 交付

### A · 工具连接线（`ToolConnector.solid.tsx` / `toolConnectorLayoutPort.ts` / `CanonicalActivityList.solid.tsx` / `solidWorkbenchProjectionSupport.ts`）

1. **边活性模型**：layout port 新增 `hasToolAnchor` / `membershipRevision` / `onMembershipChange`（register/unregister 即 bump + 同步通知）。`SolidToolConnectorLayer` 的边集 effect 按「两端锚点都在注册表」过滤——虚拟化窗外/渐进挂载窗外的边**不建 DOM、不注册 connector、不参与 measure pass**，滚动自动跟随。锚点注册表（tools Map）本就随行挂载/卸载增减，边集由此从「会话全部工具消息」收窄为「可测量集合」。
2. **transition 监听收窄**：`transitionrun/transitionend` 增加 propertyName 过滤（布局类属性白名单：width/height/margin*/padding*/inset*/flex*/grid*/gap/transform 等 + `all`）；颜色/透明度/阴影类 hover 过渡不再驱动 8 帧全量测量窗。
3. **syncObserved 增量化**：`.term` 级 MO 回调改为按 MutationRecord 增量 observe/unobserve（addedNodes `matches(SEL) ?? querySelectorAll(SEL)`，removedNodes 反向扣除），删除每批突变 O(全部行) 的全量重扫；初始挂载保留一次全量同步。
4. **活动槽位 MO 删除**：每槽位一份的 MutationObserver 是 layer 级 `.term` MO（childList+subtree）的超集，整删（`CanonicalActivityList`），失效源不丢。
5. **placement 二分化**：`selectActivityTimelinePlacement` 从每活动线性扫全部消息（O(A×M)，随每次发布重算）改为序列收集一次 + 每活动两次二分（上界定最大前序、下界回平 sequence 首现）。**等价性差分测试**：改造前线性和算法为 oracle，固定边界 + 400 轮随机对拍逐项一致（`issue409.activityPlacementEquivalence.test.ts`，7 用例）。

### B · 行高表失效口径（`PlainMessageList.solid.tsx` / `rowHeightEstimate.ts`）

1. **RO 按 entry.target 分流**：container 仅在 **contentRect 宽度**变化（ε=0.5px）时走 `container-resized` 全量失效。此前行/容器两条 entry 都落全量失效——container 自身也被观察且行高和=容器高，流式行增高必然级联出 container 条目 ⇒ 每发布清一次引擎 itemSizeCache、在挂载行全体重测、index 漂移 cell 重建。宽度收窄后高度级联不再作废实测（D5「容器变化」的本意是影响换行的几何）。
2. **`estimateRowHeight` WeakMap memo**（键=消息对象，冻结且引用稳定）：引擎 `measure()` 清缓存后对全部 item 重跑 estimateSize，每次全量失效曾对每条消息重扫整段正文（换行 + 围栏两次线性扫）。
- 测试：RO 夹具升级为带 entry 构造；新增宽度基线/宽度变化失效/行条目不失效/纯高度不失效四条口径断言（`PlainMessageList.solid.test.tsx`）。**修正深化轮一处口径**：heightTable 在生产从不接收实测值（`heightTable.measure` 零生产调用方，实测真值在引擎 itemSizeCache），故 `invalidateAll` 的逐行重估实际不触发——O(内容字节) 成本走的是 estimateSize 重估路径；两处修复分别对症。

### C · 投影核 O(A) 清尾（`workbenchProjector.ts`）

- `ProjectionContext` 增 `activityIds: Map<id, index>`（入口建一次、主循环随追加补录；activities 只尾部追加/原位替换/保序保长 map——三个生产者 upsert/refreshOrphans/settleUnsettledTools 均满足）。
- `reduceTool`/`reduceActivity` 的 `activities.find` O(A) → 索引 O(1)（`previousActivityOf`；单事件路径回退线性，语义不变）。
- `upsertActivity` 接 context：draft 就地替换/追加（#234 updateTimeline draft 同据：批内数组独占），替代每 tool tick 的整表 map 复制；`hasParentActivities` 置位门让「文档无带 parentId 活动」时整跳 refreshOrphans 的 O(A) 探测（其恒等返回路径）。
- 孤儿 id 集合的增量门从「引用变化」扩为「引用或长度变化」（就地追加时引用不变但长度增长）。
- `toolInvocationSnapshot` 加 `WeakMap<activities数组, Map<id, node>>`：数组每 tick 重建一次，M 个渲染卡每拍 O(A) find 变为每 tick 一次 O(A) + M 次 O(1)。
- **验收读数**（`bun run perf-bench` projector 域，mixed-m 2251 事件）：**13.49 → 12.14 µs/事件**（中位总时长 25.59 → 23.60ms）；行为测试零修改全绿（`workbenchProjector.test.ts` 31 用例 + 全量套件）。

### D · P2 清单

| 项 | 处置 |
| --- | --- |
| ① RuntimeSheetView | `mergeRuntimeLogs` 加「incoming 全新于 existing」快路径（免整表 Set+sort；形状不符回退原路径）；视图加 300 条渲染窗口 + 「显示更早」分页（存储上限 1000 不变） |
| ② RendererSlotHost | 引用门重排 + appearance 稳定键按宿主快照引用缓存——流式 tick（node/payload/宿主快照引用均未变）零 stringify；键只在真要 apply 或快照变化时计算 |
| ③ markdown 渲染模型缓存 | `mountSolidWorkbench` 的 `destroy()` 调用 `clearMarkdownRenderModelCache()`（页签关闭即释放；多页签保活下不做会话切换清，避免误伤他页签热缓存） |
| ④ AnsiBlock | `title`/`aria-label` 截断 2k 字符 + `…`（正文渲染不走属性） |
| ⑤ ToolObjectInspector | 根层条目 >200 窗口化（+「还有 N 条未显示」），子层递归不受限 |
| ⑨ pluginProcessClient | `dispose()` 清 `earlyEvents`（原按 processId 只增不减）；base64 解码循环保留（量级可接受） |

### 裁决不做（如实记录）

- **D⑥ 流式调度器 Map 族 / D⑧ canonicalEventSink 每 chunk 全量重合并**：实机记录口径流式速率 ≈14 chunk/s（84s/1162 chunk），sink 窗口内 O(P²) 实测 ≈200 ops/s、调度器 publishCost.maxMs 19.1ms 在帧预算内——为两项引入持久化/契约区（R1d、判据 A/C）的增量维护复杂度不成比例。留观：若未来 chunk 速率上数量级再立项。
- **CSS 三项**（`index.css` body::before / titlebar grid 动画 / chat-blur）：`index.css` 与 `App.css` 属 #407 在途域（避让），且属设计性基线需产品口径。
- **休眠热点**（`getViewportState` 全行 gBCR、单事件 `reduceWorkbenchEvent` 的 O(E²) includes）：生产无调用方，仅注记——首个调用方出现前不施工。

## 门禁

- `bun run test`：**662 文件 / 5111 用例通过**（1 skipped / 1 todo 既有）。
- `bun run lint`：0 error（1 warning 为 `GatewaySheetView.tsx` 既有项，非本批文件）。
- `tsc -b`（经 test/build 前置）干净；本批无 Rust 改动，clippy 门不涉及。
- 新增测试：placement 等价差分 7 用例；PlainMessageList 新口径断言组。

## 避让与并行

- 避让 #407（`src/index.css`、`builtin.pylon-shell/App.css` 等在途 CSS/界面模式文件）、全部 `src-tauri/**`（`src-tauri/Cargo.toml` 在途脏文件未触碰）、`_*.py`/`_research/` 无主文件。
- 提交一律 pathspec；`[Codex]` 会话在 L.md 追加条目（其后入），互不冲突。

## 遗留

- 深化轮误判更正已回写（heightTable 实测值路径），见 B 节——后续如有人给 heightTable 接实测回填，`invalidateAll` 的重估路径才开始生效，estimateRowHeight 的 WeakMap 已顺带覆盖。
- 多页签 keep-alive 无上限属产品裁决（#375 记录遗留 4），本批未动。
