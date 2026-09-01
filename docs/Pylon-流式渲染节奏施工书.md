# Pylon Solid 流式渲染节奏施工书

> 状态：施工中（首片）  
> 范围：AgentSheet 的 Solid Workbench renderer  ️  
> 日期：2026-08-29

## 1. 施工目标

在不改变 Agent 事实流、canonical journal 或 Workbench projector 语义的前提下，给 Solid renderer 增加一个显示节奏层：

1. 对高密度流式更新设置明确的显示更新上限（默认 30 次/秒）。
2. 对新增文本按 Unicode grapheme 的小粒度逐步追赶（默认约 120 个 grapheme/秒，单次 tick 有上限），避免一批 token 在同一帧内突然涌入。
3. 终态、会话切换、快照替换和错误状态立即 flush，保证不丢字、不停在半截。
4. 原始 runtime 继续即时接收完整快照；节流只发生在 `mountSolidWorkbench` 给 Solid 树的快照消费边界。

## 2. 调查结论（现状证据）

### 2.1 实际生产链路

```text
ACP / Kernel event
  → chatEventController（归一、canonical 落盘、发布）
  → agentWorkbenchSession（reduceWorkbenchEvent）
  → WorkbenchRuntime（完整 document snapshot）
  → mountSolidWorkbench（当前直接 setRuntimeSnapshot）
  → SolidWorkbenchApp / PlainMessageList / MarkdownContent
```

- `src/sheets/agent-workbench/agentWorkbenchSession.ts` 的 `applyLive` 将每个 canonical envelope 立即投影到 runtime。
- `src/domains/workbench/workbenchRuntime.ts` 通过浅字段比较避免无关深序列化，但每次 `streamingText` 或 `document` 变化仍会通知订阅者。
- `src/renderers/solid-workbench/mountSolidWorkbench.solid.tsx` 当前订阅回调直接 `setRuntimeSnapshot(services.runtime.getSnapshot())`，没有频率闸门。
- `src/renderers/solid-workbench/SolidWorkbenchApp.solid.tsx` 将快照中的 `document.messages` 转为行描述符；正在增长的文本最终进入 `MarkdownContent.solid.tsx`。后者已有 stable-prefix/unstable-tail 增量 Markdown 管线，因此适合接收小步长文本。

### 2.2 为什么不能在 reducer 或 canonical 层节流

- reducer/canonical 是事实与恢复路径，延迟或丢弃事件会破坏 replay、journal 顺序和跨 renderer 一致性。
- Solid renderer 之外还有命令、搜索、活动状态和未来的其他 renderer 消费 runtime；显示节奏不应污染这些消费者。
- 因此采用“raw runtime 即时、display snapshot 节流”的单向 seam。

### 2.3 需要特别处理的形态

- canonical 流式文本主要表现为 `document.messages` 中 `running` 的 assistant/reasoning 消息增长；旧兼容/预览路径仍可能使用 `snapshot.streamingText` / `streamingThinking`。
- Workbench message 同时带 `content` 与 `parts`。只截断 `content` 会让 semantic Slot 仍显示完整 parts，故 partial display 必须同步提供安全的文本 parts（完成时恢复原 parts）。
- `PlainMessageList` 已按 key 保持行实例，细粒度内容更新不会重建整棵列表；`MarkdownContent` 已按 stable block 复用解析结果。
- sheet 可暂停。后台不应继续消耗定时器；恢复时应以最新 raw snapshot 一次收敛。
- 文本可能包含中文、emoji、组合字符；不能按 UTF-16 code unit 截断。

## 3. 设计契约

### 3.1 显示调度器

新增独立的 `streamingDisplayScheduler`（纯 TypeScript、无 React/Solid 依赖），输入 `WorkbenchRuntimeSnapshot`，输出供 Solid signal 使用的 display snapshot：

- `push(snapshot)`：接收最新 raw snapshot，保留 latest-wins 目标。
- `flush(snapshot?)`：立即发布完整目标并清除积压。
- `pause()` / `resume(snapshot?)`：暂停后台 tick，恢复时重新对齐。
- `dispose()`：取消 timer，释放闭包。

调度器只复制发生显示变化的 message/document 外壳，不改写传入的 runtime 对象。

### 3.2 节奏参数（首片默认值）

| 参数 | 默认值 | 说明 |
| --- | ---: | --- |
| `maxUpdatesPerSecond` | 30 | renderer signal 的硬上限；不追求高于普通屏幕刷新率 |
| `revealUnitsPerSecond` | 120 | 文本追赶速度，约 4 grapheme/tick |
| `maxRevealUnitsPerTick` | 12 | timer 被后台拖延时的单 tick 上限，防止突然大跳 |
| 终态 flush | 立即 | done/error/非 running 完成快照不得停在半截 |

参数先作为模块常量/可选构造参数，不新增用户设置；后续有真实 trace 后再决定是否暴露到 Presentation Profile。

### 3.3 逐步投影规则

