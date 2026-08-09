# Pylon × Multica 适配层（天璇小队）

> 本目录是 **Pylon Issue Library → Multica（天璇小队）** 的桥接层。
> 它**不替代、不修改** `docs/Issue Library/` 原有内容——任务卡 yaml（`harness/tasks/*.yaml`）仍是唯一真值，
> Multica issue 只是入口 + 引用。所有信息以原 Issue 文档为准，本层只负责"怎么让天璇小队接手执行"。

## 为什么需要本层

- Pylon 现有 45 张任务卡由单人/双人 Agent（角色 A/B/S）执行，状态机 22 态，证据 L1/L2/L3。
- 现在要把**剩余的 35 张 planned 卡**交给 Multica 天璇小队（6 个 agent：天璇/摇光/天玑/天权/玉衡/开阳）执行。
- Multica 的状态模型（6 态）与 Pylon 不同，需映射；Multica issue 是执行载体，需从任务卡生成。

## 工作流总览

```text
[Pylon 任务卡 yaml] ──export_multica_issues.py──▶ [Multica issue（描述引用 yaml）]
                                                        │
                        天璇(leader) 领卡 → 查依赖(done?) → 按角色路由派活
                                                        │
                    天玑(实现) / 开阳(测试) / 玉衡(审查) / 天权(发布) / 摇光(规格)
                                                        │
                    每步 issue 评论记录（= handoff 的 Multica 版）+ git commit
                                                        │
                        in_review → 人工验收(done) → 更新任务卡 yaml 状态
```

## 文件索引

| 文件 | 内容 |
|------|------|
| `AGENT-ROLES.md` | 六角色职责 + 任务类型→角色映射 + B 卡暂挂规则 |
| `STATUS-MAPPING.md` | Pylon 22 态 ↔ Multica 6 态 完整映射 |
| `EXECUTION-PROTOCOL.md` | Agent 执行协议：领卡/验证/commit/评论回报/验收 |
| `TASK-TO-ISSUE.md` | 35 张 planned 卡 → Multica issue 导入清单（脚本生成） |
| `templates/issue-description.md` | issue 描述模板（脚本填充用） |

## 真值规则（不可违反）

1. `docs/Issue Library/ISSUE-NN.md` = 产品事实（为什么做）
2. `docs/Issue Library/harness/tasks/<id>.yaml` = 执行契约（做什么/范围/验收/证据）——**唯一真值**
3. Multica issue = 入口 + 进度状态（谁在做/做到哪），**不是**事实副本
4. Agent 执行前必须 `read_file` 任务卡 yaml 拿完整 scope/evidence/commands，不得只凭 issue 描述动手
5. 状态变更以任务卡 yaml 为准；Multica issue 状态只反映"执行进度"，不回写 yaml 的验收证据

## 导入命令（35 张 planned 卡）

由 `scripts/export_multica_issues.py` 生成，见 `TASK-TO-ISSUE.md` 末尾的导入清单。
