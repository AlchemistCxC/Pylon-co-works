# Handoff: I01-A-DOC-01

- 角色/模式：A / `longrun-a`
- 远端分支：`a/I01-A-DOC-01-release-boundary`
- Base commit：`3c95f709bc0cdc97b97603f338b44637fdf51143`
- HEAD commit：`c1b664c`
- 状态：`review_pending`，L1 已通过；PR：`#1`

## 已完成

- 将 Release 1.x 产品边界冻结为“多 Agent 可配置、GUI 单活切换”。
- 明确多个 Agent Sheet 不等于 GUI 并行；非 active Agent 必须先成功切换才能发起业务命令。
- 冻结结构化 `AgentContextKey = { agentId, source }`、Session 永久归属和 source-only 数据兼容迁移约束。
- 明确 Agent/Session/source/workspace 归属错误时显式失败，禁止回退 `agent_cwd`。
- 将并行生成、runtime 资源策略和 Session 复制标为 2.0 资料，不进入当前 Release DAG 或能力声明。

## 实际验证

| 命令/行为 | 结果 | 证据等级 | 证据路径 |
|---|---|---|---|
| `python "docs/Issue Library/harness/scripts/validate_harness.py"` | 通过；45 张任务卡，DAG 无环 | L1 | 命令输出 |
| 冻结契约矛盾短语扫描 | 通过；旧的“当前 Release 真并行/不采用单活/仍需拍板”表述不存在 | L1 | `ISSUE-01.md` |
| `npm run lint` | 通过 | L1 | 命令输出 |
| `npm run build` | 通过；Vite 转换 3504 modules | L1 | 命令输出 |
| `git diff --check` | 通过 | L1 | 命令输出 |

## 工作区

```text
分支 a/I01-A-DOC-01-release-boundary，任务实现提交领先远端 1 个 commit。
任务范围内文件已提交；工作区仍保留领取前已有的其他 Issue/Harness 暂存文件及截图删除，均未纳入本任务提交、未修改、未清理。
```

## 阻塞与失败证据

- 无产品或契约阻塞。
- 首次验证调用 `npm` 时被 PowerShell execution policy 拦截 `npm.ps1`；改用同工具链目录的 `npm.cmd` 后 lint/build 均通过，属于入口包装器问题。

## 下一条确定动作

1. 推送本任务的实现与 handoff commit，发起 review/integration。
2. 合并后按 INDEX 依赖顺序领取 `I01-A-BE-01`，实现 AgentContext 与 workspace/Git 路由 guard。

## 不得假定

- L1 文档、lint 和 build 通过不代表后续路由实现或真实 Tauri L3 已通过。
- Gateway 的多 runtime 路由不代表当前 GUI 支持多 Agent 并行。
- 不得在错误 source 下回退 active Agent cwd。
