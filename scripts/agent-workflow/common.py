from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
WORKSPACES_FILE = REPO_ROOT / ".agents" / "workspaces.yaml"
PRIORITY_SCORE = {"P0": 100, "P1": 70, "P2": 40, "P3": 10}
SIZE_PENALTY = {"S": 0, "M": 3, "L": 10, "XL": 30}
LANES = ("backend", "frontend")


def load_yaml(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def save_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(temp, path)


def load_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def run_git(args: list[str], cwd: Path) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, text=True, encoding="utf-8", errors="replace", capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"git {' '.join(args)} failed")
    return result.stdout.strip()


def workspace_config() -> dict[str, Any]:
    return load_yaml(WORKSPACES_FILE)


def state_dir() -> Path:
    override = os.environ.get("PYLON_AGENT_STATE_DIR")
    return Path(override) if override else Path(workspace_config()["state_dir"])


def validate_lane(lane: str) -> None:
    if lane not in LANES:
        raise ValueError(f"unknown lane: {lane}; expected backend/frontend")


def lane_workspace(lane: str) -> Path:
    validate_lane(lane)
    return Path(workspace_config()[lane]["path"])


def task_index() -> list[Path]:
    index = load_yaml(REPO_ROOT / ".agents" / "tasks" / "index.yaml")
    return [REPO_ROOT / ".agents" / "tasks" / item for item in index.get("tasks", [])]


def infer_lane(task: dict[str, Any]) -> str:
    explicit = task.get("lane")
    if explicit in LANES:
        return explicit
    if explicit not in (None, "auto"):
        return "needs_planning"
    backend_domains = {"acp", "agent-runtime", "session-runtime", "tauri-command", "prism-transport", "workspace-backend", "runtime-backend", "export", "mcp-backend", "git-backend"}
    frontend_domains = {"react", "zustand", "workspace-sheet", "chat-ui", "right-panel", "settings-ui", "prism-ui", "git-ui", "frontend-verification"}
    domains = set(task.get("domains") or [])
    paths = set((task.get("scope") or {}).get("likely_modify") or [])
    backend = bool(domains & backend_domains) or any(p == "agents.yaml" or p.startswith("src-tauri/") for p in paths)
    frontend = bool(domains & frontend_domains) or any(p == "package.json" or p.startswith("src/") or p.startswith("scripts/") for p in paths)
    if backend and frontend:
        return "needs_split"
    if backend:
        return "backend"
    if frontend:
        return "frontend"
    return "needs_planning"


def load_task_definitions() -> dict[str, dict[str, Any]]:
    tasks: dict[str, dict[str, Any]] = {}
    for path in task_index():
        task = load_yaml(path)
        task["definition_path"] = str(path.relative_to(REPO_ROOT)).replace("\\", "/")
        task["resolved_lane"] = infer_lane(task)
        task_id = task["id"]
        if task_id in tasks:
            raise ValueError(f"duplicate task id: {task_id}")
        tasks[task_id] = task
    return tasks


def queue_path() -> Path:
    return state_dir() / "queue.json"


def checkpoints_path() -> Path:
    return state_dir() / "checkpoints.json"


def current_path(lane: str) -> Path:
    return state_dir() / lane / "current.json"


def handoff_path(lane: str) -> Path:
    return state_dir() / lane / "handoff.md"


def brief_path(lane: str) -> Path:
    return state_dir() / lane / "session-brief.md"


def append_event(event: dict[str, Any]) -> None:
    path = state_dir() / "events.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    event = {"time": now_iso(), **event}
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")


@contextmanager
def state_lock(timeout: float = 15.0):
    lock = state_dir() / ".lock"
    state_dir().mkdir(parents=True, exist_ok=True)
    deadline = time.time() + timeout
    while True:
        try:
            lock.mkdir()
            break
        except FileExistsError:
            if time.time() >= deadline:
                raise TimeoutError(f"agent state is locked: {lock}")
            time.sleep(0.1)
    try:
        yield
    finally:
        try:
            lock.rmdir()
        except OSError:
            pass


def dependencies_met(task: dict[str, Any], queue: dict[str, Any], checkpoints: dict[str, Any]) -> tuple[bool, list[str]]:
    missing: list[str] = []
    deps = task.get("dependencies") or {}
    for task_id in deps.get("tasks") or []:
        if queue.get("tasks", {}).get(task_id, {}).get("state") != "done":
            missing.append(f"task:{task_id}")
    for checkpoint_id in deps.get("checkpoints") or []:
        if checkpoints.get("checkpoints", {}).get(checkpoint_id, {}).get("state") != "passed":
            missing.append(f"checkpoint:{checkpoint_id}")
    return not missing, missing


def refresh_queue(queue: dict[str, Any], definitions: dict[str, dict[str, Any]], checkpoints: dict[str, Any]) -> dict[str, Any]:
    states = queue.setdefault("tasks", {})
    for task_id, task in definitions.items():
        item = states.setdefault(task_id, {"id": task_id, "state": "pending", "lane": task["resolved_lane"], "attempt": 0, "claimedAt": None, "completedAt": None, "commit": None, "reason": None})
        item["lane"] = task["resolved_lane"]
        if item["state"] in {"active", "done", "blocked"}:
            continue
        met, missing = dependencies_met(task, queue, checkpoints)
        if task["resolved_lane"] in LANES and met:
            item["state"] = "ready"
            item["reason"] = None
        else:
            item["state"] = "pending"
            item["reason"] = ", ".join(missing) if missing else task["resolved_lane"]
    queue["updatedAt"] = now_iso()
    return queue


def lane_checkpoint_pause(lane: str, checkpoints: dict[str, Any]) -> dict[str, Any] | None:
    for checkpoint in checkpoints.get("checkpoints", {}).values():
        if checkpoint.get("state") == "pending" and checkpoint.get("openedByLane") == lane:
            return checkpoint
    return None


def task_score(task: dict[str, Any], last_task: dict[str, Any] | None) -> int:
    score = PRIORITY_SCORE.get(task.get("priority", "P2"), 40)
    if task.get("blocks_other_lane"):
        score += 30
    score -= SIZE_PENALTY.get(task.get("size", "M"), 3)
    if last_task:
        if task.get("subsystem") == last_task.get("subsystem"):
            score += 20
        if task.get("relay_group") and task.get("relay_group") == last_task.get("relay_group"):
            score += 15
        current_files = set((task.get("scope") or {}).get("inspect_first") or [])
        previous_files = set((last_task.get("scope") or {}).get("inspect_first") or [])
        score += min(10, len(current_files & previous_files) * 2)
    return score


def git_snapshot(workspace: Path) -> dict[str, str]:
    return {"branch": run_git(["branch", "--show-current"], workspace), "head": run_git(["rev-parse", "--short", "HEAD"], workspace), "status": run_git(["status", "--short", "--branch"], workspace)}


def ensure_workspace(lane: str, cwd: Path | None = None) -> Path:
    expected = lane_workspace(lane).resolve()
    actual = (cwd or Path.cwd()).resolve()
    if actual != expected:
        raise RuntimeError(f"wrong workspace for {lane}: expected {expected}, current {actual}")
    branch = run_git(["branch", "--show-current"], actual)
    expected_branch = workspace_config()[lane]["branch"]
    if branch != expected_branch:
        raise RuntimeError(f"wrong branch for {lane}: expected {expected_branch}, current {branch}")
    return actual


def markdown_list(values: list[str] | None, empty: str = "- 无") -> str:
    if not values:
        return empty
    return "\n".join(f"{index}. `{value}`" for index, value in enumerate(values, 1))
