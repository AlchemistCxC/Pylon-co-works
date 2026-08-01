from __future__ import annotations

import argparse
from pathlib import Path

from common import append_event, brief_path, checkpoints_path, current_path, ensure_workspace, git_snapshot, handoff_path, lane_checkpoint_pause, load_json, load_task_definitions, markdown_list, now_iso, queue_path, refresh_queue, save_json, state_lock, task_score


def build_brief(lane: str, mode: str, task: dict, item: dict, git: dict) -> str:
    scope = task.get("scope") or {}
    guidance = task.get("guidance") or {}
    verification = task.get("verification") or {}
    identity = "Pylon Rust/Tauri Backend 开发者" if lane == "backend" else "Pylon React/TypeScript Frontend 开发者"
    resume_text = "恢复上一位未完成任务；先看 handoff 和现有 diff，不要重新开始。" if mode == "RESUME" else "新领取任务；先快速复核 source_facts，再开始实现。"
    return f"""# Pylon Agent Session Brief

- 生成时间：{now_iso()}
- 模式：{mode}
- Lane：{lane}
- 身份：{identity}

## 工作区

- 路径：`{Path.cwd()}`
- 分支：`{git['branch']}`
- HEAD：`{git['head']}`

```text
{git['status'] or '(clean)'}
```

## 当前任务

- ID：`{task['id']}`
- 标题：{task['title']}
- 优先级：{task.get('priority')}
- 子系统：{task.get('subsystem')}
- 尺寸：{task.get('size')}
- 尝试次数：{item.get('attempt')}
- 任务卡：`{task['definition_path']}`
- 共享 Handoff：`{handoff_path(lane)}`

## 强制启动顺序

1. 读取 `AGENTS.md`
2. 读取 `.agents/CONSTITUTION.md`
3. 读取 `.agents/REPOSITORY.md`
4. 读取 `.agents/lanes/{lane}.md`
5. 读取本 Session Brief
6. 如果模式是 RESUME，读取共享 Handoff
7. 读取任务卡
8. 按下方 `首先读取` 定向读取源码

禁止使用 skill。遇事不决参考当前源码；不要先扫描全仓库，不要默认完整读取两份交接手册或大文件。

## 产品结果

- 用户结果：{(task.get('goal') or {}).get('user_result', '')}
- 技术结果：{(task.get('goal') or {}).get('technical_result', '')}

## 首先读取

{markdown_list(scope.get('inspect_first'))}

## 正常修改范围

{markdown_list(scope.get('likely_modify'))}

## 明确不修改

{markdown_list(scope.get('do_not_modify'))}

## 实现不变量

{markdown_list(guidance.get('invariants'))}

## 明确非目标

{markdown_list(guidance.get('non_goals'))}

## 开发中最小验证

{markdown_list(verification.get('during_development'))}

以下留到 checkpoint，不在日常机械执行：

{markdown_list(verification.get('checkpoint_only'))}

## 接管方式

- `{mode}`：{resume_text}
- 当前 task ID 必须贯穿 commit、finish 或 handoff。
- 完成身份确认后直接开发，不等待重复确认。

## 开工回报格式

只输出以下内容后立即开始：

```text
身份：
Lane：
当前任务：
模式：CLAIM / RESUME
工作区：
本轮范围：
明确非目标：
首先读取：
当前阻塞：
```

## 收尾

完成：

```bash
python scripts/agent-workflow/finish_task.py --lane {lane} --task {task['id']} --result completed --commit <sha>
```

接力：

```bash
python scripts/agent-workflow/handoff.py --lane {lane} --task {task['id']}
```

阻塞：

```bash
python scripts/agent-workflow/finish_task.py --lane {lane} --task {task['id']} --result blocked --reason "准确解除条件"
```
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lane", required=True, choices=["backend", "frontend"])
    args = parser.parse_args()
    lane = args.lane
    workspace = ensure_workspace(lane)
    if not queue_path().exists():
        raise SystemExit("shared state is not initialized; coordinator must run init_state.py first")
    with state_lock():
        definitions = load_task_definitions()
        queue = refresh_queue(load_json(queue_path(), {"tasks": {}}), definitions, load_json(checkpoints_path(), {"checkpoints": {}}))
        checkpoints = load_json(checkpoints_path(), {"checkpoints": {}})
        current = load_json(current_path(lane), {"lane": lane, "taskId": None, "lastTaskId": None})
        mode = "RESUME" if current.get("taskId") else "CLAIM"
        if mode == "RESUME":
            task_id = current["taskId"]
            item = queue["tasks"].get(task_id)
            if not item or item.get("state") != "active":
                raise RuntimeError(f"current task is inconsistent: {task_id}")
        else:
            pause = lane_checkpoint_pause(lane, checkpoints)
            if pause:
                print(f"CHECKPOINT_PENDING: {pause['id']} — 当前 Lane 暂停自动领任务。")
                save_json(queue_path(), queue)
                return
            last_task = definitions.get(current.get("lastTaskId"))
            candidates = []
            for task_id, item in queue["tasks"].items():
                task = definitions.get(task_id)
                if task and item.get("state") == "ready" and item.get("lane") == lane:
                    candidates.append((task_score(task, last_task), task_id, task, item))
            if not candidates:
                print(f"NO_READY_TASK: {lane}")
                save_json(queue_path(), queue)
                return
            candidates.sort(key=lambda value: (-value[0], value[1]))
            score, task_id, task, item = candidates[0]
            item["state"] = "active"
            item["attempt"] = int(item.get("attempt") or 0) + 1
            item["claimedAt"] = now_iso()
            item["reason"] = None
            current["taskId"] = task_id
            current["updatedAt"] = now_iso()
            append_event({"type": "task_claimed", "lane": lane, "taskId": task_id, "score": score})
        task_id = current["taskId"]
        task = definitions[task_id]
        item = queue["tasks"][task_id]
        save_json(queue_path(), queue)
        save_json(current_path(lane), current)
        git = git_snapshot(workspace)
        brief = build_brief(lane, mode, task, item, git)
        brief_path(lane).parent.mkdir(parents=True, exist_ok=True)
        brief_path(lane).write_text(brief, encoding="utf-8", newline="\n")
        append_event({"type": "session_bootstrap", "lane": lane, "taskId": task_id, "mode": mode, "head": git["head"]})
    print(brief)
    print(f"\nSESSION_BRIEF: {brief_path(lane)}")


if __name__ == "__main__":
    main()
