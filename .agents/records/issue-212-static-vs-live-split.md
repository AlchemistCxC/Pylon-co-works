# Dev Record — #212 / #213 重放与直播分流（静态路径）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-212-static-vs-live-split.md`

## 元信息

- issue：[#212](https://github.com/AlchemistCxC/Pylon-co-works/issues/212)（历史被当直播逐字铺开）、[#213](https://github.com/AlchemistCxC/Pylon-co-works/issues/213)（未终结回合永久生成中）；并入 #204 遗留（graft 基座预算）与 #208 遗留（流式代码块折叠，未落地，见「未解问题」）
- 分支：`Ru5t/Reflector`（经 PR **#207** 合入）
- 提交范围：`a3a3a697..`（本记录随同批提交）
- 日期：2026-09-20
- 用户拍板：判据**统一到运行时权威化**；历史**整发 + 渐进挂载**；滚动**自管锚点 + `overflow-anchor:none`**；引入 **HYDRATING 落位窗口**；**并入** #204/#208 遗留；自动跟随**一律 instant**

## 目标与范围

**做**：把"这一行现在是否在被揭示"从**数据形状推断**（`running` / 新行 / 有内容增长）改成**本进程的活性事实**，并据此把渲染分成静态与流式两条路径；顺带修掉三个把重放观感拖坏的点（逐拍揭示、逐拍整段重解析、水合期跟随抖动）。

**不做**：不碰数据面（journal 读/写、schema）；不改 `running` 的投影语义（它仍是"没见到终态"）；不做行虚拟化。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/renderers/solid-workbench/streamingDisplayScheduler.ts` | `interpolateHistory` 选项；`midRevealKeys`/`growingKeys` 两份集合；`push`/`resume` 的判据 A；`interpolateSnapshot` 返回 `pendingKeys`；`revealingRows()`；`streamingRowKey` 导出；诊断计数（whole/budgeted/history/growingRows）；`hasActiveTextStream` 加权威门 | 修改 |
| `src/domains/workbench/workbenchRuntime.ts` | `livenessSource` / `livenessGenerating`（快照 + 两个 apply 选项 + merge 输入）；`applyLivenessAuthority`；相等性比较；两处 apply 透传 | 修改 |
| `src/sheets/agent-workbench/agentWorkbenchSession.ts` | bind / refresh / `applyLive` 三处申报权威值；`settleRuntimeLiveness`（`reconcileTurnClock` 的对偶）；`applyLive` 对「无时钟 + 实时正文帧」采纳时钟；`turnClockGenerating` / `isLiveTextDelta` / `runningTailStartTime` 三个小助手 | 修改 |
| `src/renderers/solid-workbench/SolidWorkbenchContext.solid.tsx` | 可选 `revealingRows` 访问器 | 修改 |
| `src/renderers/solid-workbench/mountSolidWorkbench.solid.tsx` | 调度器集合 → 信号 → context | 修改 |
| `src/renderers/solid-workbench/SolidWorkbenchApp.solid.tsx` | `isAuthoritativelyLive` / `isIncrementalRow` 两个判据；三处消费者；水合窗口（`hydratingUntil`）；列表接线（`scrollViewport`/`scrollPosture`） | 修改 |
| `src/renderers/solid-workbench/chat/MessageRow.solid.tsx` | 可选 `live()` 通道（缺省回落 `message.running`） | 修改 |
| `src/renderers/solid-workbench/chat/markdownRenderModel.ts` | `settledModels` + `peekMarkdownRenderModel`；graft 基座字符预算（`MAX_GRAFT_BASE_CHARS`、`graftBaseStats`） | 修改 |
| `src/renderers/solid-workbench/chat/MarkdownContent.solid.tsx` | 渲染源改为 `settled() ?? model.latest` | 修改 |
| `src/renderers/solid-workbench/chat/PlainMessageList.solid.tsx` | 自管锚点（`scrollViewport`/`scrollPosture`/`syncAnchorCompensation`） | 修改 |
| `src/components/chat/scrollFollowModel.ts` | `HYDRATING_MS` | 修改 |
| `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css` | `.chat-view` 加 `overflow-anchor: none` | 修改 |
| 测试 | `streamingDisplayScheduler.staticPath`、`livenessAuthority`、`issue204.graftBaseBudget` 三个新文件；`MarkdownContent.solid`、`PlainMessageList.solid` 各增 | 新增/修改 |

## 方案要点

### 三个判据

- **判据 A（发表姿态，调度器）**：预算插值只在"本拍有直播语义"时使用——目标快照 `generating === true`，**或**已有行处于揭示中（`midRevealKeys`）。否则整发。终态交接不变（那条路径上必然有 mid-reveal 行）。
- **判据 B（权威活性，运行时）**：`livenessSource: 'clock'` 时 `generating` 只认会话层回合时钟；权威值随文档一并传递（`livenessGenerating`）——新回合推进 `turnEpoch` 的那次投影里，"权威说在跑"还没进快照，只读 `previous` 会把合法在途判成静止（这条是实测踩出来的，见「测试处置」）。
- **判据 C（增长集合，调度器 → 渲染层）**：`revealingRows()` 暴露"同一行文本在两次发布之间变长"的行 key，粘滞到换会话/换 owner。**只**用于内置 markdown 的增量/静态分流；对外语义（Slot 的 `streaming`、`data-streaming`、reasoning 的 `state`/pulse）一律走权威判据，终态即假。

### 分层不混淆

`streaming` 这个词在三处含义不同，本次显式分开：插件的"仍在被生产"（权威活性）、渲染路径的"走 graft"（权威 + 粘滞）、调度器的"按预算揭示"（判据 A）。此前它们都由 `message.running` 兼职。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 2 万字符**已完成**历史的发表姿态 | 改动前 `{"publications":8,"maxPublishedLength":1024,"lastKind":"budgeted"}` → 改动后 `{"publications":1,"maxPublishedLength":20000,"lastKind":"whole","historyPublications":1}` |
| 未终结回合重放后是否复活生成态 | 改动前 `generating === true`（页脚永久生成中）→ 改动后 `generating === false`、`generationPhase` 为空 |
| 既有节奏契约（27+6+2 例调度器用例） | 零修改全绿（"新行按预算揭示"只在直播侧成立；终态不整块倒出不变） |
| 全量前端 | 613 文件 / 4497 例全绿（含 1 todo） |
| Rust 侧 | 本轮零改动；`cargo clippy --workspace` exit 0 + 基线门禁四 crate 无新增 |

## 测试处置

**新增**（都是先写红灯再实现）：

- `src/renderers/solid-workbench/__tests__/streamingDisplayScheduler.staticPath.test.ts`（9 例）：历史整发 / reasoning 行 / resume 整发 / 回滚开关 `interpolateHistory` / 直播中的新行仍按预算 / 终态交接仍不整块倒出 / 判据 C 三条（只认已有行的增长、粘滞到换会话、双列表只记一次）。
- `src/__tests__/replay/livenessAuthority.test.ts`（6 例）：无终态回合不复活 / 有终态对照 / **无申报宿主的兼容路径仍按文档推断** / 他端先开回合的采纳与起点 / 自己的回合不回落 / 终帧明确收敛。
- `src/renderers/solid-workbench/chat/__tests__/issue204.graftBaseBudget.test.ts`（3 例）：单条超预算仍保留且 graft 命中 / 多行累积淘汰最旧 / 清缓存清预算。
- `MarkdownContent.solid.test.tsx` +1：命中已结算缓存时同步渲染、无骨架。
- `PlainMessageList.solid.test.tsx` +2：pin 姿态补偿 50px / follow 姿态不补偿。

**未修改任何既有断言**——但改动过程中有 4 例红灯打在既有用例上（`mountSolidWorkbench` 的 slot `streaming` 随终态收、`terminalDelivery` 的三例、`rebindIndicator` 的一例），它们都不是"过时"，而是暴露了实现缺陷：前两个说明我把粘滞判据用在了对外语义上（已拆成两层），后四个说明**时钟封存后必须明确把快照推回静止**（新增 `settleRuntimeLiveness`）与**权威值必须随文档传递**（新增 `livenessGenerating`）。这两处是这次改动实质性的技术内容。

## 证据

- commit：`bfe46a8f`（判据 A/C）、`ff943d00`（权威化）、`e29f417e`（渲染路径判据）、`1e09be33`（同步渲染）、`f1066c03`（graft 预算）、`219f3524`（自管锚点 + 水合）
- 测试：`bunx vitest run` → 613 文件 / 4497 passed / 0 failed；`cargo clippy --workspace --all-targets` → exit 0，`check-clippy-baseline` 四 crate `added: []`
- 手工验证：见下节「真机验收」

## 真机验收

构建：`bun run tauri build`（exit 0，前端内嵌进二进制）→ 替换 `F:\A-I\Platform\Pylon\pylon.exe`
（旧件备份 `pylon.exe.bak-before212`）→ 带 9222 调试端点启动 → CDP 探针采样（100ms 步长）。

**① 切到一个 22,840 字符 / 10 行的会话**（`textChars` = `.term` 的 textContent 长度）：

| at(ms) | rows | textChars | skeletons | scrollTop |
| --- | --- | --- | --- | --- |
| 0 | 3 | 353 | 0 | 0 |
| 5788 | 0 | 0 | 0 | 0 |
| 5888 | 10 | **22840** | 0 | 11456 |

内容在**一个 100ms 采样步长内一次到位**（0 → 22,840），骨架 0、long task **0 条**。
判据 A 之前的行为是 128 单位/拍 ≈ 7.7k 字符/秒 ⇒ 这 2.28 万字符要铺约 3 秒，
trajectory 会呈线性爬升；实测没有爬升段。

**② 落位精确**：`scrollTop 11456 = scrollHeight 12101 − clientHeight 645` ⇒ 恰好贴底，无漂移。

**③ #213 现场**：该会话的最后一个回合正是被 180s 空闲上限截断的那次（工作台 `data-status=degraded`，
诊断行文本 = `响应闲置超时（180s）… elapsed 472535ms`——即上轮已报、待裁决策略的旧发现）。
重启后打开它：4 个思考块全部 `data-state="complete"`／标签「思考过程」，`[data-streaming]` 行 0 个，
生成指示器 0 个 ⇒ **没有复活成"正在思考…/仍在等待后端响应"**。

**本轮未能覆盖的真机项**（如实记录，不以单测冒充）：
- 挂载窗口在真机数据上没被触发——该实例只有 2 个会话、最大 10 行 < 初始窗口 16 行；
  窗口行为（尾部锚 16 行、逐帧 +32、不缩窗）只有单测覆盖。
- 自管锚点的补偿需要"用户上滚 + 上方内容变化"同时发生（例如流式长回合期间上滚），
  本实例没有可触发的活回合；补偿算法只有单测覆盖（pin 补偿 50px / follow 不补偿）。
- 水合窗口的"瞬态翻转"需要一次真实的打开期抖动才能对比，本次只验证了最终落位正确。

## 与 spec 的偏差

1. **follow 没有收紧为"仅行数/最后一行变化"**。理由：S1 整发之后"每拍一跳"的根因已消失；而收紧会让贴底姿态下的中间行长高把视口永久留在底部之上（用户会漂离底部）。"跟随 vs 自管补偿"的二分改由 `scrollPosture` 承担，语义更准。
2. **骨架没有加 CSS 估计高度**。理由：S1 之后骨架的贡献从"上千次渐进跳变"降为"打开时一帧内的一次重排"；`contain-intrinsic-size` 只在 `content-visibility`/`contain:size` 下生效，单加它不解决问题，而按块类型拍估计高度属于无证据的微调。改为做有实测价值的那一半（LRU 命中同步渲染）。
3. **渐进挂载行未实现**，见「未解问题」。

## 后续：用户裁决与审核修复（同批追加）

**用户裁决（2026-09-20 二轮）**：① 流式代码块**不折叠**（`ce646edd` 回退了 `1be82759` 的接线，只保留 R-B1 的 `term-code-text` 修复）；② 空闲截断"算活动 + 抬到 600s"（`b8f7669d`，见 #216）；③ #209 并入本 PR 修（`5beb144e`）；④ 活性权威上移内核（ADR-0017 + #217）；⑤ 挂载窗口保留 16/+32。

**子 agent 审核（`.agents/decisions` 外的独立审核，a3a3a697..HEAD）**：6 处必修，全部落地于 `c372d98e`。其中**两处是我引入的真回退**，值得记下来：

- **自管锚点在生产坐标系下是死代码**：`rowTop`/`captureAnchor` 用列表容器（自己不滚动）做基准 ⇒ `scrollTop` 恒 0 + 容器随内容平移 ⇒ 差量恒 0，补偿永不发生；而同一批又关掉了原生锚定 ⇒ 上滚阅读**完全没有锚定**（比改动前更差）。**旧用例还把错误坐标系钉住了**（把容器硬造成滚动容器）——已改为真实滚动容器并加"容器 rect 随内容平移"的模拟，反证过"改回容器基准即红"。
- **包装层 `data-streaming` 漏改**：CSS 有一条只看行包装 div 属性的旁路（sweep 动画 + 脉冲竖条），只改内层 `MessageRow` 会让重放出的无终态行永久播放生成动画——正是 #213 要消灭的症状。已加可注入判据 `rowLive`。

其余：`revealingRows` 传同一变异实例导致信号永不通知；扩窗目标存进 rAF 闭包（换代时收敛到旧行数、新会话头部行缺失）；bind 首发未申报权威值（空文档闪一拍）；发送被拒的回滚仍按文档形状重算 `generating`。

**该轮我未接受的建议**：审核指出判据 A 有一处窄角落（直播已完全追平后，终态与最后一段文本同拍到达时尾巴整块倒出一帧）。不修的**理由**：要让 `growingKeys` 参与判据 A 会破坏 resume 的整发契约，而该角落的后果只是"最后一段随完成标记一起出现"——语义上可接受，故记为已知角落而非缺陷。

## 未解问题

1. **渐进挂载窗口的参数未经真机验证**：窗口本身已按用户裁决落地（首 16 行 + 每帧 +32，尾部锚），但真机实例只有 2 个会话、最大 10 行 < 初始窗口，**未触发**。参数取值的依据是"常见规模下不可见、极端规模下把首帧解析量从整屏降到一窗"，仍属未实测区间。
2. **流式代码块的极端块兜底**：用户裁决为"流式期不折叠"（能看到它继续长）。代价是生成期 DOM 不限量——实测 372 行 / 1.18 万字符 0 条 long task，故常见规模下无问题；若将来出现 5000 行级块，应加**高上限**（例如 2000 行）而不是改为折叠。
3. **真机复验（场景化）**：几何与节奏类断言在 jsdom 里没有布局，单测只能钉判据与补偿算法本身。本轮做过一次替换实例的真机读数（切 2.28 万字符会话：内容一步到位、0 long task、落位精确贴底），但"挂载窗口""上滚阅读的锚定补偿""水合瞬态"三项需要专门造场景，见上。

## 并行交集

本次碰过的共享文件，供其他贡献者避让：

- `src/domains/workbench/workbenchRuntime.ts`（`livenessSource`/`livenessGenerating` 是新增的公开契约）
- `src/renderers/solid-workbench/streamingDisplayScheduler.ts`（导出 `streamingRowKey`；新增 `interpolateHistory`、`revealingRows`、四个诊断计数）
- `src/renderers/solid-workbench/chat/markdownRenderModel.ts`（导出 `peekMarkdownRenderModel`、`graftBaseStats`）
- `src/renderers/solid-workbench/chat/PlainMessageList.solid.tsx`（新增两个可选 props）
- `src/components/chat/scrollFollowModel.ts`（新增 `HYDRATING_MS`）
- `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css`（`.chat-view` 一条属性）
