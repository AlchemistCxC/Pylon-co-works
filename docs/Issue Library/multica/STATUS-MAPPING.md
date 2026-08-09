# 状态映射：Pylon 任务卡 ↔ Multica issue

## Pylon 状态机（harness/STATE-MACHINE.md）

```text
planned → ready → claimed → in_progress
    ├→ waiting_answer / waiting_scope / blocked_decision / blocked_contract / blocked_evidence
    └→ implemented → review_pending → changes_requested → approved → integrated
        → verified_l1 → verified_l2 → verified_l3 → closed
```

## Multica issue 状态（原生）

```text
backlog → todo → in_progress → in_review → done
                     ├→ blocked
                     └→ cancelled
```

## 映射表（导入时与执行时）

| Pylon 状态 | Multica 状态 | 说明 |
|-----------|-------------|------|
| planned | `backlog` | 导入初始态 |
| ready | `todo` | 前置已就绪，可领取 |
| claimed | `todo` | 已建分支/认领 |
| in_progress | `in_progress` | 执行中 |
| waiting_answer | `in_progress` | 交互问答等待（issue 评论挂问题） |
| waiting_scope | `in_progress` | 等共享文件释放 |
| blocked_decision | `blocked` | 等用户拍板产品决策 |
| blocked_contract | `blocked` | 等契约冻结 |
| blocked_evidence | `blocked` | 等真实验收证据 |
| implemented | `in_review` | 实现完成，等审查 |
| review_pending | `in_review` | 等玉衡/人工审查 |
| changes_requested | `in_progress` | 审查打回，修复中 |
| approved | `in_review` | 审查通过，待合并 |
| integrated | `in_review` | 已合 main，待真实验收 |
| verified_l1/l2/l3 | `in_review` | 证据逐级通过（未到人工确认） |
| closed | `done` | 人工确认完成 |

## 执行规则

1. **Agent 只能推到 `in_review`**，`done` 必须人工（宫木云）确认——与 Pylon harness 一致
2. `blocked` 必须写清阻塞原因 + 关联的未决策项/契约
3. 状态变更时，**同步更新任务卡 yaml 的 `status` 字段**（git commit），Multica issue 状态只是镜像
4. 已完成卡（已合 main 的 10 张）不导入；如需追溯看 `harness/tasks/*.yaml` 原状态

## metadata 约定（供 issue list --metadata 查询）

```text
pylon.task_id    = 任务卡 id（如 I06-A-DATA-01）
pylon.issue      = ISSUE-NN（如 ISSUE-06）
pylon.type       = BE/FE/DOC/DATA/SEC/TEST/UX/FX
pylon.owner      = A/B/S（原归属）
pylon.role       = 天璇/摇光/天玑/天权/玉衡/开阳（执行角色）
pylon.depends    = 逗号分隔的前置任务卡 id
pylon.level      = L1/L2/L3（所需最低证据）
```
