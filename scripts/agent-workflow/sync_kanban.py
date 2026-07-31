from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
TASK_INDEX = REPO_ROOT / ".agents" / "tasks" / "index.yaml"
LEGACY_QUEUE = Path(r"G:\Project\prism-desktop-agent-state\queue.json")
BOARD = "pylon"
PROJECT = "pylon"
LANE_CONFIG = {
    "backend": {
        "assignee": "pylon-backend",
        "workspace": r"dir:G:\Project\prism-desktop-backend",
    },
    "frontend": {
        "assignee": "pylon-frontend",
        "workspace": r"dir:G:\Project\prism-desktop-frontend",
    },
}
PRIORITY = {"P0": 100, "P1": 70, "P2": 40, "P3": 10}
DEFAULT_MAX_RUNTIME = {"S": "45m", "M": "90m", "L": "3h", "XL": "5h"}


@dataclass(frozen=True)
class TaskSpec:
    id: str
    title: str
    lane: str
    priority: int
    size: str
    definition_path: str
    task_dependencies: tuple[str, ...]
    checkpoint_dependencies: tuple[str, ...]
    opens_checkpoint: str | None

    @property
    def assignee(self) -> str:
        return LANE_CONFIG[self.lane]["assignee"]

    @property
    def workspace(self) -> str:
        return LANE_CONFIG[self.lane]["workspace"]

    @property
    def idempotency_key(self) -> str:
        return f"pylon:{self.id}"

    @property
    def max_runtime(self) -> str:
        return DEFAULT_MAX_RUNTIME.get(self.size, "90m")


