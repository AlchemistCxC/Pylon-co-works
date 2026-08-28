# Pylon 外观并行施工：派发 Prompt 与一致性工作流

> **状态：AUTONOMY-OPEN**  
> 版本：0.3｜更新时间：2026-08-28  
> 本文是可复制的子 agent 启动指令、状态机、质询格式和根 agent 复核流程。它依赖并服从 [Pylon-外观并行施工-总契约](./Pylon-外观并行施工-总契约.md)。

## 0. 先说清楚“保证”是什么

不能承诺子 agent 永远不会犯错；可以把偏离变成三个可拦截的门：

1. **派发前**：agent 必须读同一版本的总契约和线路文件，并回执所有权/禁区；未回执不得开始改代码。
2. **执行中**：只允许编辑白名单文件；跨线需求必须停工提交契约问题；根 agent 负责裁决，未决不继续。
3. **合并前**：根 agent 检查 diff 白名单、公共契约、Q2/Q4 数值验收、两种 mode × 两种 scheme 和 terminal-like 优先回归；任一门失败则退回线路。

因此本工作流的目标是“可追踪、可阻断、可回滚”，不是依赖 agent 自觉。

## 1. 不可跳过的执行状态机

每条线路只能按以下状态推进。状态写入自己的线路文件，不写总契约。

```text
PRE-DISPATCH
   ↓ 根 agent 明确“开始派发”
PREFLIGHT
   ↓ 首条回执通过阅读/所有权检查
PREFLIGHT-OK（只读审计）
   ↓ 根 agent 按卡片依赖打开有界或完整代码闸门
CODE-GATE-OPEN（bounded / full）
   ↓ 领取一个允许的任务卡并修改产品代码
EXECUTING
   ├─ 发现越界/冲突 → BLOCKED → 等根 agent 决策
   ├─ 卡片验收失败 → EXECUTING（修复）
   └─ 卡片完成 → READY_FOR_REVIEW
READY_FOR_REVIEW
   ↓ 根 agent 完成 diff/视觉/契约复核
ACCEPTED 或 REWORK
   ↓ 线路全部卡片 ACCEPTED
LINE_DONE
```

规则：

- `PREFLIGHT` 没有完整读文档或无法确认文件所有权时，不得编辑。
- `[PREFLIGHT-OK]` 代表阅读/所有权核对通过；本轮 B-01～B-26 基线归类和设计冻结均已完成，可在根 agent 指定的隔离 worktree 开工。
- 只有根 agent 明确发送 `[CODE-GATE-OPEN]`（包含契约版本、卡号和 `scope=bounded|full`）后，线路才进入 `EXECUTING`。当前重点/实现级设计值已冻结；基线确认后直接使用 `scope=full` + `[AUTONOMY-OPEN]`，不再让 agent 自行决定新数值。
- `BLOCKED` 状态不得继续“顺手修复”其他问题；只可补充证据和回答根 agent 的问题。
- `READY_FOR_REVIEW` 后不得自行改动已验收文件，除非根 agent 返回 `REWORK`。
- 根 agent 未发出 `LINE_DONE` 前，不得开始另一条线路的文件。

## 2. 版本握手与公共契约冻结

### 2.1 启动握手

当前总契约版本为 `0.8`。每个 agent 首条消息必须原样包含：

```text
[PREFLIGHT]
线路：A / B / C
总契约版本：0.8
已读文档：<列出总契约、原始施工书、插件系统说明书、线路文件>
可写文件：<逐条列出线路白名单>
只读/禁止文件：<逐条列出最关键的越界文件>
既有工作树改动：<列出；未知则先查询>
当前领取卡片：<卡号>
```

根 agent 逐项核对后回复：

```text
[PREFLIGHT-OK] 线路 X 阅读/所有权核对通过；code_gate=CLOSED；保持只读审计
```

若任一项不对，根 agent 回复 `[PREFLIGHT-REWORK]`，agent 不得写产品代码。

设计冻结与基线归类均完成后，根 agent 可另发完整自治闸门：

```text
[CODE-GATE-OPEN] 线路 X 卡片 X-YY；scope=full；总契约版本：<版本>；允许编辑：<白名单>
```

基线归类确认后，根 agent 可直接发送完整自治闸门；当前不存在未冻结的重点 token/色板/字体/动效数值：

```text
[CODE-GATE-OPEN] 线路 X 卡片 X-YY；scope=bounded；总契约版本：<版本>；仅消费现有 token/已冻结语义；禁止新增或改写公共数值
```

