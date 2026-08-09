# Git 与跨机器协作协议

## 分支模型

- 主线：`main`，保护分支，只接受 review 后合并。
- A：`a/<task-id>-<slug>`。
- B：`b/<task-id>-<slug>`。
- 契约提案：`contract/<contract-id>-<slug>`，只含 proposal、必要类型草案和验证 fixture，不混入完整功能。
- 紧急修复：`hotfix/<task-id>-<slug>`，仍需独立验证和 review。

不建立长期 `develop-a`/`develop-b` 双轨。B 的工作基于最新稳定 UI 基座，短分支回流主线。

## 跨机器流程

1. 领取前 `git fetch --prune`，确认依赖 commit 已进入 `origin/main`。
2. 从 `origin/main` 建任务分支，不从对方未合并分支继续开发，除非任务卡明确 `integration_base`。
3. 推送后在 handoff 中记录远端分支和 commit，不记录本机绝对路径。
4. 合并前更新 `origin/main`：优先 rebase 自己的短分支；已经多人引用的分支不得改写历史，改用 merge main。
5. A 负责最终集成顺序和 main 回归；B 负责证明视觉行为、降级行为和性能预算。

## 同文件冲突

- 领取时任务卡声明 `scope.allow` 和 `shared_touchpoints`。
- 两张 active 任务卡若可能修改同一共享文件，不允许并行进入 `in_progress`；后领取者进入 `waiting_scope`。
- 普通冲突由分支作者依据 main 最新代码解决。
- 公共组件/API/token 冲突只能依据 `contracts/active/` 的冻结版本解决；无冻结版本则停止并发起 proposal。
- 禁止以 `ours/theirs` 整文件覆盖方式消冲突。

## Commit

格式：`<type>(<area>): [<task-id>] <结果>`。

示例：`feat(file): [I08-A-FE-03] 增加统一 FileViewHost tab identity`。

每个 commit 必须对应一个可验收子任务；文档、测试和实现可以同 commit，但不得混入其他任务。

## Review 闸门

- A 所有任务：至少完成任务卡 required evidence；涉及 B 所有权视觉层时请求 B review。
- B 纯视觉任务：B 自验 L2，A review 基座边界后合并。
- B 触碰共享基座：必须有 frozen contract，A review 并负责最终合并。
- S 任务：A 为 integrator；双方分别确认各自验收面。
