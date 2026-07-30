# 双 Lane 自动接力工作流

## 角色

- Backend Lane：`src-tauri/**`、`agents.yaml`、Rust fixture/harness、后端手册。
- Frontend Lane：`src/**`、业务 `scripts/**`、必要 `package.json`、前端手册。
- 主会话/协调者：设计任务卡、拆跨端任务、维护依赖图、执行集中 checkpoint 与 debug。

## 任务原则

任务按“可观察产品结果”拆，不按单文件拆。任务卡包含：目标、源码事实、首先读取、可能修改、禁止范围、实现不变量、非目标、最小验证和完成条件。

跨端目标必须拆成 Backend producer、Frontend consumer 和必要的 checkpoint，不直接自动分配给单 Lane。

## 状态机

```text
pending → ready → active → done
                  ├→ blocked
                  └→ active（handoff/resume）
```

- `pending`：依赖或 checkpoint 尚未满足。
- `ready`：可领取。
- `active`：当前 Lane 已领取。
- `blocked`：必须有准确解除条件。
- `done`：源码切片完成并记录 commit；不自动代表真实验收。

## 自动领取

`bootstrap.py`：

1. 校验 Lane 与 worktree。
2. 初始化或读取共享状态。
3. 如果 Lane 有 active task，则 RESUME。
4. 否则从 ready queue 评分领取。
5. 生成 `session-brief.md`。

评分考虑 priority、是否解除另一 Lane 阻塞、与上一任务 subsystem/读取文件的上下文亲和度、任务规模。checkpoint pending 时暂停相关 Lane。

## 自动分 Lane

任务卡可写 `lane: auto`。分配顺序：

1. 显式 lane 优先。
2. 单一 domain/path 归 Backend 或 Frontend。
3. 同时涉及前后端则 `needs_split`，不入队。
4. 信息不足则 `needs_planning`。

## 接力

任务未完成但需要换 Agent时，运行 `handoff.py`。current 保留 active task，新 Agent bootstrap 后自动 RESUME。共享 handoff 只保留当前版本，历史由事件日志和 Git 提交保存。

## 连续开发

默认一个 Agent 完成一个任务后停止。只有任务属于同一 `relay_group`、没有 checkpoint、上下文仍充足时，才使用 `finish_task.py --next` 自动领取下一项。

## 集中测试

日常只做最小验证。任务若声明 `opens_checkpoint`，完成后调度器将 checkpoint 标记 pending，并暂停指定 Lane。协调者集中测试/debug 后用 `checkpoint.py` passed/failed 更新状态。
