from __future__ import annotations

import argparse

from common import append_event, checkpoints_path, load_json, load_task_definitions, now_iso, queue_path, refresh_queue, save_json, state_lock


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--id", required=True)
    parser.add_argument("--result", required=True, choices=["passed", "failed"])
    parser.add_argument("--report")
    args = parser.parse_args()
    with state_lock():
        checkpoints = load_json(checkpoints_path(), {"checkpoints": {}})
        checkpoint = checkpoints.setdefault("checkpoints", {}).get(args.id)
        if not checkpoint:
            raise RuntimeError(f"unknown checkpoint: {args.id}")
        if checkpoint.get("state") != "pending":
            raise RuntimeError(f"checkpoint is not pending: {args.id} ({checkpoint.get('state')})")
        checkpoint["state"] = args.result
        checkpoint["resolvedAt"] = now_iso()
        checkpoint["report"] = args.report
        definitions = load_task_definitions()
        queue = refresh_queue(load_json(queue_path(), {"tasks": {}}), definitions, checkpoints)
        save_json(checkpoints_path(), checkpoints)
        save_json(queue_path(), queue)
        append_event({"type": "checkpoint_resolved", "checkpoint": args.id, "result": args.result, "report": args.report})
    print(f"{args.id}: {args.result}")
    if args.result == "failed":
        print("集中测试失败不会自动发明 debug task；由协调者根据真实错误创建任务卡。")


if __name__ == "__main__":
    main()