1. 同一 message id、同一 role 且目标内容以当前显示内容为前缀时，只追加有限 grapheme。
2. 新出现的 running assistant/reasoning 行从空前缀开始逐步显现；用户行、工具行和非流式历史行不做逐字动画。
3. 目标发生非前缀修订、会话/owner/generation 改变、消息被删除或重排时，视为 hard reset，直接采用目标快照。
4. partial assistant/reasoning message 的 `parts` 改为与可见前缀一致的安全文本 part；目标完成后恢复 canonical parts，避免 slot 泄露尚未显示的尾部。
5. `streamingText` / `streamingThinking` 兼容字段使用同一前缀算法；终态为空或生成结束时完整 flush。
6. 所有非文本字段（tool 状态、任务、错误、usage、appearance 无关字段）取最新目标；若同时有文本积压，随下一允许 tick 一并发布。

### 3.4 预览与生产

预览 fixture 依赖“调用即可观察”的确定性断言，首片允许 `input.preview === true` 时旁路节奏层；生产 AgentSheet（`preview: false`）始终启用。这样不会改变现有 smoke fixture 的语义，同时真实浏览器/桌面路径得到同一套节奏行为。

## 4. 实施切片

### Slice A：纯调度 seam

- 新建调度器与快照局部投影函数。
- 提供 Unicode 安全的小粒度追加、前缀失配 hard reset、终态 flush、timer 清理。
- 不触碰 Workbench projector、canonical sink、React ChatView。

### Slice B：Solid mount 接线

- 在 `mountSolidWorkbench` 的 runtime subscription 处替换直接 set 为 scheduler `push`。
- `pause()` 取消 tick；`resume()` 取 runtime 最新快照并 flush/重新排程。
- `destroy()` 先 dispose 调度器，再解除 runtime subscription。

### Slice C：可观察性与兼容

- 保留 runtime 的 revision/owner/generation；display snapshot 只改变可见文本，不改变事实身份。
- 必要时在开发诊断中记录每次 flush 原因（terminal、session-switch、prefix-reset），不向用户显示。
- 预览旁路逻辑写入施工注释，避免后续误以为 scheduler 未生效。

## 5. 验收标准

### 功能

- 连续快速推送 100 个文本快照时，生产 Solid signal 更新次数不超过约定上限（允许 timer 精度造成的一个边界 tick）。
- 每个中间显示快照的文本是 raw 目标的合法前缀；最终快照与 raw 完全一致，包含 semantic parts、工具状态和错误字段。
- `done`、`error`、会话切换、replay/canonical replace、非前缀修订均在下一次同步中完整可见。
- emoji、组合字符和中英文混排不会出现半个 surrogate/组合序列。
- 从后台 pause 回到 active 不丢积压，且只收敛到最新 raw 快照。

### 流式与完成态几何一致性（紧急修正）

- 同一段 Markdown 在流式显示和终态显示时，正文行高使用同一条消息行变量；不得由 `.term-plain-text` 的固定 `line-height` 覆盖预设。
- 稳定块提交时，结构性的空行分隔符只由块间距规则表达一次；不得在 `pre-wrap` 文本中再次变成额外空行。
- 在默认及自定义消息行高下，流式中间态与完成态的 `scrollHeight`/边界高度应一致（允许浏览器亚像素舍入误差），且不出现“生成时行距过大、完成后收紧”的跳变。

### 性能

- 不在每个 tick 对完整历史做 JSON stringify；历史 message 引用保持共享。
- 单次文本追加只扫描本 tick 预算的 grapheme；Markdown 继续走现有 stable-prefix 增量管线。
- timer 在无积压、pause、destroy 后均清零，不产生后台循环。

### 兼容

- 不改变 canonical journal、replay、命令和 Workbench Host Port 契约。
- Solid boundary check、类型检查、现有 build 通过；不新增依赖、不写新的测试文件。

## 6. 风险与回滚

| 风险 | 处理 | 回滚点 |
| --- | --- | --- |
| 大块目标文本追赶过慢 | 120 grapheme/s + 每 tick 上限；终态强制 flush | 删除 mount 接线，保留纯工具不启用 |
| semantic parts 与 content 不一致 | partial 时使用安全文本 part，terminal 恢复目标 parts | 关闭 partial parts 投影，改为整快照 flush |
| session switch 迟到快照串入 | owner/generation/session identity hard reset | scheduler `flush` 作为唯一切换路径 |
| 后台 timer 泄漏 | pause/dispose 清理 timer，并在 resume 取最新快照 | 旁路 scheduler |
| 预览断言时序变化 | preview 旁路 | 仅生产启用 |

## 7. 本片完成定义

当 Slice A/B 接线完成、生产路径可证明“raw 完整 + display 有上限 + 终态无残留”，并通过既有 Solid 类型/架构检查后，第 1 项首片完成。后续可依据真实 trace 调整速率参数，再考虑是否将速率作为 Presentation Profile 的可选表现令牌；本片不提前扩张设置系统。