def load_yaml(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def load_specs() -> dict[str, TaskSpec]:
    index = load_yaml(TASK_INDEX) or {}
    specs: dict[str, TaskSpec] = {}
    for relative in index.get("tasks", []):
        definition = REPO_ROOT / ".agents" / "tasks" / relative
        raw = load_yaml(definition) or {}
        task_id = str(raw.get("id") or "").strip()
        if not task_id:
            raise ValueError(f"任务卡缺少 id：{definition}")
        if task_id in specs:
            raise ValueError(f"重复任务 id：{task_id}")
        lane = str(raw.get("lane") or "").strip()
        if lane not in LANE_CONFIG:
            raise ValueError(f"{task_id} lane={lane!r}，必须先拆分/规划，不能同步")
        dependencies = raw.get("dependencies") or {}
        definition_path = str(definition.relative_to(REPO_ROOT)).replace("\\", "/")
        specs[task_id] = TaskSpec(
            id=task_id,
            title=str(raw.get("title") or task_id).strip(),
            lane=lane,
            priority=PRIORITY.get(str(raw.get("priority") or "P2"), 40),
            size=str(raw.get("size") or "M"),
            definition_path=definition_path,
            task_dependencies=tuple(dependencies.get("tasks") or ()),
            checkpoint_dependencies=tuple(dependencies.get("checkpoints") or ()),
            opens_checkpoint=raw.get("opens_checkpoint"),
        )

    for spec in specs.values():
        missing = [dep for dep in spec.task_dependencies if dep not in specs]
        if missing:
            raise ValueError(f"{spec.id} 引用了未知 task dependency：{', '.join(missing)}")
    return specs


def load_legacy_done() -> set[str]:
    if not LEGACY_QUEUE.is_file():
        return set()
    with LEGACY_QUEUE.open("r", encoding="utf-8") as handle:
        queue = json.load(handle)
    return {
        task_id
        for task_id, item in (queue.get("tasks") or {}).items()
        if item.get("state") == "done"
    }


def worker_body(spec: TaskSpec) -> str:
    checkpoint_note = (
        "\n本卡完成后只报告 opens_checkpoint，不得自行放行后续卡："
        f"{spec.opens_checkpoint}。"
        if spec.opens_checkpoint
        else ""
    )
    return (
        f"你是 Pylon {spec.lane.title()} Worker。\n"
        f"版本化规格：{spec.definition_path}\n"
        "先调用 kanban_show()，再读取 AGENTS.md、对应 Lane 身份与任务卡。\n"
        "禁止使用 skill；Skill/旧聊天不能作为当前实现或验证事实。\n"
        "只完成当前任务；只在固定 Lane worktree 内修改；创建一个独立 commit。\n"
        "不要修改另一 Lane 源码，不要修改 Hermes、Peri 或 Prism。\n"
        "任务开发中只执行任务卡规定的最小验证。\n"
        "完成后调用 kanban_complete，metadata 必须包含 task_id、commit、"
        "changed_files、tests、unverified、follow_ups；不得只用自然语言退出。"
        f"{checkpoint_note}"
    )


def run_hermes(args: list[str]) -> dict[str, Any]:
    command = ["hermes", *args]
    result = subprocess.run(
        command,
        cwd=REPO_ROOT,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"命令失败（{result.returncode}）：{' '.join(command)}\n{detail}")
    output = result.stdout.strip()
    return json.loads(output) if output else {}


def existing_mapping() -> dict[str, str]:
    payload = run_hermes(["kanban", "--board", BOARD, "list", "--archived", "--json"])
    rows = payload if isinstance(payload, list) else payload.get("tasks", [])
    mapping: dict[str, str] = {}
    for row in rows:
        body = row.get("body") or ""
        for line in body.splitlines():
            if line.startswith("版本化规格："):
                definition = line.removeprefix("版本化规格：").strip()
                task_id = Path(definition).stem
                mapping[task_id] = row["id"]
                break
    return mapping


def select_specs(specs: dict[str, TaskSpec], selected: list[str]) -> list[TaskSpec]:
    if not selected:
        return list(specs.values())
    unknown = [task_id for task_id in selected if task_id not in specs]
    if unknown:
        raise ValueError(f"未知任务：{', '.join(unknown)}")
    return [specs[task_id] for task_id in selected]


def dry_run(specs: list[TaskSpec], done: set[str], existing: dict[str, str]) -> None:
    print(f"board={BOARD} project={PROJECT} mode=dry-run")
    for spec in specs:
        if spec.id in done:
            print(f"SKIP done  {spec.id}  {spec.title}")
            continue
        if spec.id in existing:
            print(f"REUSE     {spec.id} -> {existing[spec.id]}  {spec.title}")
            continue
        task_parents = [dep for dep in spec.task_dependencies if dep not in done]
        checkpoints = list(spec.checkpoint_dependencies)
        state = "checkpoint-gated" if checkpoints else ("todo" if task_parents else "ready")
        print(
            f"CREATE {spec.id} lane={spec.lane} assignee={spec.assignee} "
            f"workspace={spec.workspace} priority={spec.priority} size={spec.size} "
            f"state={state} parents={task_parents or '-'} checkpoints={checkpoints or '-'} "
            f"key={spec.idempotency_key}"
        )
        if spec.opens_checkpoint:
            print(f"  OPENS checkpoint={spec.opens_checkpoint}")


def apply(specs: list[TaskSpec], all_specs: dict[str, TaskSpec], done: set[str]) -> None:
    checkpoint_gated = [spec.id for spec in specs if spec.checkpoint_dependencies]
    if checkpoint_gated:
        raise ValueError(
            "以下任务含人工 checkpoint dependency，当前同步器拒绝提前创建，"
            "需 checkpoint 通过后显式同步：" + ", ".join(checkpoint_gated)
        )

    mapping = existing_mapping()
    pending = [spec for spec in specs if spec.id not in done and spec.id not in mapping]
    pending_ids = {spec.id for spec in pending}

    while pending:
        progressed = False
        for spec in list(pending):
            unresolved = [
                dep
                for dep in spec.task_dependencies
                if dep not in done and dep not in mapping
            ]
            if unresolved:
                if any(dep not in pending_ids for dep in unresolved):
                    raise ValueError(
                        f"{spec.id} 的父任务尚未同步：{', '.join(unresolved)}；"
                        "请同时选择父任务或先同步父任务"
                    )
                continue

            parent_ids = [mapping[dep] for dep in spec.task_dependencies if dep not in done]
            args = [
                "kanban", "--board", BOARD, "create", spec.title,
                "--body", worker_body(spec),
                "--assignee", spec.assignee,
                "--workspace", spec.workspace,
                "--priority", str(spec.priority),
                "--idempotency-key", spec.idempotency_key,
                "--max-runtime", spec.max_runtime,
                "--max-retries", "2",
                "--created-by", "pylon-orchestrator",
                "--json",
            ]
            for parent_id in parent_ids:
                args.extend(["--parent", parent_id])
            payload = run_hermes(args)
            kanban_id = payload["id"]
            mapping[spec.id] = kanban_id
            pending.remove(spec)
            pending_ids.remove(spec.id)
            progressed = True
            print(f"CREATED {spec.id} -> {kanban_id}")

        if not progressed:
            raise RuntimeError("任务 dependency 图无法推进，可能存在循环依赖")

    for spec in specs:
        if spec.id in done:
            print(f"SKIPPED {spec.id}（legacy done）")
        elif spec.id in mapping and spec not in pending:
            print(f"MAPPED  {spec.id} -> {mapping[spec.id]}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="将 Pylon 版本化 YAML 任务规格同步到 Hermes 原生 Kanban")
    parser.add_argument("--apply", action="store_true", help="实际创建卡；默认仅 dry-run")
    parser.add_argument("--task", action="append", default=[], help="只同步指定任务 id，可重复")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        all_specs = load_specs()
        specs = select_specs(all_specs, args.task)
        done = load_legacy_done()
        existing = existing_mapping()
        if args.apply:
            apply(specs, all_specs, done)
        else:
            dry_run(specs, done, existing)
        return 0
    except (ValueError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"sync_kanban: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
