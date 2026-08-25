# Canonical 对话主链流式 Markdown 增量渲染设计案

状态：已实施（2026-08-25）

范围：正常 Solid Workbench canonical 对话主链。React fatal fallback 不在本案范围内；服务端协议、chunk 粒度和会话 replay 语义不改。

## 1. 目标与非目标

### 目标

1. canonical assistant `message.delta` 到达后仍立即可见，保持服务端 chunk 粒度的流式更新。
2. 已完成的 Markdown 块不因尾部新 token 而重新解析或重建 DOM。
3. 未闭合代码围栏流式增长时不重复执行昂贵语法高亮；代码继续以可读的普通文本行实时显示，围栏闭合或消息完成后再高亮。
4. canonical 消息更新时保持消息行、内容 Slot 和 stable Markdown DOM 的身份；1000 次尾部更新不得累积重复节点或反复 mount Slot。
5. 非文本内容（code 已完成块、image、terminal、diff、artifact 等）仍是明确的 semantic boundary。
6. replay、session switch、late update 继续使用现有 owner/generation 保护，不引入第二份消息状态。

### 非目标

- 不改变 provider 发出的 chunk 粒度；前端不承诺每个 Unicode 字符一个事件。
- 不把 streaming buffer 写回 canonical history；完成边界仍由现有 projector/runtime 负责。
- 不修改 React renderer/fatal fallback。
- 不在本案引入 Markdown AST 的跨块语义推断；列表、引用、表格等边界继续沿用现有 fence-aware 规则。

## 2. 调查结论

当前主链为：

```text
canonical event
  -> workbenchProjector.messages (content + coalesced parts)
  -> WorkbenchContentSlot
  -> BuiltinSolidContentSlot
  -> MarkdownContent
```

已确认的缺口：

1. `WorkbenchMessageContent` 调用 `WorkbenchContentSlot` 时只传 payload，没有传递 `message.running`/streaming 状态；内置 Slot 因此把 canonical assistant 当作非 streaming Markdown。
2. `PlainMessageList.setItems` 接收每次新建的 item/descriptor；普通 `For` 以对象身份复用，导致文档更新可能重挂消息行和 Content Slot。
3. `WorkbenchMessageContent` 使用普通 `For` 消费每次新建的 coalesced parts；尾部 text 更新可能重挂同一 part 的 Slot。
4. 现有 `streamingMarkdownSplit` 已能稳定前缀与增长尾部，但 stable 前缀目前是一个整体；稳定边界推进时会再次解析整体前缀。
5. `CodeBlock` 在多行代码变化时每次调用 `highlightCode`；未闭合代码围栏是最昂贵的流式路径。

## 3. 设计决策

### D1：streaming 是渲染快照元数据，不污染 payload

在 `RenderNodeSnapshot` 增加可选字段：

```ts
readonly streaming?: boolean
```

它是 transient presentation state，不写入 WorkbenchDocument、canonical journal 或 provider raw。`WorkbenchContentSlot` 将其写入 snapshot；第三方 Slot 可忽略，内置 Slot 使用它决定 Markdown 增量模式。

消息满足以下条件才传 `streaming: true`：

- render row 是 assistant/user 的文本内容 Slot；
- `message.running === true`；
- part 是 `text` 或 `markdown`。

reasoning、tool、activity、artifact 等不继承该标记。

### D2：列表按稳定 message key 保持行实例

`PlainMessageList` 内部维护 `key -> item signal`，外层 Solid `For` 只遍历稳定 key 列表。相同 message key 更新 item 时只推进 signal，不销毁行；删除/新增 key 才销毁/创建行。

这比依赖 item 对象引用安全：

- 同一消息新 revision 不重挂；
- session replay 替换整份数组不会累积 DOM；
- 消息插入、删除、重排不会把旧行错误绑定到新消息。

`rowElements` 继续按 message id 维护，重复 key 由上游 descriptor 契约和回归测试拦截。

### D3：消息内容按稳定 part index 保持 Slot 实例

在 `WorkbenchMessageContent` 中使用 `Index` 消费 coalesced parts。每个 part Slot 接收 accessor；part 内容更新时推进 snapshot，非文本 part 的索引边界保持实例。

约束：projector/normalizer 必须先合并相邻 display text；因此正常单一 assistant 文本流只有一个 index 0 Slot。文本与 code/image 等边界变化时才允许创建/销毁对应 index。

### D4：stable/unstable 解析模式进入 canonical 内置 Slot

`BuiltinSolidContentSlot` 从 snapshot 读取 `streaming`，将其传给 `MarkdownContent`。普通已完成消息保持现有全量一次解析；running canonical assistant 使用 `splitStreamingMarkdown`。

stable segment 以 `streaming={false}` 解析，unstable segment 以 `streaming={true}` 解析。稳定段 DOM 身份由 `MarkdownSegment` accessor 保持。

### D5：开放代码围栏流式阶段绕过 Markdown parser 与高亮

在 `streamingMarkdownSplit` 增加纯函数 `splitOpenCodeFenceTail`。它只检查当前 unstable 尾部是否包含一个尚未闭合的顶层 fenced code，并返回围栏前缀、language/info 与原始 code。`MarkdownContent` 在调用 `getMarkdownRenderModel` 之前分流：