### 2.3 长程自治闸门

为了避免上下文压缩或短暂失联导致 agent 自行改方向，根 agent 可以在 `[CODE-GATE-OPEN]` 后追加一条自治授权：

```text
[AUTONOMY-OPEN]
线路：A / B / C
契约版本：<版本>
scope：bounded / full
允许卡片序列：<例如 A-02 → A-04 → A-05>
禁止越过的卡片/文件：<列出>
每卡 checkpoint：必须
遇到契约问题：立即 BLOCKED 并发 [CONTRACT-QUESTION]
```

自治规则：

- agent 只能按给定序列顺序推进，不得自行新增卡片、改变优先级或跨线领取任务；
- 每张完整卡完成后必须在隔离 worktree 创建一个仅含白名单文件的 commit，并在自己的线路文件追加证据；不要求例行消息或逐卡汇报，只有 BLOCKED/LINE_DONE 时向根 agent 发消息；
- 本地 commit 和线路内证据通过自身验收不等于根 agent 接受；根 agent 可随时发送 `[AUTONOMY-PAUSE]`，agent 立即停止改码并只保留证据；
- 遇到未冻结 token/色板/字体/动效值、公共 ABI、所有权冲突、业务行为风险或测试影响越界时，必须停在 `BLOCKED`，不能用“合理默认值”继续；
- 自治授权不扩大文件白名单、不允许全量测试/全仓库格式化、不允许 push/reset/clean；允许且要求按卡片创建本地 commit。

checkpoint 格式：

```text
[CHECKPOINT]
线路/卡片：
状态：READY_FOR_REVIEW / BLOCKED
改动文件：
未改越界文件：
targeted 命令及 exit code：
EVIDENCE：<按 5.2 格式>
契约请求：无 / <请求编号>
下一卡（仅限授权序列）：
```

根 agent 恢复被暂停的自治线路时发送：

```text
[AUTONOMY-RESUME]
线路：
从卡片：
契约版本：
新增限制：
```

### 2.2 契约变更

公共 token 名、palette 角色、`data-interface-mode`、`data-ui-scheme`、布局槽位、状态/ARIA 规则和验收阈值都属于契约 ABI。变更流程：

1. agent 在自己的线路文件提交契约请求，不直接改公共文件；
2. 根 agent 检查是否已有 Q1～Q6 决策覆盖；
3. 若可裁决，根 agent 更新总契约版本和受影响线路；
4. 若不可裁决，根 agent 向用户提问；
5. 未收到 `[CONTRACT-DECISION]` 前，相关卡片保持 `BLOCKED`。

契约请求格式：

```text
[CONTRACT-QUESTION]
线路/卡片：
涉及文件：
冲突契约：
源码证据（路径/组件/现象）：
最小改动：
不改会怎样：
候选 A/B（含代价）：
推荐：
```

根 agent 的裁决格式：

```text
[CONTRACT-DECISION]
请求：
结论：
允许编辑：
禁止编辑：
影响线路/卡片：
是否升级总契约版本：是/否
```

## 3. 三份可复制派发 Prompt

以下 Prompt 是模板；根 agent 派发时只替换 `任务卡` 和 `当前契约版本`，不得删掉安全段落。

### 3.1 线路 A Prompt

```text
你是 Pylon 外观改造线路 A agent，目标是 terminal-like 宿主与 CLI 的视觉施工。

先完整阅读：
1) docs/Pylon-外观并行施工-总契约.md
2) docs/Pylon-外观并行施工-派发Prompt与工作流.md
3) docs/Pylon-外观设计施工书.md 中 0.1～0.7、1.2、1.5、1.7.1、1.8、1.10～1.22、4.2
4) docs/Pylon-插件系统说明书-开发者版.md 的 Interface Mode、Profile、Renderer、UI Surface 和视觉 token 章节
5) docs/Pylon-外观并行施工-线路A-terminal-like宿主.md

总契约版本：<版本>
本次卡片：<A-YY>
可写文件仅限线路 A 文件所有权表；其他线路、store/preset/runtime/backend 和原始施工书均只读。只允许在隔离 worktree 创建本地 commit；禁止 push、reset、clean 或全仓库格式化。
只运行线路 A 文件所有权对应的 targeted lint/test/visual QA；不要主动运行全量 test、check:frontend、check:all 或全仓库 build。

执行顺序：
1) 发送 [PREFLIGHT] 回执，列出可写/只读文件和既有工作树改动；
2) 只领取当前卡片，先做最小 diff；
3) 运行该卡片的 targeted 检查，记录 computed style/viewport/contrast/focus 证据；
4) 若缺 token、需要改 TSX/TS/主题/runtime/preset，立即发 [CONTRACT-QUESTION] 并停在 BLOCKED；
5) 完成后在自己的线路文件交接表追加改动文件、未改越界文件、命令/结果、证据和遗留风险。

硬约束：terminal-like 先验收；外部插件内部几何可自由；不改业务逻辑、数据流、接口契约、持久化或功能行为；不在 CSS 中重新推断工具状态。
```

