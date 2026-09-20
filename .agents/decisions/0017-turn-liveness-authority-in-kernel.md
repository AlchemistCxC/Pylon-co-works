# ADR-0017 活性权威归运行时（在途回合的事实由内核给出）

> 入库保留。编号顺延，按编号命名。
> 产出路径：`.agents/decisions/0017-turn-liveness-authority-in-kernel.md`

- **日期**：2026-09-20
- **状态**：已采用（用户于 2026-09-20 就「把事实上移到内核」拍板，并要求同时立 ADR）
- **议题**：issue #213（本 ADR 的直接来源）、#212（观感侧消费者）、#200（同族旧修）、#204（同族旧修）

## 背景与约束

「这个会话现在有没有在途回合」这个事实，此前是**前端从数据形状推断**的：

- `workbenchProjector` 给每个未见终态的行标 `running: true`（`workbenchProjector.ts` 的
  `running: !terminal && !importedHistory`）；
- `workbenchRuntime` 的 `legacyFieldsFromDocument` 据此推 `generating = firstRunning !== undefined
  || runningActivity !== undefined`；
- 于是**重放出来的历史**（journal 尾行没有终态，例如进程重启、回合被空闲上限截断）会把
  `generating` 复活成 `true`：页脚永久「生成中」、思考块显示「正在思考…」，而 busy 判定还会
  波及发送队列（#200 只修了 `provenance.origin === 'recovery-import'` 那一支）。

推断为什么不可靠：它把**两件不同的事**混成一个信号——「journal 里这一行没有终态」（数据形状，
重放与直播都会出现）与「本进程正在驱动这一回合」（运行时事实，只有本进程知道）。

2026-09-20 的权宜修法（#213，已落地）是在**前端的会话层**引入权威：`turnClocks`（按 source
隔离的本进程回合时钟）就 `generating` 表态，`livenessSource: 'clock'` 时文档派生一律让位。
它解决了症状，但权威仍然是一个**前端推断物**：时钟的起点来自"发送入口"或"载入完成后的实时帧"，
本质上是「我们见过什么」，而不是「内核知道什么」。

## 备选方案

| 方案 | 评价 |
| --- | --- |
| **A · 维持前端时钟为权威**（#213 现状） | 已消灭错误的"生成中"显示，但权威仍依赖**观察**：本进程没看见回合起点（他端已开回合、或本进程刚启动时回合已在进行）就只能"采纳"（`applyLive` 的 `runningTailStartTime` 用文档里首个 running 行的时间猜起点）。猜错影响 elapsed 与"是否在途"的判据。 |
| **B · 内核给出在途事实，前端消费**（采用） | 内核**本来就有**这个事实：回合的生命周期在 Rust 侧由 turn 账本与 prompt 流程掌握（prompt 派发 → 终态事件 ← `turn_ledger`/`finalize_response`/`publish_prompt_failure`）。把它作为一等事实暴露，前端不再推断。 |
| C · 继续按数据形状推断 + 更多豁免 | 每遇到一个反例就加一条 `provenance`/状态豁免（#200 已经这么加过一次）。豁免之间会互相矛盾，且"重放看起来像在途"的根因不动。 |

## 决定

**活跃性权威归内核**（方案 B）。分三步，每步独立可回滚：

1. **内核暴露事实**：为每个会话维护一个**在途回合**标记，语义严格为「本进程已派发 prompt、
   尚未收到终态」；经由既有的会话查询面暴露（形状与命名待实现时定稿，遵循现有 IPC 惯例）。
   该标记**不落盘**（与 `turnEpoch`、`last_activity` 同级：进程内事实，不是 journal 事实）。
2. **前端消费**：会话绑定层读该事实，作为 `livenessSource` 的**新来源**（`'kernel'`）；
   优先级：`kernel` > `clock`（前端时钟降级为**兜底**，用于内核未表态/旧版内核的兼容路径）> `document`（无主机的预览夹具）。
3. **收敛推断**：`livenessSource === 'kernel'` 时，文档派生的 `generating` 与前端时钟的推测都不参与；
   前端那两条"采纳时钟"的启发式（`applyLive` 的实时帧采纳）在 `kernel` 可用时不再触发。

**保持不变**（本次不动的边界）：

- 行级 `running` 的**投影语义**不变（仍是"未见终态"），只有**显示层的活性判据**跟随权威（#212 判据 B）。
- 无 `livenessSource` 申报的宿主（preview / legacy / 浏览器 mock）继续按文档形状推断。
- `turnClocks` 继续存在：它承担**elapsed 起点**与终态摘要的职责（本 ADR 只迁移"是否在途"这一半）。

## 后果

- **正面**：活性不再依赖"本进程观察到了什么"。重启后打开旧会话、他端先开回合、回合被截断，
  三种情形下"是否在途"都由同一个事实回答，不会互相矛盾；前端少两条启发式。
- **负面 / 代价**：跨层契约增加一个字段，且**内核与前端必须同时更新**——旧前端 + 新内核/
  新前端 + 旧内核都要有兜底（这也是保留 `clock` 与 `document` 两级降级的原因）。
- **风险**：内核的"在途"标记若与终态事件失配（例如终态丢失、force-kill 后未清理），
  会出现**新的永久生成中**——而它比前端版本更难自查。防线：标记必须在终态路径（含 cancel、
  crash、进程树强杀）上无条件清理，并加"回合已不在途但标记仍为真"的诊断读数。

## 证据

- 根因与权宜修法：`.agents/records/issue-212-static-vs-live-split.md`（判据 B 一节）+
  issue #213 的验证表（6 例）。
- 内核已有事实的落点（实现时对齐）：`src-tauri/src/session/prompt.rs`（prompt 派发与终态收尾）、
  `src-tauri/src/dispatcher/mod.rs`（终态事件与 turn 账本）、`src-tauri/src/session/model.rs`
  （`last_activity` 等同级进程内字段的既有先例）。
- 症状真机复现：进程重启后打开未终结会话的显示证据见 #212 验收小节。

## 实施计划（分片）

| 片 | 内容 | 验收 |
| --- | --- | --- |
| K1 | 内核：在途回合标记 + 终态/cancel/crash 路径上的无条件清理 + 诊断读数 | Rust 单测（派发→终态→清理；cancel；强杀）+ "已不在途却仍为真"的读数 |
| K2 | 暴露面：经既有会话查询面输出该事实（不新增落盘字段、不改 journal 契约） | 契约测试 + 说明书同步 |
| K3 | 前端：`livenessSource: 'kernel'` 接入与优先级；`kernel` 可用时停用两条采纳启发式 | `livenessAuthority` 用例扩到三来源优先级 |
| K4 | 真机：重启后未终结会话 / 他端先开回合 / 回合被截断 —— 三种场景下 `generating` 与实际一致 | 场景化验收读数 |