- 围栏前缀仍走短尾 `MarkdownSegment`；
- 尚未闭合的 fenced code 直接走 `StreamingCodeBlock`，按行显示普通文本，不调用 unified/remark，也不调用 `highlightCode`；
- fence 闭合后，该代码块进入 stable segment，执行一次高亮；
- message 从 running 变为完成后，非 streaming 全量渲染执行最终高亮。

这样不会牺牲实时可读性，同时把长代码块的 Markdown parse 与高亮次数都从“每个 chunk”降为“闭合/完成时一次”。围栏探测是线性字符串扫描，但不加载 AST、语法 grammar 或 oniguruma。

### D6：稳定前缀解析缓存暂不改变语义边界

本阶段保留现有 fence-aware boundary 规则，先通过稳定 Slot、stable/unstable 接入和 deferred highlight 消除主要成本。stable 整体再次解析只发生在新顶层边界完成时，不发生在每个 token。

后续若 profile 仍显示长历史解析成本，再单独引入按稳定块 AST 缓存；不在本案混入可能改变 Markdown 列表/引用语义的分块重构。

## 4. 更新时序

```text
message.delta(text)
  -> projector appends content + coalesced text part
  -> runtime revision increments
  -> PlainMessageList updates existing row signal by message id
  -> WorkbenchContentSlot updates same nodeId/index snapshot
  -> BuiltinSolidContentSlot updates signal (no root remount)
  -> MarkdownContent recomputes split
       stable unchanged: stable DOM/model stays
       unstable changed: only tail model updates
       open fence: plain code lines, no highlight
       fence closes / message completes: one highlight pass
```

## 5. 边界与安全规则

- 空 streaming 文本不创建空 `<p>`。
- 相邻 `text`/`markdown` 合并后，任一为 markdown 则结果为 markdown。
- code/image/terminal/diff/log/artifact 等非文本 part 阻断合并。
- fenced code 允许 0–3 个缩进空格；闭合 marker 必须同字符且长度不短于 opening marker；CRLF 与 LF 等价。
- info string 含反引号的 backtick fence 不误识别为 opening fence。
- stable/unstable 切分不得重复或丢失文本；消息完成时完整正文必须与非 streaming 解析结果一致。
- Session switch/replay 只替换 canonical document；旧 owner/generation 的更新不能推进当前行 signal。
- deferred highlight 仅影响视觉着色，不改变代码原文、复制文本或行数。

## 6. 验收指标与测试矩阵

### 必须通过

1. 主链 canonical assistant 1000 次尾部更新：正文完整、消息行 DOM 1 个、Content Slot 不重挂、stable heading DOM identity 不变。
2. running canonical Markdown：每次更新只改变 unstable 尾部；完成后最终 DOM 与非 streaming 渲染一致。
3. 长未闭合代码块：进入围栏后，后续流式更新期间 `getMarkdownRenderModel` 与 `highlightCode` 调用次数均不增长；闭合或完成后完整 Markdown parse/高亮各增加至多 1 次（缓存命中不重复调用 provider）。
4. 已闭合代码块后继续普通段落：代码块 DOM identity 保持，后续段落增量更新。
5. 100 次 replay/session-document 替换：每个 message id 只有一个 row，文本不重复。
6. text/markdown + code/image/terminal/artifact 边界保持独立渲染。
7. `check:solid`、lint、相关 projector/normalizer/replay 测试通过。

### 性能观测

测试只使用可移除的 spy/mock 统计 `highlightCode` provider 调用和 DOM identity；不保留生产 debug log。若需要长期 profile，另建 performance seam，不在渲染函数中写日志。

## 7. 实施顺序

1. RED：主链 canonical streaming DOM identity、Slot update、deferred highlight 测试。
2. D1：扩展 RenderNodeSnapshot，并贯通 WorkbenchContentSlot → BuiltinSolidContentSlot。
3. D2/D3：稳定 message key 与 part index；确认 replay/session switch 行为。
4. D4/D5：接入 Markdown streaming 与 deferred code highlight。
5. 运行完整回归，清除所有临时 spy/debug，提交单一可回滚 commit。

## 8. 实施结果

本案已按 D1–D6 接入 canonical Solid 主链：

- canonical `running` 状态以 transient snapshot 元数据贯通到内置 Markdown Slot；
- 消息行按 message key 复用，内容 part 按 index 复用，semantic kind 变化才重挂 Slot；
- 默认消息的 semantic subtree 只 materialize 一次，避免 JSX prop 被多个角色分支读取时暗中构造重复 Slot；
- 未闭合 fenced code 在 parser 前分流，以稳定行 DOM 显示原文；关闭围栏或消息完成后才进入正式 Markdown 解析与高亮。

RED/GREEN 观测：

- 20 次 canonical chunk 更新：目标 Slot mount 从 40 次降至 1 次；
- 未闭合代码围栏追加 100 次：Markdown parse 额外调用从 100 次降至 0 次，highlight 额外调用为 0；
- 关闭围栏后高亮一次，随后普通尾段增长保持代码块 DOM identity；
- 核心真实 DOM 回归 67/67、Solid Workbench（排除既有声明矛盾）319/319、projector/normalizer/replay/session-switch 313/313；
- `check:solid` 与 lint 通过，未执行 build（由产品方自行执行）。

已知非本案失败：`builtinLifecycleSuite.test.ts` 对 `system.hook` 同时存在 required/optional kind 口径矛盾；本案未修改对应声明。