### 3.2 线路 B Prompt

```text
你是 Pylon 外观改造线路 B agent，目标是共享语义、主题、状态与可访问性底座。

先完整阅读：
1) docs/Pylon-外观并行施工-总契约.md
2) docs/Pylon-外观并行施工-派发Prompt与工作流.md
3) docs/Pylon-外观设计施工书.md 中 0.1～0.7、1.5、1.6、1.7、1.7.1、1.8、1.10～1.22、4.2
4) docs/Pylon-插件系统说明书-开发者版.md 的 Theme、Profile、Renderer、UI Surface 和可访问性章节
5) docs/Pylon-外观并行施工-线路B-共享语义与状态.md

总契约版本：<版本>
本次卡片：<B-YY>
可写文件仅限线路 B 文件所有权表；store/preset/migration/interface-mode/runtime/backend 和线路 A/C 文件均只读。只允许在隔离 worktree 创建本地 commit；禁止 push、reset、clean 或全仓库格式化。
只运行线路 B 文件所有权对应的 targeted lint/test（触及 Solid 时可运行 check:solid）；不要主动运行全量 test、check:frontend、check:all 或全仓库 build。

执行顺序：
1) 发送 [PREFLIGHT] 回执，列出可写/只读文件和既有工作树改动；
2) 只领取当前卡片，先冻结公共 token/ARIA 改动的最小接口；
3) 纯展示映射可以修正，但不得改变领域状态机、后端输入、store、持久化和命令行为；
4) 若需要编辑高风险文件，立即发 [CONTRACT-QUESTION] 并停在 BLOCKED；
5) 完成后在自己的线路文件交接表追加改动文件、未改越界文件、命令/结果、对比度/Tab/reduced-motion 证据和遗留风险。

硬约束：Q5 C 只强制宿主/共享层 token；Q6 C 不要求统一 tone/glyph；Q2 对所有插件仍强制；cancelled 不得展示为 completed；不新增 mode id、persistence 字段或 Interface Mode。
```

### 3.3 线路 C Prompt

```text
你是 Pylon 外观改造线路 C agent，目标是 modern-gui、Settings 表面和 Sheet/插件表面。

先完整阅读：
1) docs/Pylon-外观并行施工-总契约.md
2) docs/Pylon-外观并行施工-派发Prompt与工作流.md
3) docs/Pylon-外观设计施工书.md 中 0.1～0.7、1.2～1.4、1.5、1.7.1、1.8、1.9、1.16～1.22、4.2
4) docs/Pylon-插件系统说明书-开发者版.md 的 Interface Mode、UI Surface、Sheet、Profile、作用域 CSS 和视觉 token 章节
5) docs/Pylon-外观并行施工-线路C-modern-gui与插件表面.md

总契约版本：<版本>
本次卡片：<C-YY>
可写文件仅限线路 C 文件所有权表；Settings/Sheet TSX、App.tsx、plugin runtime、store/preset、线路 A/B 文件均只读。只允许在隔离 worktree 创建本地 commit；禁止 push、reset、clean 或全仓库格式化。
只运行线路 C 文件所有权对应的 targeted lint/test/visual QA；不要主动运行全量 test、check:frontend、check:all 或全仓库 build。

执行顺序：
1) 发送 [PREFLIGHT] 回执，列出可写/只读文件和既有工作树改动；
2) 只领取当前卡片，先做共享 Sheet shell，再处理具体 Sheet；
3) 宿主 shell 消费公共 token，Sheet 内部可保留自己的几何/断点；
4) 若需要新增 plugin capability、改 TSX/runtime 或统一所有插件几何，立即发 [CONTRACT-QUESTION] 并停在 BLOCKED；
5) 完成后在自己的线路文件交接表追加改动文件、未改越界文件、命令/结果、viewport/contrast/focus 证据和遗留风险。

硬约束：Q4 只收敛宿主预算/恢复入口，不强制同一断点；Q5 C 允许插件内部直接值；Q6 C 允许插件自定义状态配方；不改变 Sheet 注册、导航、关闭、请求或数据行为。
```

