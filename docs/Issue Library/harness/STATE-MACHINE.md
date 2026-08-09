# 双人跨机器任务状态机

```text
planned
  → ready
  → claimed
  → in_progress
      → waiting_answer
      → waiting_scope
      → blocked_decision
      → blocked_contract
      → blocked_evidence
      → implemented
  → review_pending
  → changes_requested
  → approved
  → integrated
  → verified_l1
  → verified_l2
  → verified_l3
  → closed
```

## 规则

- `claimed`：已建立远端分支，任务卡写入 assignee、base commit、mode。
- `in_progress`：依赖已在 base 中且 scope guard 通过。
- `waiting_answer`：仅用于交互问答；问题和恢复条件必须持久化。
- `implemented`：实现 commit 存在，focused test 通过，但未代表 review/集成。
- `approved`：review 通过，仍未进入 main。
- `integrated`：commit 已进入 main，记录 merge commit。
- `verified_lN`：只表示该等级证据通过；L1 不自动提升 L2/L3。
- `closed`：任务卡要求的最高 evidence 已通过，Issue 索引已同步。

## Lease

跨机器不使用可失效的本地 lock 文件。领取事实由远端分支和任务卡 PR 表达。长程 Agent 每次 handoff 更新 `last_progress_commit`；超过约定时间没有新 commit 时，另一方只能新建 recovery 分支，不得直接接管原分支。

## 恢复

recovery 分支命名：`recover/<task-id>-<short-sha>`。先 cherry-pick 已验证 commit，再按 handoff 恢复；未提交工作只能由原作者处理。
