from __future__ import annotations

import argparse

from common import LANES, append_event, checkpoints_path, current_path, handoff_path, load_task_definitions, queue_path, refresh_queue, save_json, state_dir, state_lock


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reset", action="store_true", help="重置共享运行状态；不会修改 Git 工作区")
    args = parser.parse_args()
    with state_lock():
        if queue_path().exists() and not args.reset:
            print(f"state already initialized: {state_dir()}")
            return
        definitions = load_task_definitions()
        checkpoints = {"version": 1, "checkpoints": {}, "updatedAt": None}
        queue = refresh_queue({"version": 1, "tasks": {}, "updatedAt": None}, definitions, checkpoints)
        save_json(queue_path(), queue)
        save_json(checkpoints_path(), checkpoints)
        for lane in LANES:
            save_json(current_path(lane), {"lane": lane, "taskId": None, "lastTaskId": None, "updatedAt": None})
            path = handoff_path(lane)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"# {lane.title()} Lane Handoff\n\n当前无 active task。\n", encoding="utf-8")
        append_event({"type": "state_initialized", "taskCount": len(definitions), "reset": args.reset})
    print(f"initialized {len(definitions)} tasks at {state_dir()}")


if __name__ == "__main__":
    main()
