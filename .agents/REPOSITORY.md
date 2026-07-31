# Pylon Repository Map

## 根目录

- `src/`：React 前端生产源码（宫木云负责，工作区常含其未提交改动）。
- `src-tauri/`：Rust/Tauri 后端生产源码（Riccati 负责）。
- `scripts/`：前端 pure/contract regression；`scripts/agent-workflow/` 为调度辅助脚本。
- `docs/`：README 之外的产品设计与持续交接手册（`后端开发与交接手册.md` 是后端唯一交接入口）。
- `.agents/`：版本化工作流规则、任务定义和契约（任务卡在 `.agents/tasks/`）。
- `agents.yaml`：Agent subprocess registry，可能包含敏感运行配置，不向前端透出 env/args。
- `references/`：本地参考材料（Claude Code 源码图等）。

## 工作区

- 单仓库：`G:\Project\prism-desktop`，分支 `main`（与 origin 同步）。
- 后端与前端在同一工作区协作；前端 `src/` 通常有未提交改动（宫木云），后端不得 reset/clean/restore/add 他人文件。
- 子 agent 任务卡体系：`.agents/tasks/`（BE-* 后端 / FE-* 前端）+ `.agents/templates/subagent_dispatch.md` 派发模板。
- 历史：旧的 `prism-desktop-backend/frontend` 分离仓库与 `agent/backend`、`agent/frontend` 分支已废弃，勿用。

## src-tauri 后端地图

- `src/lib.rs`：AppState、Tauri commands、通知 dispatcher、崩溃自动重连、Session Inspector。
- `src/acp.rs`：AcpClient（官方 schema 类型化 + fake 测试基建）。
- `src/agent_runtime.rs`：生命周期状态 + 路由纯逻辑 + 重连退避。
- `src/runtime.rs`：AgentRuntime/AgentRuntimeManager（B7a，per-agent 隔离，尚未接线）。
- `src/gateway/`：平台适配器层（B10，骨架 + route/truncate/dedup 已实现未接线）。
- `src/prism.rs`：Prism loopback 客户端（39 命令）。
- `src/pet.rs` + `pet-core/`：宠物状态机 + 落盘持久化。
- 其余：`mcp.rs`、`runtime_log.rs`、`workspace.rs`、`agent_config.rs`、`error.rs`。

## 前端地图

（由 Frontend Lane 维护，本文件不展开）
