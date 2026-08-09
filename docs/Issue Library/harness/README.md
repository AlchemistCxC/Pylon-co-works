# Pylon 双人双 Agent Harness v2

本目录是跨机器双人协作的执行层。产品事实与任务依赖来自 `docs/Issue Library/INDEX.md` 和各 `ISSUE-NN.md`；Harness 只负责领取、隔离、实施、验证、交接与集成，不替代 Issue 决策。

## 角色

- `A`：主开发。负责功能、后端、数据、UI 基座和主线集成；默认使用长程模式。
- `B`：视觉与沉浸设计。负责动效、粒子、视觉 UI、沉浸模式；可使用长程模式或交互问答模式。
- `S`：共享任务。不是第三名开发者，表示任务会触碰共享契约，必须先冻结契约并由 A 执行集成。

## 唯一真值

1. `main`：可发布主线，由 A 或仓库维护者合并。
2. `docs/Issue Library/INDEX.md`：产品任务和依赖 DAG。
3. `tasks/*.yaml`：执行范围、模式和验收契约。
4. `contracts/active/*.yaml`：已冻结的共享契约。
5. Git commit/PR：跨机器实施事实。不得把仅存在于本机的 queue/current 文件当成协作真值。

## 启动顺序

1. `git fetch --prune`，确认本地没有不明修改。
2. 阅读 `CONSTITUTION.md`、目标任务卡及其 `inspect_first`。
3. 检查前置任务已经合并到目标 base commit。
4. 从远端最新 `main` 创建 `a/<task-id>-<slug>` 或 `b/<task-id>-<slug>` 分支；本机需要并行任务时再使用 worktree。
5. 运行 `python "docs/Issue Library/harness/scripts/validate_harness.py"`。
6. 按任务卡执行测试驱动循环，生成独立 commit 和 handoff。
7. 推送分支并发起 review；不得直接让两台机器共同写同一分支。

## 目录

```text
harness/
  README.md
  CONSTITUTION.md
  COLLABORATION.md
  OWNERSHIP.md
  CONTRACT-FREEZE.md
  MODES.md
  STATE-MACHINE.md
  VERIFICATION.md
  SAFETY.md
  MIGRATION.md
  manifest.yaml
  contracts/active/
  contracts/proposals/
  tasks/
  handoffs/
  templates/
  scripts/validate_harness.py
```

## 最短规则

- 一张任务卡、一个负责人、一个远端分支、一个可验收结果。
- B 默认只能改任务卡 `scope.allow` 内的视觉层；触碰 UI 基座先提 contract proposal。
- 未决策产品行为、共享契约变更、越界文件、破坏性命令必须停下。
- L1/L2/L3 是递进证据，不可用低等级代替高等级。
- 合并冲突由分支作者先解决；涉及共享契约时由 A 按冻结契约裁决。