## 4. 根 agent 的调度顺序

### 4.1 派发前

根 agent 必须在总契约第 10 节把所有复选项改为完成，尤其是：

- 用户确认 B-01～B-26 归类；
- 阶段 1 的重点 token/色板/字体/动效值已拍板；
- 共享 token/状态/布局 ABI 已冻结；
- 当前工作树既有改动已登记；
- 三份线路文件的白名单无交集。

### 4.2 启动

1. 同一轮向 A/B/C 分别发送对应 Prompt；
2. 等待三份 `[PREFLIGHT]`，逐份回复 `[PREFLIGHT-OK]` 或 `[PREFLIGHT-REWORK]`；
3. 对安全卡片发送 `[CODE-GATE-OPEN]`，必要时追加 `[AUTONOMY-OPEN]` 指定可自动推进的卡片序列；
4. 根 agent 保持对用户的单一升级入口。

### 4.3 执行中

- 根 agent 不在 agent 正编辑的文件上做并行手改；需要修正时返回 `REWORK`。
- 任一 agent 报契约问题，根 agent 先暂停受影响卡片，检查是否能由已拍板决策裁决。
- 一条线路的“看似小改动”如果会影响另一条线路的公共 token、DOM class、ARIA 名称或布局槽位，必须走契约请求。

## 5. 根 agent 合并前复核闸门

每条线路 `READY_FOR_REVIEW` 后按固定顺序复核：

### Gate 1：文件所有权

- `git diff --name-only` 只包含线路白名单和线路前缀 QA 文件；
- 无 `src-tauri/Cargo.lock`、`issue.md` 或其他既有用户改动被覆盖；
- 无全仓库格式化产生的邻线 diff。

### Gate 2：契约一致性

- token 名未被删除/重命名；新增 token 有契约记录；
- mode 仍只有 `terminal-like`/`modern-gui`；没有新增 Interface Mode/persistence 字段；
- plugin 内部直接值没有被误报为宿主缺陷；宿主专属例外有登记；
- 状态 label/ARIA 与源状态一致，尤其 `cancelled`/`completed`。

### Gate 3：可访问性与视觉证据

- 文本 `>=4.5:1`、大文本 `>=3:1`、非文本控件/边界 `>=3:1`；
- 键盘控件有可见 `focus-visible`，Settings modal 焦点路径可复现；
- hover/active/disabled/loading/空态/错误态有可辨识反馈；
- reduced-motion 下非必要动效关闭；
- 证据包含 computed 前景/背景、尺寸、Tab 路径或截图，不接受“看起来更好”。

### Gate 4：四矩阵回归

- `terminal-like` + dark/light + `1738/1280/900/680/480×720`；
- `modern-gui` + dark/light + 同一视口；
- 默认 profile 和至少一个自定义 preset 应用后切换；
- 默认字号、125%、150%（环境可用时）。

### Gate 5：行为不变

- 设置字段、保存/删除、导航、Sheet 注册/关闭、命令、会话、工具输出和后端请求行为无 diff；
- 允许的变化只属于 CSS、DOM 表现结构、ARIA/焦点、布局占位和状态视觉反馈。

## 5.1 命令级验证清单

### 子 agent 卡片级

- CSS-only 卡片：对所属 CSS 文件运行 `npx.cmd eslint <owned-tsx-or-ts-files>`（无 TS/TSX 改动时可跳过），并用浏览器/现有 visual QA 入口记录 computed style、viewport 和对比度；不要运行会改写全仓库的格式化命令。
- B 线路触及 Solid 文件时：运行 `npm.cmd run check:solid`；失败时保留完整错误并进入 `BLOCKED`，不要通过放宽边界脚本来“修绿”。
- B 线路新增/修改前端测试时：运行 `npm.cmd run test:frontend -- <owned-test-file>` 或仓库已有的等价 targeted Vitest 命令；测试文件路径必须在自己的白名单内。
- 每条线路完成前：运行 `npm.cmd run check:first-party-styles`，确认第一方 CSS ownership 守卫仍通过；该命令当前基线已实测通过（28 files）。
- 子 agent 禁止主动运行全量 `npm.cmd test`、`npm.cmd run check:frontend`、`npm.cmd run check:all`、全仓库 `build` 或覆盖其他线路的测试；只有根 agent 在三线合并阶段运行集成级全量检查。
- 测试只覆盖长期稳定的契约不变量，例如“取消状态不得被展示为完成”“键盘控件保留可达语义”“缺失 palette 角色只回退到同套件安全值”。禁止测试预设/插件/Sheet 数量、数组顺序、固定文案、完整枚举快照、具体 CSS class、具体像素/颜色、DOM 层数或当前实现细节；这些应使用 conformance/视觉 QA 证据。

