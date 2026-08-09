#!/usr/bin/env python
from __future__ import annotations

import argparse
import fnmatch
import re
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[4]
HARNESS = ROOT / "docs" / "Issue Library" / "harness"
TASK_ID = re.compile(r"^I\d{2}-(A|B|S)-(FE|BE|TEST|DOC|UX|FX|SEC|DATA|OPS)-\d{2}$")
ABSOLUTE_PATH = re.compile(r"(?:[A-Za-z]:[\\/]|/Users/|/home/)")
PROTECTED = (".env", ".git/", "docs/archive/", "node_modules/", "dist/", "src-tauri/target/")
REQUIRED_FIELDS = (
    "id", "issue", "title", "type", "owner", "mode", "status", "depends_on",
    "contract_refs", "inspect_first", "scope", "acceptance", "evidence", "commands",
)


def run(*args: str) -> str:
    return subprocess.run(args, cwd=ROOT, check=True, text=True, capture_output=True).stdout


def load_yaml(path: Path) -> dict:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("YAML 根节点必须为 mapping")
    return data


def matches(path: str, patterns: list[str]) -> bool:
    normalized = path.replace("\\", "/")
    for pattern in patterns:
        pattern = pattern.replace("\\", "/")
        if fnmatch.fnmatchcase(normalized, pattern):
            return True
        if pattern.endswith("/**") and normalized.startswith(pattern[:-3].rstrip("/") + "/"):
            return True
        if pattern == normalized:
            return True
    return False


def validate_docs(errors: list[str]) -> None:
    for path in HARNESS.rglob("*"):
        if not path.is_file() or path.suffix not in {".md", ".yaml", ".yml", ".py"}:
            continue
        if path.name == "validate_harness.py":
            continue
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(ROOT).as_posix()
        for line_no, line in enumerate(text.splitlines(), 1):
            if ABSOLUTE_PATH.search(line):
                errors.append(f"{rel}:{line_no}: 出现绝对路径")


def validate_task_shape(path: Path, data: dict, errors: list[str]) -> None:
    rel = path.relative_to(ROOT).as_posix()
    missing = [field for field in REQUIRED_FIELDS if field not in data]
    if missing:
        errors.append(f"{rel}: 缺少字段 {', '.join(missing)}")
        return
    task_id = str(data["id"])
    if not TASK_ID.fullmatch(task_id):
        errors.append(f"{rel}: 非法 task id: {task_id}")
    if path.stem != task_id:
        errors.append(f"{rel}: 文件名必须与 id 相同")
    if data["owner"] not in {"A", "B", "S"}:
        errors.append(f"{rel}: owner 非法")
    if data["mode"] not in {"longrun-a", "longrun-b", "interactive-b"}:
        errors.append(f"{rel}: mode 非法")
    if data["owner"] == "A" and data["mode"] != "longrun-a":
        errors.append(f"{rel}: A 任务必须使用 longrun-a")
    if data["owner"] == "B" and data["mode"] not in {"longrun-b", "interactive-b"}:
        errors.append(f"{rel}: B 任务模式非法")
    scope = data.get("scope") or {}
    for key in ("allow", "deny", "read_only"):
        if not isinstance(scope.get(key), list):
            errors.append(f"{rel}: scope.{key} 必须是列表")
    if not scope.get("allow"):
        errors.append(f"{rel}: scope.allow 不能为空")
    commands = data.get("commands") or {}
    if not commands.get("focused"):
        errors.append(f"{rel}: commands.focused 不能为空")
    if not commands.get("broader"):
        errors.append(f"{rel}: commands.broader 不能为空")
    evidence = data.get("evidence") or {}
    if evidence.get("required_level") not in {"L1", "L2", "L3"}:
        errors.append(f"{rel}: evidence.required_level 非法")
    if not data.get("acceptance"):
        errors.append(f"{rel}: acceptance 不能为空")
    for value in [*data.get("inspect_first", []), *scope.get("allow", []), *scope.get("deny", []), *scope.get("read_only", [])]:
        if ABSOLUTE_PATH.search(str(value)):
            errors.append(f"{rel}: 路径必须为仓库相对路径: {value}")
    touchpoints = data.get("shared_touchpoints") or []
    refs = data.get("contract_refs") or []
    if touchpoints and not refs:
        errors.append(f"{rel}: shared_touchpoints 非空时必须填写 contract_refs")
    if "proposal-required" in refs and data.get("status") not in {"planned", "blocked_contract"}:
        errors.append(f"{rel}: contract 尚未冻结，不得进入执行状态")


