# Dev Record — #311 AgentSheet 聊天动效

> 入库保留。规格草稿：`.agents/spec/311-agentsheet-chat-motion.md`（不入库）。

## 元信息

- issue：#311
- 分支：`codex/chat-motion`
- 提交范围：代码提交 `7d038ddd`；随后合并 `github/main@30d8fe3a`，本记录单独提交
- 日期：2026-09-25

## 目标与范围

优化 AgentSheet 聊天视图实时消息、生成状态及工具卡入场。Markdown 解析已有稳定模型复用与首次解析骨架，不增加逐 token 特效。不改变 ACP、消息内容、揭示预算或滚动锚定。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `chat/PlainMessageList.solid.tsx`、`entryMotion.solid.tsx` | 新消息短时入场标记 | 修改 / 新增 |
| `CanonicalActivityList.solid.tsx`、`WorkbenchContent.solid.tsx` | 实时工具 id 入场、减动效与生成态门控 | 修改 |
| `ChatView.css` | 消息与工具短入场、流式左轨提示 | 修改 |
| `PlainMessageList.solid.test.tsx`、`mountSolidWorkbench.solid.test.tsx` | 实时、历史、状态更新与减动效边界 | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | 显示层动效事实 | 修改 |

## 方案要点

- 少量尾部新消息仅在权威生成态下入场；新 id 的工具活动仅在同一会话生成期间入场。历史批量投影、会话换代和减动效均无入场标记。
- 入场标记 420ms 后自动清除，行卸载后重挂不重播；工具状态更新复用稳定节点。工具分组的成员不重复播放整组入场。
- 消息入场只对已测量包装层内的内容使用透明度与轻微位移；工具卡使用短暂透明度与微缩放。移除正文持续背景扫光和模糊，仅生成态左轨细线呼吸。
- Markdown 解析结果继续沿既有模型原地更新；未加入解析完成时的整块闪现或逐段动效。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 实时小批消息入场一次，更新与历史换代静止 | 合并 main 后三文件定向测试 142/142 通过；新增用例覆盖入场、更新、420ms 清除和换代 |
| 工具新增入场，完成状态不重播 | `mountSolidWorkbench.solid.test.tsx` 通过；同 id DOM 身份保持，420ms 后标记移除 |
| 历史与减动效工具静止 | 新增两组集成变体通过 |
| 生成正文静止、Markdown 解析不逐拍闪动 | CSS 删除 `pylon-streaming-sweep` 与正文背景动画；Markdown 渲染逻辑未改 |
| 视觉效果 | 用户明确自行验收，未做 WebView2 实机视觉检查 |

## 测试处置

- 修改：`src/renderers/solid-workbench/chat/__tests__/PlainMessageList.solid.test.tsx` 新增入场边界用例。
- 修改：`src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx` 新增工具入场、历史及减动效用例。
- 未修改或删除既有断言。

## 证据

- 代码提交：`7d038ddd`。
- `bun run check:frontend`（合并最新 main 后）：退出码 0；Vitest 643 个文件通过、1 跳过，4879 项通过、1 跳过、1 todo；生产 Vite 构建 2762 模块，后续 bundle、docs、deps 与产物隔离检查均通过。
- 最终代码三文件定向复跑：`PlainMessageList.solid.test.tsx` + `mountSolidWorkbench.solid.test.tsx` + `ChatView.css.test.ts`，142/142 通过，退出码 0。
- `bun run check:solid`：退出码 0；Solid 边界扫描 165 个源码文件，样式和架构检查通过。
- 合并前曾遇到 #301 已登记的假滚动矩形夹具竞态；随后最新 main 带入 #301 修复。合并后同一三文件定向测试 142/142，全量 4879 项通过；本任务没有改其虚拟化几何。
- `git diff --cached --check`：退出码 0。
- 实机视觉：按用户 2026-09-25 指示跳过，由用户验收。

## 与 spec 的偏差

按用户后续指示跳过 WebView2 实机视觉验收。工具聚合的成员在重组时保持静止，避免首次单卡入场后重播。

## 未解问题

视觉强度与节奏等待用户验收。

## 并行交集

在独立工作树施工，仅触及 AgentSheet 渲染器、对应 CSS/测试和项目架构参考；未触碰共享工作树的 FileSheet 在途改动。
