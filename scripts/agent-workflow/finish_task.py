from __future__ import annotations

import argparse

from common import append_event, checkpoints_path, current_path, ensure_workspace, load_json, load_task_definitions, now_iso, queue_path, refresh_queue, run_git, save_json, state_lock


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lane", required=True, choices=["backend", "frontend"])
    parser.add_argument("--task", required=True)
    parser.add_argument("--result", required=True, choices=["completed", "blocked"])
    parser.add_argument("--commit")
    parser.add_argument("--reason")
    parser.add_argument("--next", action="store_true")
    args = parser.parse_args()
    workspace = ensure_workspace(args.lane)
    with state_lock():
        definitions = load_task_definitions()
        if args.task not in definitions:
            raise RuntimeError(f"unknown task: {args.task}")
        task = definitions[args.task]
        queue = load_json(queue_path(), {"tasks": {}})
        checkpoints = load_json(checkpoints_path(), {"checkpoints": {}})
        current = load_json(current_path(args.lane), {})
        if current.get("taskId") != args.task:
            raise RuntimeError(f"lane current task is {current.get('taskId')}, not {args.task}")
        item = queue["tasks"][args.task]
        if item.get("state") != "active":
            raise RuntimeError(f"task is not active: {args.task} ({item.get('state')})")
        if args.result == "completed":
            commit = args.commit or run_git(["rev-parse", "HEAD"], workspace)
            item.update({"state": "done", "completedAt": now_iso(), "commit": commit, "reason": None})
            current["lastTaskId"] = args.task
            current["taskId"] = None
            current["updatedAt"] = now_iso()
            checkpoint_id = task.get("opens_checkpoint")
            if checkpoint_id:
                checkpoints.setdefault("checkpoints", {})[checkpoint_id] = {"id": checkpoint_id, "state": "pending", "openedByTask": args.task, "openedByLane": args.lane, "openedAt": now_iso(), "resolvedAt": None, "report": None}
            append_event({"type": "task_completed", "lane": args.lane, "taskId": args.task, "commit": commit, "checkpoint": checkpoint_id})
        else:
            if not args.reason:
                raise RuntimeError("blocked result requires --reason")
            item.update({"state": "blocked", "reason": args.reason, "completedAt": None})
            current["lastTaskId"] = args.task
            current["taskId"] = None
            current["updatedAt"] = now_iso()
            append_event({"type": "task_blocked", "lane": args.lane, "taskId": args.task, "reason": args.reason})
        queue = refresh_queue(queue, definitions, checkpoints)
        save_json(queue_path(), queue)
        save_json(checkpoints_path(), checkpoints)
        save_json(current_path(args.lane), current)
    print(f"{args.task}: {args.result}")
    if args.result == "completed" and task.get("opens_checkpoint"):
        print(f"CHECKPOINT_PENDING: {task['opens_checkpoint']}")
    elif args.next:
        print(f"NEXT: python scripts/agent-workflow/bootstrap.py --lane {args.lane}")


if __name__ == "__main__":
    main()