def detect_cycles(tasks: dict[str, dict], errors: list[str]) -> None:
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(task_id: str, chain: list[str]) -> None:
        if task_id in visiting:
            errors.append("任务依赖存在循环: " + " -> ".join(chain + [task_id]))
            return
        if task_id in visited:
            return
        visiting.add(task_id)
        for dep in tasks[task_id].get("depends_on", []):
            if dep in tasks:
                visit(dep, chain + [task_id])
        visiting.remove(task_id)
        visited.add(task_id)

    for task_id in tasks:
        visit(task_id, [])


def validate_tasks(errors: list[str]) -> dict[str, dict]:
    tasks: dict[str, dict] = {}
    for path in sorted((HARNESS / "tasks").glob("*.yaml")):
        try:
            data = load_yaml(path)
        except Exception as exc:
            errors.append(f"{path.relative_to(ROOT).as_posix()}: YAML 解析失败: {exc}")
            continue
        validate_task_shape(path, data, errors)
        task_id = str(data.get("id", ""))
        if task_id in tasks:
            errors.append(f"重复 task id: {task_id}")
        tasks[task_id] = data
    for task_id, data in tasks.items():
        for dep in data.get("depends_on", []):
            if dep not in tasks:
                errors.append(f"{task_id}: 缺失依赖 {dep}")
    detect_cycles(tasks, errors)
    return tasks


def validate_scope(task: dict, base: str, errors: list[str]) -> None:
    try:
        changed = run("git", "diff", "--name-only", f"{base}...HEAD").splitlines()
    except subprocess.CalledProcessError as exc:
        errors.append(f"无法计算 scope diff: {exc.stderr.strip()}")
        return
    scope = task["scope"]
    allow = [str(value) for value in scope.get("allow", [])]
    deny = [str(value) for value in scope.get("deny", [])]
    read_only = [str(value) for value in scope.get("read_only", [])]
    for raw in changed:
        path = raw.replace("\\", "/")
        if path == ".env" or any(path.startswith(prefix) for prefix in PROTECTED[1:]):
            errors.append(f"受保护路径发生修改: {path}")
        if matches(path, deny):
            errors.append(f"{task['id']}: 修改命中 scope.deny: {path}")
        if matches(path, read_only):
            errors.append(f"{task['id']}: 修改命中 scope.read_only: {path}")
        if not matches(path, allow):
            errors.append(f"{task['id']}: 修改超出 scope.allow: {path}")


def main() -> int:
    parser = argparse.ArgumentParser(description="校验 Pylon 双人双 Agent Harness")
    parser.add_argument("--task", help="可选：对指定 task 执行 diff scope 检查")
    parser.add_argument("--base", help="scope 检查基准 commit/branch；与 --task 一起使用")
    args = parser.parse_args()
    errors: list[str] = []
    validate_docs(errors)
    tasks = validate_tasks(errors)
    if bool(args.task) != bool(args.base):
        errors.append("--task 与 --base 必须同时提供")
    elif args.task and args.base:
        task = tasks.get(args.task)
        if not task:
            errors.append(f"未知 task id: {args.task}")
        else:
            validate_scope(task, args.base, errors)
    if errors:
        print("Harness 校验失败：")
        for error in errors:
            print(f"- {error}")
        return 1
    print(f"Harness 校验通过：{len(tasks)} 张任务卡，依赖 DAG 无环")
    return 0


if __name__ == "__main__":
    sys.exit(main())
