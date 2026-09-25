# Dev Record — #311 AgentSheet 聊天动效

> 入库保留。规格草稿：`.agents/spec/311-agentsheet-chat-motion.md`（不入库）。

## 元信息

- issue：#311
- 署名：Codex
- 分支：`codex/chat-motion`
- 提交范围：首版代码 `7d038ddd`；随后合并 `github/main@30d8fe3a`；本次按用户反馈增强动效
- 日期：2026-09-25

## 目标与范围

优化 AgentSheet 聊天视图实时消息、生成状态及工具卡入场。用户在首版后要求更丰富的入场与恢复流式扫光，因此追加正文尾部扫光和一次性光晕。Markdown 解析已有稳定模型复用与首次解析骨架，不增加逐 token 特效。不改变 ACP、消息内容、揭示预算或滚动锚定。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `chat/PlainMessageList.solid.tsx`、`entryMotion.solid.tsx` | 新消息短时入场标记 | 修改 / 新增 |
| `CanonicalActivityList.solid.tsx`、`WorkbenchContent.solid.tsx` | 实时工具 id 入场、减动效与生成态门控 | 修改 |
| `chat/MessageRow.solid.tsx`、`chat/MarkdownContent.solid.tsx`、`ChatView.css` | 流式正文尾部扫光、打字光标、消息与工具入场及左轨提示 | 修改 |
| `PlainMessageList.solid.test.tsx`、`MessageRow.solid.test.tsx`、`StreamingIdentity.solid.test.tsx`、`mountSolidWorkbench.solid.test.tsx` | 实时、历史、状态更新、扫光与打字光标生命周期、减动效边界 | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | 显示层动效事实 | 修改 |

## 方案要点

- 少量尾部新消息仅在权威生成态下入场；新 id 的工具活动仅在同一会话生成期间入场。历史批量投影、会话换代和减动效均无入场标记。
- 入场标记 760ms 后自动清除，行卸载后重挂不重播；工具状态更新复用稳定节点。工具分组的成员不重复播放整组入场。
- 消息入场在已测量包装层内完成短暂抬升与边缘描线；工具卡轻回弹并闪过一次描边光晕，均不改变布局盒尺寸。
- 生成中的助手正文尾部有独立、不可交互的低强度扫光覆盖层；它只覆盖至多 10rem 的尾部，使用 transform 移动，不随 token 重启，也不动画化整篇 Markdown 背景。权威终态移除覆盖层。左轨细线继续呼吸。
- Markdown 解析结果继续沿既有模型原地更新；未加入解析完成时的整块闪现或逐段动效。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 实时小批消息入场一次，更新与历史换代静止 | 定向测试覆盖入场、更新、760ms 清除和换代；增强版相关 4 文件 163/163 通过 |
| 工具新增入场，完成状态不重播 | `mountSolidWorkbench.solid.test.tsx` 通过；同 id DOM 身份保持，760ms 后标记移除 |
| 历史与减动效工具静止 | 新增两组集成变体通过 |
| 生成正文尾部扫光、终态移除，Markdown 内容节点不重挂 | `MessageRow.solid.test.tsx` 新增用例覆盖扫光层与正文节点生命周期；Markdown 渲染逻辑未改 |
| 视觉效果 | 用户明确自行验收，未做 WebView2 实机视觉检查 |

## 测试处置

- 修改：`src/renderers/solid-workbench/chat/__tests__/PlainMessageList.solid.test.tsx` 新增入场边界用例，并把入场清除时限断言从 420ms 更新为 760ms。
- 修改：`src/renderers/solid-workbench/chat/__tests__/MessageRow.solid.test.tsx` 新增扫光层终态清理与内容身份用例。
- 修改：`src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx` 新增工具入场、历史及减动效用例。
- 未删除既有断言。

## 证据

- 代码提交：`7d038ddd`。
- `bun run check:frontend`（合并最新 main 后）：退出码 0；Vitest 643 个文件通过、1 跳过，4879 项通过、1 跳过、1 todo；生产 Vite 构建 2762 模块，后续 bundle、docs、deps 与产物隔离检查均通过。
- 最终代码三文件定向复跑：`PlainMessageList.solid.test.tsx` + `mountSolidWorkbench.solid.test.tsx` + `ChatView.css.test.ts`，142/142 通过，退出码 0。
- `bun run check:solid`：退出码 0；Solid 边界扫描 165 个源码文件，样式和架构检查通过。
- 合并前曾遇到 #301 已登记的假滚动矩形夹具竞态；随后最新 main 带入 #301 修复。合并后同一三文件定向测试 142/142，全量 4879 项通过；本任务没有改其虚拟化几何。
- `git diff --cached --check`：退出码 0。
- 实机视觉：按用户 2026-09-25 指示跳过，由用户验收。

### 用户反馈后的增强（2026-09-25）

- 用户明确要求更高级、更丰富的动效，并指出取消流式扫光不符合预期。恢复扫光并限定在正文尾部；入场时长延长以容纳两段式节奏，视觉强度等待用户验收。
- 定向组件测试：`MessageRow.solid.test.tsx`、`PlainMessageList.solid.test.tsx`、`mountSolidWorkbench.solid.test.tsx`，3 个文件 133 项通过；`ChatView.css.test.ts` 30 项通过。
- `bun run check:solid`：退出码 0；Solid 边界扫描 165 个源码文件，CSS 消费审计悬空引用 0。
- `bun run check:frontend`：退出码 0；Vitest 643 个文件通过、1 跳过，4880 项通过、1 跳过、1 todo；生产 Vite 构建 2762 模块，后续 bundle、docs、deps 与产物隔离检查均通过。

