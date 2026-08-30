# Pylon terminal-like 块间距统一施工书

> 状态：待施工（调查完成）  
> 对应问题：[P2 · terminal-like 块间距统一](Pylon-问题台账.md#p2)  
> 范围：AgentSheet Solid Workbench 与共用 ChatView 的 terminal-like 表现层

## 1. 施工目标

让思考、助手正文、工具/活动和用户消息共享一套“块间距”语义：块之间有稳定、可读的节奏，连续工具保持紧凑；Presentation Profile 只提供块内行高、字体和材质，不再决定块与块之间的距离。

## 2. 调查结论

- Solid Workbench 的消息行由 `PlainMessageList` 外层 row 包裹，活动区另有 `.solid-workbench-activities`；若同时在消息节点和 row 上加 margin，会产生双重空白。
- 共用 ChatView 已存在 `.term-row`、`.term-row-tool` 及 `--chat-row-gap` / `--chat-tool-gap` 变量；这些变量是兼容旧 renderer 的窄 seam，不能改写消息协议或 projector。
- 消息正文的行高来自 `--msg-line-height` / `--chat-line-height`；`.term-plain-text` 不应再写固定 `line-height` 覆盖预设。
- 思考和工具带有独立的 marker/connector 外层。间距统一不应通过缩放标志物或改变 connector 的几何基准实现。

## 3. 设计契约

1. `--chat-row-gap` 表示不同语义块之间的间距；`--chat-tool-gap` 表示相邻工具块之间的紧凑间距；活动区使用独立的 `--chat-activity-gap`。
2. 每个相邻块只允许一个间距来源：Solid 优先由 row wrapper 提供，ChatView 旧路径由 `.term-row + .term-row` 提供；禁止父子两层重复叠加。
3. 流式和完成态使用同一消息行变量。Markdown 稳定块提交不能在 `pre-wrap` 文本中重复插入结构性空行。
4. 用户、思考、助手和工具的左侧 marker 共用同一列宽；本施工书只规定间距，不改变 marker glyph 或 connector 协议。

## 4. 实施切片

### Slice A：变量与归属

- 固定 terminal-like 的块间距 token 及默认值，保留自定义预设覆盖入口。
- 明确 Solid row、活动容器和旧 ChatView 的唯一间距归属。

### Slice B：几何验收

- 在默认与自定义消息行高下，混排思考→助手→工具→工具→助手的间距只出现一次。
- 对流式中间态和完成态比较 `scrollHeight`/边界高度，确认不会因固定正文行高或额外空行跳变。

### Slice C：回归与观察

- 增加 CSS contract/DOM 几何断言，覆盖 terminal-like 与非 terminal-like 预设。
- 开发诊断记录实际使用的间距 token 和来源（row、activity 或 legacy term），不向用户展示。

## 5. 兼容性、性能与回滚

- 不改 canonical journal、Workbench projector、消息排序、工具父子关系或持久化格式。
- 变量解析和 CSS 布局不引入每帧脚本；几何断言只在测试/开发诊断运行。
- 若出现双重间距或布局回归，回滚到本施工书 Slice A 的变量定义，保留消息结构和 marker 几何。

## 6. 验收标准

- terminal-like 下不同语义块和连续工具的间距分别稳定，且每个相邻块只计算一次。
- 默认及自定义行高下，流式/完成态的正文行高与边界高度一致（允许亚像素舍入误差）。
- 非 terminal-like 预设行为不变；Solid boundary、皮肤 contract、架构检查和相关前端测试通过。

