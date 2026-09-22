# Dev Record — #243 长时间线会话行虚拟化（视口窗口 + 行高表 + spacer）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/243-long-session-row-virtualization.md`

## 元信息

- issue：#243（#240 附六的执行单）
- 分支：`Ru5t/session-virtualization`（自 `Ru5t/renderer-memory-probe` tip `ec56873a` 堆叠新开；主工作树检出被 #245 会话占用，本轮在独立 worktree `../pylon-wt-243` 施工）
- 提交范围：`ec56873a..HEAD`（切片 1+2：`cc71da50`；L.md 开工声明：`ccab75d1`；切片 3+4：`2be0e5db`；切片 5：文档与记录）
- 日期：2026-09-22
- 决策依据：spec `.agents/spec/240-long-session-row-virtualization.md`（D1~D10 已由仓库主裁定；D9 执行方裁定维持 TanStack）

## 目标与范围

让长时间线会话的常驻 DOM 与内存随「视口 + overscan」增长，而不是随历史总行数增长（#240 附六实测：合成 600 行 = 6058 节点；真机 27 行 = 4225 节点 ≈ 156 节点/行）。

**不做什么**（承 issue「不做什么」节）：不动投影（#234）、markdown 解析/graft（#150）、高亮生命周期（#221）、#208 折叠阈值；不改流式代码块「整块驻留」裁决；不引入 virtua 运行时依赖；不做 DOM 层 LRU 保留（D7 改口径）；不做逐行高度预扫。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `chat/rowHeightTable.ts` | 按行 key 的尺寸真值 + 偏移索引（最早脏索引增量重建、二分 indexForOffset、ε 写回、卸载不丢） | 新增 |
| `chat/rowHeightEstimate.ts` | 按渲染类型/内容量/toolOutputLines 的确定性估算；reasoning 折叠封顶（#208）；`estimatedHeight` 缝优先 | 新增 |
| `chat/PlainMessageList.solid.tsx` | 虚拟化集成：阈值/杀停判定、引擎接线（取窗+实测+修正门控）、渲染切片、scrollTo 改造、invalidateMeasurements 接 D5 失效 | 修改 |
| `chat/__tests__/issue243.rowHeightTable.test.ts` | 行高表 9 项单测（含切片 1 验收口径「表算偏移 == DOM 偏移」） | 新增 |
| `chat/__tests__/issue243.rowHeightEstimate.test.ts` | 估算性质 7 项（确定性/单调性/折叠封顶/缝优先） | 新增 |
| `chat/__tests__/issue243.virtualization.solid.test.tsx` | 7 项行为测试（1000 行验收、spacer、双阈值、杀停、scrollTo 邻域、身份、切片 4 计数证明） | 新增 |
| `chat/__tests__/PlainMessageList.solid.test.tsx` | **#212 三条窗口用例按 issue 点名改写**（见下）；其余 13 条原样 | 修改 |
| `__tests__/sessionScale.probe.solid.test.tsx` | `process` 访问窄化（改名后落入 tsconfig.solid 范围，无 node 类型） | 修改 |
| `package.json` / `bun.lock` | `@tanstack/solid-virtual@3.13.40`（依赖 `virtual-core@3.17.11`） | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | §8 聊天渲染层追加虚拟化一段 | 修改 |

## 方案要点

1. **两层尺寸真值**：实测层归引擎（TanStack 按 key 的 `itemSizeCache`，由 `measureElement` 登记的 ResizeObserver 回填，卸载不丢——D7 改口径①的机制载体）；估算层归我方行高表（`rowHeightTable`，内容推导 + D5 失效）。两层只在引擎缓存未命中处经 `estimateSize` 相接，不是双真值。
2. **修正策略**（B3）：TanStack 内建判据（首测 `start <`、重测 `end <=` 视口起点、非上滚途中——#1218 同款）+ 姿态门控（follow 由上层钉底，修正无意义）。
3. **对 issue 目标结构 4 的偏离（已论证）**：issue 写的是「未物化行渲染为等高占位盒」；落地改为**窗外行不驻留 DOM + 容器 spacer（内联 padding）承载几何**。理由：① 同样的几何稳定性（B2：高度取同一张行高表 ⇒ 物化/卸载不改布局总高 ⇒ prepend 免滚动补偿），spacer 以 O(1) 节点达成，占位盒是 O(N)；② DOM 节点从「每行 1 盒」降到 0，更贴合议题的内存目标；③ 避开了 Solid `Show`+函数子表达式在长列表上的整块重建面。D.3.4 的占位符 CSS 随之不适用（未添加）。**若仓库主要求回到逐行占位盒，改动面 confined 到 `rendered()`/JSX 一处。**
4. **scrollTo**：窗外目标走 `scrollToIndex`（自带动态尺寸收敛循环 `scheduleScrollReconcile`）只物化目标附近，替代 #212 的「全开再重试」；`align: nearest` 映射为引擎的 `auto`。
5. **锚定**：#212 S4 自管锚点原样保留且对虚拟化路径成立——锚行恒在窗内（可见行必物化），窗外几何变化经 spacer 反映为真实 DOM 位移，DOM 基准的补偿照常工作（B2 的直接推论）。
6. **失效（D5）**：`invalidateMeasurements(theme/font/container-resized)` ⇒ 引擎 `measure()` 清实测缓存 + 行高表 `invalidateAll` 重估 + spacer 刷新；`items-changed` 是增量口径不作废。
7. **jsdom 适配**：引擎 `getRect` 读 `offsetHeight`（jsdom 恒 0 ⇒ 取窗恒空）、`getMaxScrollOffset` 读 `scrollHeight - clientHeight`（恒 0 ⇒ scrollToIndex 钳到 0）——测试夹具以 `Object.defineProperty` 补 `offsetHeight/scrollHeight/clientHeight`；`measureElement` 对零几何元素跳过（`node.offsetHeight > 0` 守卫），防零尺寸毒化缓存。
8. **For cell 陷阱（后来者注意）**：Solid 的 `For` 回调**是追踪作用域**——回调体内直接读信号（哪怕只为分支判断）会让整块 JSX 在每次信号写入时重建（DOM 身份断）。本轮踩过：`virtualActive()`（读 rows/charsTotal）在 cell 体内被追踪，setItems 即全列表重建。修法=cell 主体 `untrack` 包裹，重渲染交给细粒度效应。

