# Dev Record — #301 #243 窗口收敛用例偶发红：夹具的假滚动几何不忠实

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/301-fixture-scroll-geometry.md`

## 元信息

- issue：#301（bug(test)，渲染器线；由 @AlchemistCxC 报告，本轮认领）
- 分支：`kumo/prometheus`
- 提交范围：`5c1d9caa`（L.md 声明）→ 本轮夹具提交
- 日期：2026-09-24

## 目标与范围

**目标**：`PlainMessageList.solid.test.tsx` 的「#243 换代把窗口收敛到新会话尾部」用例在任何并行度/帧调度下稳定绿，且判定不依赖"断言跑在按帧批处理的几何重测之前"。

**不做什么**：

- **不改产品代码**。`PlainMessageList.solid.tsx` 的 `measureScrollMargin`
  （`container.top − viewport.top + scrollTop`）在真实几何下是正确的，本轮一行未动。
- 不给用例加"等 N 帧再断言"的永久等待。等待只是把赛跑往后推，且把用例耦合到内部帧调度；
  正确做法是让夹具不再制造错误状态。
- 不引入引擎侧补丁、不改 `@tanstack/*` 依赖与 `messageListPort.ts` 契约。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/renderers/solid-workbench/chat/__tests__/PlainMessageList.solid.test.tsx` | 新增夹具 `mountVirtualizedList`（含 `rectOf` 上提）；两条 #243 窗口用例改用它 | 修改 |
| `src/renderers/solid-workbench/chat/__tests__/issue243.virtualization.solid.test.tsx` | `mountScroller` 补 `rectOf`/`mountList`；7 处挂载改走 `mountList` | 修改 |
| `.agents/L.md` | #301 在途声明；顺带摘除已合入的 #212+#213、#243 旧条目 | 修改 |
| `.agents/records/301-fixture-scroll-geometry.md` | 本文件 | 新增 |

`docs/说明书/` 零改动——全仓 grep `scrollMargin` 在该目录无命中，无漂移面。

## 方案要点

### 机制（本轮实测查清）

引擎（`@tanstack/virtual-core@3.17.11`）的 `scrollMargin` 口径是：**烘进 measurements 的
`start`**（`paddingStart + scrollMargin`），而 `calculateRange` 直接用**原始 scrollTop**
在这些 starts 上二分（`findNearestBinarySearch`）。因此两者必须一致——`scrollMargin` 必须等于
「列表在滚动内容流里的偏移」。

组件按设计（D.3.1「实测不写死」）在每次 `setItems` 后重测该偏移：

```
scrollMarginPx = container.getBoundingClientRect().top − viewport.getBoundingClientRect().top + viewport.scrollTop
```

- 真实浏览器：内容随滚动上移（`container.top = viewport.top − scrollTop + 内容偏移`）⇒ 上式 = 内容偏移 ✓
- 夹具把 scroller 矩形写成**常量**、容器是 jsdom 零矩形 ⇒ 上式 = `scrollTop`（用例里 99999）
  ⇒ 引擎把"已在尾部的滚动位置"当成"列表开头"⇒ 窗口跳到 `b0…b11`，尾行永不物化。

**为什么时红时绿**（比 issue 描述的更绕一层）：`scrollMarginPx` 是**普通变量**，而 Solid 适配器
只在 `createComputed` 重跑（`rows()/count` 等变化）时才 `setOptions`，且 `setOptions` 会
**快照** `scrollMargin`。于是"污染"要落成错误窗口，需要两个条件同时满足：

1. 被按帧批处理（`createFrameTask` → rAF）的重测跑在了断言/下一次行集变化之前，把 margin 写成 99999；
2. 之后适配器又把 options 重推给引擎（下一次 `setItems`）。

条件 1 的落点本身就是竞态 ⇒ 修复前同一台机器上"隔离跑多轮偶红、并行全量约每 2 轮红 1 次"。
这也解释了 issue 探针 A′（只"等 3 帧"）在本机**不**稳定红：它只拉长了条件 1 的窗口，条件 2 仍靠运气。

### 修法

夹具几何改忠实，采用 issue 建议里"更忠实"的那条（容器随滚动移动），与同文件 `mountInScroller`
既有口径一致（"列表容器**随内容一起平移**，生产的真实几何"）：

- 视口盒矩形恒定（真实浏览器：视口不随滚动移动）；
- 列表容器矩形随 `scrollTop` 上移：`rectOf(-scrollTop, 300 - scrollTop)`，且**读取时**取当前
  `scrollTop`，故几何在整条用例期间都成立，而不是只在桩建立那一刻。

margin 由此恒等于真值 0 ⇒ 任何帧序都取到同一窗口，不再存在"跟夹具造成的错误状态赛跑"。

`issue243.virtualization.solid.test.tsx` 里把「渲染 + 接几何」收到 `mountList` 一个入口，
而不是让每个用例手动补一行——"忘记接几何"这种回归在结构上不可能发生。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 修复前：干净用例隔离跑即会红 | 4 轮 1 红（本机） |
| 修复前：确定性红（同手法） | 常量矩形 3/3 红，读数与 issue 探针 A′ **逐字节一致** |
| 修复后：同手法必须稳定绿 | 忠实矩形 3/3 绿，且 spacer 数值自洽 |
| 修复后：干净用例隔离跑 10 轮 | 0 红 |
| 修复后：全量并行 4 轮 | 4 轮全绿（末轮为冻结提交内容） |
| `eslint` 两个改动文件 | 通过 |
| 类型检查 `tsc -p tsconfig.solid.json` | 退出码 0 |

**验收探针（一次性，不入库）**：`setItems(b)` 前等 3 帧 → 再喂一次 `setItems(b)`（行集变化逼适配器
把 options 重推给引擎）→ 断言。第二喂步骤是本轮加的：它把"条件 2"也固定下来，于是回退夹具必红、
修复夹具必绿，两侧读数如下（`scrollTop` 全程 99999）：

```
常量矩形（修复前状态）  : {"ids":["b0"…"b11"], "style":"padding-top: 0px; padding-bottom: 21888px;"}
忠实矩形（修复后）      : {"ids":["b291"…"b299"], "style":"padding-top: 22116px; padding-bottom: 0px;"}
```

`22116 = 291 × 76`、`padding-bottom: 0`：spacer 已回到**列表局部坐标**，即几何自洽的签名；
修复前那两个数（0 / 21888）正是 margin 被算成 `scrollTop` 的产物。

## 测试处置

**没有新增/删除用例，断言一字未改**；两条 #243 窗口用例的挂载改为共用夹具：

| 用例 | 处置 |
| --- | --- |
| `#243：冷开长会话只物化尾部有界窗…（D2）` | 挂载改用新增的 `mountVirtualizedList`（原内联夹具删除）；断言原样 |
| `#243：换代把窗口收敛到新会话尾部…` | 同上；断言原样 |
| `issue243.virtualization.solid.test.tsx` 7 处挂载 | `render(..., { container: scroller })` → `mountList(...)`（多一层几何绑定）；断言原样 |
| 同文件「杀停开关」用例 | **不动**：它挂到 `host`（虚拟化停用），无滚动几何消费方 |

## 证据

- commit：`5c1d9caa`（L.md 声明，单文件）、本轮夹具提交（见 PR）
- 测试（`bunx vitest run`）：
  - 两文件合跑：`Test Files 2 passed (2)` / `Tests 24 passed (24)`
  - 干净用例隔离跑 10 轮：0 红
  - 全量并行 4 轮：每轮均为 `Test Files 642 passed | 1 skipped (643)`、
    `Tests 4860 passed | 1 skipped | 1 todo (4862)`，0 失败（前 3 轮 ≈ 118–131s，冻结态那轮 107s）
- 静态门禁：`tsc -p tsconfig.solid.json` 退出码 0；`eslint` 两个改动文件无输出
- 手工验证（一次性探针，读数见上表；探针已移除，不进提交）：回退夹具 3/3 红 → 忠实夹具 3/3 绿

## 与 spec 的偏差

issue 给了两条等价修法，本轮选"更忠实"的一条（容器随滚动移动），未用"把视口 top 写成 +scrollTop"
的等价算术——理由是后者会让视口盒矩形随滚动移动（真实浏览器不会），与同文件 `mountInScroller`
既有口径相反，读者容易误读坐标系。

issue 的验收判据 2 说"改回常量矩形 ⇒ 同一手法必须稳定红"。实测：issue 原手法（只等 3 帧）
在本机**只能偶发红**（1/2），因为条件 2 未固定；本轮把手法补成"等 3 帧 + 再喂一次 `setItems`"后，
回退态才稳定红。判据本身达成，但需要比 issue 描述更强的触发步骤。

## 未解问题

- **同款"常量矩形"夹具的其余两处，本轮未改**（issue「同类风险」表点名但未要求）：
  - `PlainMessageList.solid.test.tsx` 的 `读取 viewport state` 用例（容器/行矩形用于
    `getViewportState` 的**相对坐标**，自成一套口径，不是滚动几何）；
  - 同文件 `mountInScroller`（scroller 常量矩形 + 容器随 `contentShift` 平移；用例内 `scrollTop`
    只在锚点补偿后变化，且虚拟化未启用、无重测消费方）。
  两者本机未观测到红，改动会让其坐标口径含义漂移，故留原样——若将来在这两处加了"滚动后再
  `setItems`"的步骤，需按本记录口径补容器随滚动的矩形。
- `mountScroller` 目前只表达"容器随滚动上移"，不含 leading 内容偏移；需要时再补 contentOffset。

## 并行交集

- `src/renderers/solid-workbench/chat/__tests__/PlainMessageList.solid.test.tsx`
- `src/renderers/solid-workbench/chat/__tests__/issue243.virtualization.solid.test.tsx`
- `.agents/L.md`（在途声明，完工即撤）
