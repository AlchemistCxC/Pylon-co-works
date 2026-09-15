# Dev Record — #97/#98 ACP 后端模型与能力审计落单

> 本记录保留 issue/spec 落地事实；本次没有实现代码、没有修改 ACP wire 或前端行为。

## 元信息

- issue：[ #97 通用 ACP 模型选择器与切换闭环](https://github.com/AlchemistCxC/Pylon-co-works/issues/97)
- issue：[ #98 ACP 能力协商与生命周期消费者闭环](https://github.com/AlchemistCxC/Pylon-co-works/issues/98)
- issue：[ #99 ACP 基础会话通信可靠性与回合生命周期](https://github.com/AlchemistCxC/Pylon-co-works/issues/99)
- 分支：`Ru5t/Reflector`
- 提交范围：`90c97b73..90c97b73`（仅审计与 issue/spec 落单，无代码提交）
- 日期：2026-09-15

## 目标与范围

将后端补强扩展成三个互不抢责任的 vertical slice：

1. #97 负责通用 ACP 模型面解析、模型切换路由、异步回写、权威状态和 generation 收敛。
2. #98 负责 capability canonical path、协商快照、生命周期消费者矩阵和 fail-closed 语义。
3. #99 负责基础 transport 投递、request/response 相关性、prompt/turn terminal ledger、live/replay sequence、冷挂载 snapshot 和 EOF/背压收敛。

三个 issue 都明确禁止按 Hermes/Peri 等 provider 写死分支；#99 不实现 selector/capability consumer，#98 不改模型状态，#97 不改 capability 协商。

## 变更清单

| 文件/外部对象 | 大致范围 | 性质 |
| --- | --- | --- |
| `.agents/spec/issue-model-switching-closed-loop.md` | #97 目标、现状证据、方案、不变量、验收、门禁 | 新增（本地一次性 spec，按仓库约定不入库） |
| `.agents/spec/issue-acp-capability-lifecycle-closed-loop.md` | #98 目标、现状证据、方案、不变量、验收、门禁 | 新增（本地一次性 spec，按仓库约定不入库） |
| GitHub #97 | 模型切换后端 vertical slice | 新建 issue，`enhancement` |
| GitHub #98 | ACP 能力/生命周期后端 vertical slice | 新建 issue，`enhancement` |
| GitHub #99 | ACP 基础通信可靠性与回合生命周期 | 新建 issue，`enhancement` |
| `.agents/records/issue-97-98-acp-backend-audit.md` | 本次审计和落单记录 | 新增 |

## 方案要点

- #97 将标准 `configOptions`、嵌套/根级 `availableModels` 统一收敛为模型面；真实 advertised config id 必须一路保留；空响应不能伪造单项 catalog；拒绝/钳制/过期 generation 需要可判定结果。新增 codge 对照责任：adopted-list 权威回写、reasoning/effort 等依赖 selector 重算、未知 option raw 保真、reconnect model-first 顺序和重复 push 幂等。
- #98 将 initialize 能力解析、session 建立、重连探针和 IPC/UI 投影改为共享 typed snapshot；标准嵌套路径优先，旧根级路径只作为显式 alias；未知能力 fail-closed。新增 codge 对照责任：真正可执行的 `session/fork`、external session identity/rebind、raw ACP 扩展桥、并发 permission/elicitation 队列，以及 advertised/negotiated/usable 三层 gate。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 两个 issue 已分别创建且无依赖 | 通过：#97、#98 均标记 `Blocked by: None` |
| issue 正文包含 Parent / What to build / Acceptance criteria / Blocked by | 通过 |
| spec 含现状证据、范围边界、通用化约束、测试和门禁 | 通过 |
| issue/spec 纳入 codge 大缺口而非 provider 特判 | 通过：#97/#98 已列 adopted selector、依赖重算、fork、raw 扩展、交互队列和 identity continuity |
| 基础通信 issue 覆盖 codge 对照出的 transport/turn 大缺口 | 通过：#99 已列静默丢帧、terminal ledger、raw 双轨、replay cursor、冷挂载和 EOF/generation 清理 |
| 本轮不施工代码 | 通过：未修改 `src/`、`src-tauri/`、`package.json` |

## 测试处置

本轮未运行实现门禁；既有审计验证结果已记录在前序会话：Rust 模型定向测试 16 passed，前端 ACP/模型相关测试 68 passed，`check:acp-shadow` 8 scenarios passed。实现 #97/#98 时必须按各自 spec 的门禁重新运行。

## 证据

- GitHub issue #97：<https://github.com/AlchemistCxC/Pylon-co-works/issues/97>
- GitHub issue #98：<https://github.com/AlchemistCxC/Pylon-co-works/issues/98>
- GitHub issue #99：<https://github.com/AlchemistCxC/Pylon-co-works/issues/99>
- 审计依据：`src-tauri/src/session/{control,model,create}.rs`、`src-tauri/src/dispatcher/mod.rs`、`src-tauri/src/acp/{capabilities,initialize_plan}.rs`、`src-tauri/src/lifecycle/mod.rs` 及前端 capability/model projection。
- 参考实现：本地 `codeg-src`；未联网搜索。

## 与 spec 的偏差

spec 文件按 `.gitignore` 约定保留在本地，不进入提交；issue 正文已同步完整 spec 内容。没有提前实现任何 spec 条目，也没有把审计发现写成已修复事实。

## 未决问题

- #97 的 tentative requested 状态是否持久化，需要实现时对齐现有 session schema。
- #98 的根级 capability alias 保留窗口、以及 sessionClose/MCP 缺失默认值迁移策略，需要实现前用现有 wire fixtures 决定并登记 ADR。

## 并行交集

三个 issue 可并行开发。若未来分支同时修改共享 ACP fixture/helper，应先在 `.agents/L.md` 留言并拆成只读公共测试基础；不得把一条 issue 的运行时状态改动偷偷带入另一条。