## #212 三条窗口用例改写说明（issue 验收点名）

| # | 原用例 | 改写后 | 理由 |
| --- | --- | --- | --- |
| 1 | `#212 S3b：冷开时按窗口渐进挂载（尾部优先），逐帧扩满` | `#243：冷开长会话只物化尾部有界窗，其余为占位盒；窗口随滚动步进（D2）`（强制 `virtualization="on"`，100 行） | 长会话窗口语义从「尾部只增」改为「视口窗口」；「尾部优先」由上层贴底姿态钉 scrollTop 实现；「逐帧扩满」与虚拟化目标相反，删除 |
| 2 | `#212 S3b：增量增长不缩窗（小列表整挂）` | `#243：短会话（低于阈值，legacy 路径）整挂且追加不缩窗`（断言原样） | 语义实际未变（3 行低于阈值走 legacy），仅标题归位以点明路径归属 |
| 3 | `#212 S3b：换代中途挂起的扩窗不得按旧会话行数收敛` | `#243：换代把窗口收敛到新会话尾部，不按旧会话规模扩满`（强制 `virtualization="on"`，100→300 行） | 虚拟化路径没有「挂起的扩窗」，但同一威胁换形态：换代必须把窗口收敛到新会话尾部有界窗，不得沿用旧会话滚动位置/规模 |

## 验收标准与结果

- **既有行为测试全绿且未修改**：`issue55.rowSetPurity`、`issue148.parseLatestWins`、`issue150`、`issue208`、`issue221.codeBlockLifecycle`、`mountSolidWorkbench`（含 DOM 身份断言）原样通过（renderers+domains 1770 用例；全量 627 文件 / 4702 用例绿，1 skipped=探针默认跳过）。
- **门禁**：`tsc -b` 绿；`lint` 绿；`check:solid` 绿；`check:frontend:static` 绿（CI 同款全链）。
- **例外点名**：即上表三条 #212 用例（理由见上）。
- **1000 行会话**：物化行 ≤ 视口 + 2×overscan（jsdom 300px 视口实测 20）；滚到顶自动增量回卷（窗口随滚动步进）；scrollTo 命中占位区只物化目标附近。
- **短会话逐字节不变**：既有 13 条非改写用例（含 S4 锚点、#213、viewport state）原样绿即判据。
- **切片 4**：markdown LRU 计数证明——往返一趟 `parsed` 零增长、`cacheHits` 增长（重挂载零解析）；高亮缓存（128 条）机制同源、读数接口未暴露，由 #221 既有测试覆盖。

## 遗留与后续

1. **切片 0 真机标定未做**：阈值（300 行/100k 字符）与 overscan=8 为 jsdom 读数推的保守默认，**待真机复验后修正**（D8 已授权临时改实例 `agents.yaml` 喷合成长会话；同一装置复跑启用前后对照 DOM 节点/渲染器 private/JS 堆/long task）。本机 G 盘接近满、且本轮未走实机验收流程，建议下轮在真机装置上补齐后回填本记录与阈值。
2. 高亮缓存（128 条）读数接口未暴露，「不重高亮」暂由 markdown LRU 计数 + #221 既有测试间接覆盖。
3. `virtualization="auto"` 的阈值跨越无迟滞：会话行数在阈值附近抖动时会整体切换渲染分支（语义正确，成本一次全量挂载）。真机标定时一并观察。
4. PR 与 #242（同支前驱 docs PR）为堆叠关系：本 PR 合入前需先合 #242。
