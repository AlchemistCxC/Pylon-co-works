# Pylon 协作工作流

## 当前工作流（2026-07-31 起）

主控（协调者）+ 子 agent 派发 + 任务卡体系：

```text
主控（Riccati 会话）
  ├─ 切分任务 → .agents/tasks/ 任务卡（YAML，自包含）
  ├─ 派发：delegate_task（自包含任务文本，一次最多 3 个并行）
  ├─ 验收：复跑 cargo check/test + 抽查 commit；子 agent 中间态与真 bug 要区分
  └─ 保留架构/高集成任务自己做（B7a 重构、gateway 骨架接线等）

子 agent（leaf）
  ├─ 无对话上下文 → 任务卡必须自包含（背景/目标/文件边界/验证/commit 格式）
  ├─ 独立 commit，不 push（主控统一推）
  └─ 铁律：只改任务指定文件；cargo check 零 warning（自身文件）；测试真实断言
```

派发模板：`.agents/templates/subagent_dispatch.md`。

## 角色

- Backend Lane：`src-tauri/**`、`agents.yaml`、Rust fixture/harness、后端手册、`.agents` 任务卡。
- Frontend Lane：`src/**`、业务 `scripts/**`、必要 `package.json`、前端手册。
- 主控/协调者：切分任务卡、维护依赖图、派发与验收、集中 checkpoint。

## 任务原则

- 任务按"可观察产品结果"拆，不按单文件拆；子 agent 任务额外要求"机械/自包含/验收明确"。
- 任务卡包含：目标、源码事实、首先读取、可能修改、禁止范围、实现不变量、非目标、最小验证和完成条件。
- 跨端目标拆成 Backend producer、Frontend consumer 和必要 checkpoint，不直接自动分配给单 Lane。

## 历史

- 自研 JSON queue/bootstrap 与 Hermes 原生 Kanban Dispatcher 迁移设计（`KANBAN_AUTOMATION_DESIGN.md`）为早期方案；当前以 delegate_task 派发为准，旧 queue 不再分发新任务。若未来启用 Hermes Kanban，以 `KANBAN_AUTOMATION_DESIGN.md` 为迁移蓝本并更新本文。
