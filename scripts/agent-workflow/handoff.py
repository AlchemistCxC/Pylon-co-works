from __future__ import annotations

import argparse
from pathlib import Path

from common import append_event, current_path, ensure_workspace, git_snapshot, handoff_path, load_json, load_task_definitions, now_iso


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lane", required=True, choices=["backend", "frontend"])
    parser.add_argument("--task", required=True)
    args = parser.parse_args()
    workspace = ensure_workspace(args.lane)
    current = load_json(current_path(args.lane), {})
    if current.get("taskId") != args.task:
        raise RuntimeError(f"lane current task is {current.get('taskId')}, not {args.task}")
    task = load_task_definitions()[args.task]
    git = git_snapshot(workspace)
    template = f"""# {args.lane.title()} Lane Handoff

更新时间：{now_iso()}

## 身份与任务

- Lane：{args.lane}
- Task：{args.task} {task['title']}
- Branch：{git['branch']}
- HEAD：{git['head']}

```text
{git['status'] or '(clean)'}
```

## 已完成

- TODO：精确到用户结果、文件和 symbol。

## 未完成

- TODO：写准确剩余步骤和原因。

## 修改文件与关键 symbol

- TODO

## 实际验证

- TODO：命令、exit code、证明层级。

## 下一步第一条操作

1. TODO：下一位打开哪个文件、从哪个 symbol 继续。

## 不要重新做

- TODO：已证伪方案、已完成步骤、不要恢复的旧实现。

## 阻塞与解除条件

- 无 / TODO
"""
    handoff_path(args.lane).parent.mkdir(parents=True, exist_ok=True)
    handoff_path(args.lane).write_text(template, encoding="utf-8", newline="\n")
    append_event({"type": "handoff_prepared", "lane": args.lane, "taskId": args.task, "head": git["head"]})
    print(f"handoff template: {handoff_path(args.lane)}")
    print("填写完成后结束当前 Agent；下一位 bootstrap 会自动 RESUME。")


if __name__ == "__main__":
    main()