### 打字机视觉增强（同 issue 后续反馈）

- 调查确认：`streamingDisplayScheduler` 与 wasm 揭示引擎只按预算发布文字，本身没有字符位置的视觉动效；既有扫光属于正文生成态。
- `MarkdownContent` 只在初始流式行发生前缀增长时显示一个装饰性光标，420ms 无新增文字即清除；终态若仍按预算补齐文字，光标继续跟随。历史整发、回退或替换不触发。
- 光标位于助手正文最后一个可见普通文本或 Markdown 文本叶节点，跳过列表/引用结尾的结构空白；未闭合代码围栏落在最后一行。思考区不显示光标。零盒宽高、`aria-hidden`，不进入复制文本和行宽计算。系统与聊天减动效下隐藏。揭示预算与 Markdown 解析模型未改。
- `StreamingIdentity.solid.test.tsx` 新增普通文字、解析 Markdown 稳定块身份、列表/引用容器、未闭合代码围栏末行与终态清理用例；定向 9/9 通过。第一次全量测试发现思考区结构 HTML 与终态不一致；收窄到助手正文并跳过容器结构空白后，`issue55.streamingContainers.solid.test.tsx` 与新增用例定向通过。
- 最终 `bun run check:solid`：退出码 0，扫描 165 个源码文件，CSS 消费审计悬空引用 0。
- 最终 `bun run check:frontend`：退出码 0；Vitest 643 个文件通过、1 跳过，4885 项通过、1 跳过、1 todo；Vite 构建 2762 模块，后续 bundle、docs、deps 和产物隔离检查通过。一次中途的 `build:example-plugin` esbuild 失败单独重跑后通过，完整门禁复跑亦通过。
- `git diff --check`：退出码 0。实机视觉继续按用户要求跳过。

## 与 spec 的偏差

按用户后续指示跳过 WebView2 实机视觉验收。工具聚合的成员在重组时保持静止，避免首次单卡入场后重播。

## 未解问题

视觉强度与节奏等待用户验收；不做实机视觉验收是用户明确要求。

## 并行交集

在独立工作树施工，仅触及 AgentSheet 渲染器、对应 CSS/测试和项目架构参考；未触碰共享工作树的 FileSheet 在途改动。

## 后续增强：完成收束、Markdown 定稿、工具结果回执（2026-09-25）

- 用户在讨论中明确「三个都做」；继续使用 `codex/chat-motion` 独立工作树。开工时共享工作树存在 FileSheet 在途改动，因此未触碰、暂存或提交共享文件。开工前合入 `github/main@21c29270`，其中已包含上一轮合并的 PR #313。
- `AssistantContent` 只对曾经直播的回复保留终态扫光；终态后每次可见文字增长重置 440ms 静默窗，静默后显示一次 760ms 的短扫线与收束光点。同一行后续终态修订不重播，历史初挂载不触发；光标的 420ms 清理与收束先后衔接。
- `StreamingMarkdownBlocks` 在增长尾块晋升稳定块时标记一次定稿；未闭合代码围栏在闭合瞬间也触发。标记只传给助手正文的代码块、表格、列表、引用和标题，620ms 清除；思考区显式关闭，稳定行不加包装或改变分割/解析算法。列表容器按既有切分规则可一直是尾块，终态晋升时才定稿。
- `CanonicalActivityList` 对直播期初始无输出的工具活动，在首次获得输出或错误时给原有卡片标记一次 760ms 回执；收起状态可见卡头扫光，展开状态结果区轻抬入场。聚合工具卡同口径；历史恢复、只读回放和减动效均静止。
- `ChatView.css` 增加上述三组局部效果；仅动画 `opacity`/`transform`，不改变行高。系统与聊天减动效设置关闭新效果；架构参考同步终态、Markdown 与工具结果的当前行为。
- 测试调整：`MessageRow.solid.test.tsx` 验证终态补字推迟收束、一次性和历史静止；`StreamingIdentity.solid.test.tsx` 验证列表晋升、闭合围栏与既有稳定标题身份；`mountSolidWorkbench.solid.test.tsx` 验证工具首次结果回执及历史/减动效静止。未放宽或删除旧用例。第一次全量测试有 2 个 `issue55.streamingContainers` 用例因思考区收到新装饰标记而失败；将定稿限定到助手正文后，这两项沿原逐字节 HTML 断言通过。
- 验证证据：定向复跑 4 文件 / 134 项通过，退出码 0；`bun run check:solid` 退出码 0，扫描 165 个源码文件，CSS 消费审计悬空引用 0；`bun run check:frontend` 退出码 0，Vitest 641 文件通过 / 1 跳过，4880 项通过 / 1 跳过 / 1 todo，Vite 生产构建转换 4637 模块，bundle、solid-smoke、docs、deps 与产物隔离检查通过；`git diff --check` 退出码 0。
- 代码提交：`88f45ccc`。实机视觉验收按用户明确指示由用户自行进行，本次未执行 WebView2 验收。
- 随后合入 `github/main@4a8fb576`，无冲突；最新基线上定向复跑 4 文件 / 134 项通过，`check:solid` 再次退出码 0。首次全量门禁在 4940 项通过后因工作树尚未安装主线新增的 `@codemirror/merge` 而停在 FileSheet 新用例；按锁文件执行 `bun install --frozen-lockfile` 后，`check:frontend` 退出码 0：Vitest 649 文件通过 / 1 跳过、4942 项通过 / 1 跳过 / 1 todo，Vite 生产构建转换 4640 模块，后续 bundle、solid-smoke、docs、deps 和产物隔离均通过。`git diff --check github/main...HEAD` 退出码 0。
