# Pylon 连续同种工具调用聚合施工书

> 状态：施工中（调查完成，Slice A/B/C 完成）
> 对应问题：[P4 · 连续同种工具调用聚合](Pylon-问题台账.md#p4)
> 范围：Workbench activity projection、工具卡展示、活动排序与展开状态

## 1. 施工目标

将同一时间线上相邻且语义相同的工具调用收敛为一个可展开的组，减少重复标题和状态占用；组内每次调用仍保留独立事实、输入、输出、错误和生命周期，不改变 canonical event、activity node 或父子关系。

## 2. 现状证据地图

| 层 | 入口 | 当前行为 |
| --- | --- | --- |
| 事实/投影 | `src/domains/workbench/workbenchProjector.ts` | `reduceTool` 以 `toolCallId` 为键，一次调用一个 `WorkbenchActivityNode`；同 id 的 started/update/completed 合并，终态吸收迟到事件 |
| 排序/连接 | `selectActivityDisplayOrder`、`deriveCanonicalToolConnectorSources` | 按 parentId/parentToolCallId 组织树；平铺工具只在同一 segment 内连相邻节点；非 tool activity 是硬边界 |
| 展示 | `CanonicalActivityList`、`SolidToolInvocationCard`、`SolidToolCard` | 每个 activity 独立渲染为一张卡；折叠 presenter 以单次调用 id 为 reset key，未提供组级视图 |
| 状态 | `createCollapsiblePresenter` 及各卡片本地 signal | 展开状态是渲染实例本地状态，未写入 WorkbenchDocument、journal 或 session store；回放重建后不会持久化展开选择 |

## 3. 调查结论

- 当前没有“同类调用被错误合并”的生产路径：事实 identity 仍严格使用 `toolCallId`，不能以工具名覆盖或合并节点。
- “连续”必须以展示序列为准，而非 `document.activities` 原始数组或事件到达顺序；应先调用 `selectActivityDisplayOrder`，再在每个消息锚点 segment 内分组。
- 分组键应来自 normalized identity：优先 `canonicalName`，回退 `toolKindWire`、`providerName`；仅名称相同但 `parentToolCallId` 不同的嵌套节点不得跨父节点合组。
- activity、interaction、message 和不同 parent tree 分支均为硬边界；终态失败/取消不阻止同组已完成调用展示，但跨边界调用不能因状态相同合组。
- 组是派生视图，不应写回 `WorkbenchActivityNode`。建议增加纯函数 `groupAdjacentToolActivities`，输出 `{ groupId, toolKey, items, count, summary }`，组内 items 仍引用原节点。
- 组级与单次级展开状态需要独立、可丢弃的 UI state；第一切片可先以内存 signal 按 `groupId` 管理，后续再评估 session-scoped 持久化，避免把显示偏好混入事实 journal。

## 4. 实施切片

### Slice A：纯分组 seam

- 定义稳定 `toolKey`、segment 边界和 parent 边界。
- 编写 `groupAdjacentToolActivities` 及 property/fixture 测试：同类相邻合组、异类/插入消息/不同 parent 断组、单次字段完整保留、回放顺序稳定。

### Slice A（已完成）

- 新增 `src/domains/workbench/activityGrouping.ts` 纯函数：按 normalized identity（canonicalName → toolKindWire → providerName → title）分组，仅处理已排序 segment；非 tool、key 或 parent 变化均断组。
- 分组只引用原始 activity 节点，保留每次调用的输入、输出、错误和生命周期；测试覆盖同类合组、硬边界、身份优先级及 mixed 状态。

### Slice B：组级展示

- 在 `CanonicalActivityList` 增加组行；组行显示工具名、调用次数和状态摘要。
- 组展开显示既有 `SolidToolInvocationCard`，单次折叠逻辑保持不变；连接线仍以单次节点 id 注册。

### Slice B（已完成）

- `CanonicalActivityList` 按消息锚点 segment 调用分组 seam；多次相邻同类工具默认收敛为组行，展开后逐次复用既有卡片。
- 组行不改 activity 节点和 connector key；样式沿用 terminal-like 间距 token，单次工具仍由原卡片负责折叠。

### Slice C：展开状态与回归

- 组级状态按 `sessionId:groupId` 隔离，session 切换/回放重建时清理；不修改 canonical/journal schema。
- 覆盖 live/replay/restart 顺序、终态幂等、父子活动、未知工具名及缺失 identity；过时的“按数组相邻即连续”测试应删除或改为展示序列契约。

### Slice C（已完成）

- 组级展开状态由 `CanonicalActivityList` 按 `sessionId:groupId` 管理；切换 session 时清空，活动事实和 journal 不受影响。
- 组内单次卡片继续使用各自 activity id 注册 connector；目标 renderer、分组 seam 与 Solid 架构门禁回归通过。

## 5. 兼容性、性能与回滚

- 不改变 `WorkbenchActivityNode`、`toolInvocationSnapshot`、connector layout port 或 ACP wire schema。
- 分组为 O(n) 单次派生，组成员不复制大 payload；默认不展开组，避免大量工具输出同时挂载 DOM。
- 若组级展示回归，可停用 group row 并继续渲染原始 `selectActivityDisplayOrder`，事实投影和单次卡片无需回滚。

## 6. 验收标准

- 同一 segment 内相邻、同 `toolKey` 且同 parent 的调用显示为一组，并准确显示 count；任一调用的输入、输出、错误和状态仍可单独查看。
- 插入消息/interaction、工具 key 变化、parent 变化或跨 segment 时必定断组；canonical/replay/restart 得到相同组结构。
- 组级展开不改变 connector 边、activity identity 或终态幂等；展开选择不进入事实持久化。
