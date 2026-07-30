from __future__ import annotations

import argparse

from common import checkpoints_path, current_path, load_json, load_task_definitions, queue_path, refresh_queue, save_json, state_lock


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lane", choices=["backend", "frontend"])
    args = parser.parse_args()
    with state_lock():
        definitions = load_task_definitions()
        queue = load_json(queue_path(), {"tasks": {}})
        checkpoints = load_json(checkpoints_path(), {"checkpoints": {}})
        queue = refresh_queue(queue, definitions, checkpoints)
        save_json(queue_path(), queue)
    lanes = [args.lane] if args.lane else ["backend", "frontend"]
    for lane in lanes:
        current = load_json(current_path(lane), {})
        print(f"\n[{lane}] current={current.get('taskId') or '-'} last={current.get('lastTaskId') or '-'}")
        for state in ["active", "ready", "pending", "blocked", "done"]:
            ids = [task_id for task_id, item in queue["tasks"].items() if item.get("lane") == lane and item.get("state") == state]
            print(f"  {state:7}: {', '.join(ids) if ids else '-'}")
    print("\n[checkpoints]")
    for checkpoint_id, checkpoint in checkpoints.get("checkpoints", {}).items():
        print(f"  {checkpoint_id}: {checkpoint.get('state')} openedBy={checkpoint.get('openedByTask')}")


if __name__ == "__main__":
    main()
