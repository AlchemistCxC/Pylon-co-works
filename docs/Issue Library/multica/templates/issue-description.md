# Multica Issue 描述模板

> 由 `scripts/export_multica_issues.py` 填充生成。Agent 执行时**必须 read_file 任务卡 yaml** 拿完整契约。

---

## 任务卡：{task_id}

**来源 ISSUE**：{issue}（`docs/Issue Library/{issue}.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/{task_id}.yaml` ← **执行前必读**

### 目标
{objective}

### 类型 / 归属 / 角色
- 类型：{type}
- 原归属：{owner}
- 执行角色：{role}（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
{depends_list}

### 验收标准
{acceptance_lines}

### 最低证据等级
{required_level}

### 验证命令
```bash
{focused_commands}
```

### 先读（inspect_first）
{inspect_first_list}

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = {task_id}
pylon.issue = {issue}
pylon.type = {type}
pylon.owner = {owner}
pylon.role = {role}
pylon.depends = {depends_meta}
pylon.level = {required_level}
```