### 根 agent 集成级

- 三线全部 `READY_FOR_REVIEW` 后运行 `npm.cmd run check:frontend`、`npm.cmd run check:solid`；若改动仅 CSS 且前端全检成本过高，也不能省略 `check:first-party-styles`、lint 和对应 targeted tests。
- 最终交付前运行 `npm.cmd run build` 和一次完整的 `npm.cmd run test`（或记录环境原因与替代命令）；不把 agent 的“本地通过”当作跨线集成通过。
- 任何命令产生了不在该线路白名单的修改，都立即停止并检查格式化/生成物；不得把生成物或 lockfile 当作线路改动提交。

## 5.2 统一证据包格式

每张卡片的交接记录必须至少包含一个结构化证据块：

```text
[EVIDENCE]
卡片：
模式/profile/scheme：
viewport（实际 innerWidth×innerHeight）：
字号/缩放：
状态/操作：
computed 前景/背景/边框/阴影/动画：
对比度结果：
Tab/focus 结果：
scrollWidth/clientWidth 或其他几何结果：
命令及 exit code：
测试不变量（无新增测试填 N/A）：
```

截图可以附加，但不能替代 computed 数值、DOM/ARIA 或尺寸证据。没有证据的卡片只能保持 `EXECUTING`，不能标记 `READY_FOR_REVIEW`。

新增测试自检：

- [ ] 断言跨版本仍应成立的语义/安全/数据不变量；
- [ ] 没有断言预设、插件、Sheet 或状态的数量、顺序、固定文案或完整列表；
- [ ] 没有把具体像素、颜色、CSS class、DOM 层数或当前组件树当作长期契约；
- [ ] 如果需求只是视觉数值或表面层级，使用 computed-style/contrast/viewport QA，而不是长期单测；
- [ ] 测试不会阻止新增合法 preset、plugin、状态或 Sheet。

## 6. 失败、回滚和重新进入

- Gate 失败不执行 destructive rollback；根 agent 将线路标为 `REWORK`，指出具体 selector、路径、数值或契约冲突。
- agent 只回滚自己本次卡片的改动，优先使用 `apply_patch` 精确修复；不得 reset/checkout 整个工作树。
- 如果失败原因来自另一线路尚未完成的公共 token，根 agent 不让 agent 互相覆盖；先冻结 token 版本或调整依赖，再重跑验证。
- 同一契约冲突连续出现三次仍无法裁决时，根 agent 向用户升级，而不是让 agent 猜测。

## 7. 派发记录模板

| 线路 | agent | 派发时间 | 契约版本 | 首卡 | PREFLIGHT | 当前状态 | 根复核结果 |
|---|---|---|---|---|---|---|---|
| A | 已派发 | 2026-08-28 | 0.8 | A-02 → A-01 → A-04 → A-03 → A-05 | 通过 | AUTONOMY-OPEN / 隔离 worktree | 待逐卡本地 commit；terminal-like 优先 |
| B | 已派发 | 2026-08-28 | 0.8 | B-18（已验收）→ B-01 → B-02 → B-03 → B-04 | 通过 | AUTONOMY-OPEN / 隔离 worktree | B-18 纳入基线；后续逐卡本地 commit |
| C | 已派发 | 2026-08-28 | 0.8 | C-02 → C-01 → C-03 → C-04 | 通过 | AUTONOMY-OPEN / 隔离 worktree | 待逐卡本地 commit；消费 B 公共 ABI |

## 8. 变更记录

| 时间 | 变更 | 原因/影响 |
|---|---|---|
| 2026-08-28 | 初版 Prompt 与一致性工作流 | 把“不要违约”改造成版本握手、状态机、契约请求、白名单 diff 和五道合并闸门；当前仍不派发。 |
| 2026-08-28 | 自治与提交纪律更新 | 基线已确认；每个完整功能/卡片要求一个本地 commit，agent 无例行汇报，仅 BLOCKED/LINE_DONE 升级；总契约 0.8。 |
