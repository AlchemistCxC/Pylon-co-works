#!/usr/bin/env python3
"""export_multica_issues.py — Pylon 任务卡 → Multica issue 导入清单生成器

用法（仓库根）：
    python scripts/export_multica_issues.py [--all] [--status planned]

默认：只导 status=planned 的任务卡（已完成卡不导入 Multica）。
--all   导全部卡（含已完成/进行中，作为状态档案）。

输出：
    docs/Issue Library/multica/TASK-TO-ISSUE.md   导入清单（Markdown 表 + 每卡描述）
    stdout 打印摘要 + 导入提示

真值规则：本脚本只读任务卡 yaml 生成入口文档，不改动原文件。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
TASKS_DIR = REPO_ROOT / "docs" / "Issue Library" / "harness" / "tasks"
OUT_FILE = REPO_ROOT / "docs" / "Issue Library" / "multica" / "TASK-TO-ISSUE.md"

# 任务类型 → 执行角色（见 multica/AGENT-ROLES.md）
ROLE_MAP = {
    "BE": "天玑",
    "FE": "天玑",
    "DOC": "天璇",
    "DATA": "天玑",
    "SEC": "天玑+玉衡双审",
    "TEST": "开阳",
    "UX": "blocked-awaiting-role-B",
    "FX": "blocked-awaiting-role-B",
}


def load_tasks() -> list[dict]:
    tasks = []
    for f in sorted(TASKS_DIR.glob("*.yaml")):
        data = yaml.safe_load(f.read_text(encoding="utf-8", errors="replace")) or {}
        if data.get("id"):
            data["_file"] = f.name
            tasks.append(data)
    return tasks


def fmt_list(items) -> str:
    """列表转 markdown 列表；非列表原样返回。"""
    if items is None:
        return "- 见任务卡 yaml"
    if isinstance(items, list):
        if not items:
            return "- 无"
        return "\n".join(f"- {i}" for i in items)
    return str(items)


def render_description(card: dict) -> str:
    task_id = card.get("id", "?")
    issue = card.get("issue", "?")
    card_type = card.get("type", "")
    role = ROLE_MAP.get(card_type, "天玑")

    depends = card.get("depends_on") or []
    depends_list = "\n".join(f"- {d}" for d in depends) if depends else "- 无"

    acceptance = card.get("acceptance") or []
    if acceptance:
        acc_lines = "\n".join(
            f"- {a.get('id','')}: {a.get('behavior','')}" for a in acceptance
        )
    else:
        acc_lines = "- 见任务卡 yaml"

    commands = card.get("commands") or {}
    cmd_list = commands.get("focused", []) + commands.get("broader", [])
    cmd_lines = "\n".join(f"{c}" for c in cmd_list) if cmd_list else "- 见任务卡 yaml"

    inspect = card.get("inspect_first") or []
    inspect_lines = fmt_list(inspect)

    scope = card.get("scope") or {}
    scope_allow = scope.get("allow") or []
    scope_deny = scope.get("deny") or []
    scope_allow_txt = "\n".join(f"  - {s}" for s in scope_allow) if scope_allow else "  - （见 yaml）"
    scope_deny_txt = "\n".join(f"  - {s}" for s in scope_deny) if scope_deny else "  - docs/archive/**, .env*（默认）"

    implementation = card.get("implementation_contract") or {}
    inv_lines = fmt_list(implementation.get("invariants"))

    depends_meta = ",".join(depends) if depends else ""
    level = (card.get("evidence") or {}).get("required_level", "见任务卡 yaml")

    return f"""## 任务卡：{task_id}

**来源 ISSUE**：{issue}（`docs/Issue Library/{issue}.md`）
**任务卡 yaml**：`docs/Issue Library/harness/tasks/{task_id}.yaml` ← **执行前必读**

### 目标
{card.get("objective", "见任务卡 yaml")}

### 类型 / 归属 / 角色
- 类型：{card_type}
- 原归属：{card.get("owner", "?")}
- 执行角色：{role}（见 `docs/Issue Library/multica/AGENT-ROLES.md`）

### 依赖（前置必须 done 才可开工）
{depends_list}

### 验收标准
{acc_lines}

### 不变量（implementation_contract.invariants）
{inv_lines}

### 最低证据等级
{level}

### 验证命令（focused + broader）
```bash
{cmd_lines}
```

### 先读（inspect_first）
{inspect_lines}

### scope（严格遵守）
```text
allow:
{scope_allow_txt}
deny:
{scope_deny_txt}
```

### 执行要求
1. `read_file` 任务卡 yaml，严格遵守 `scope.allow/deny`
2. 按 `docs/Issue Library/multica/EXECUTION-PROTOCOL.md` 执行（TDD → 验证 → commit → 玉衡审查 → 评论回报）
3. 完成后 issue 评论写回报（handoff 格式），状态推 `in_review`；**done 留人工**

### metadata（供查询）
```text
pylon.task_id = {task_id}
pylon.issue = {issue}
pylon.type = {card_type}
pylon.owner = {card.get("owner", "?")}
pylon.role = {role}
pylon.depends = {depends_meta}
pylon.level = {level}
```
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--all", action="store_true", help="导全部卡（含已完成/进行中）")
    ap.add_argument("--status", default="planned", help="只导该状态的卡（默认 planned）")
    args = ap.parse_args()

    tasks = load_tasks()
    if args.all:
        selected = tasks
    else:
        selected = [t for t in tasks if (t.get("status") or "").strip() == args.status]

    if not selected:
        print(f"没有 status={args.status} 的任务卡", file=sys.stderr)
        return 1

    lines = [
        "# Pylon → Multica 任务导入清单（TASK-TO-ISSUE）",
        "",
        f"> 由 `scripts/export_multica_issues.py` 生成（{len(selected)} 张卡，filter: {'all' if args.all else 'status=' + args.status}）。",
        "> 真值源：`docs/Issue Library/harness/tasks/*.yaml`。本文件是导入 Multica 的入口。",
        "",
        "## 导入方式",
        "",
        "在 Multica 中为每张卡创建一个 issue，标题用任务卡 id（如 `I06-A-DATA-01`），",
        "描述粘贴下方对应章节。metadata 按约定设置（见 STATUS-MAPPING.md）。",
        "",
        "## 任务列表",
        "",
        "| 任务卡 | ISSUE | 类型 | 归属 | 角色 | 状态 | 依赖 |",
        "|--------|-------|------|------|------|------|------|",
    ]
    for t in sorted(selected, key=lambda x: (x.get("issue", ""), x.get("id", ""))):
        depends = ",".join(t.get("depends_on") or []) or "-"
        lines.append(
            f"| {t.get('id','?')} | {t.get('issue','?')} | {t.get('type','?')} "
            f"| {t.get('owner','?')} | {ROLE_MAP.get(t.get('type',''),'天玑')} "
            f"| {t.get('status','?')} | {depends} |"
        )

    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 各卡详情（导入 Multica issue 时粘贴对应章节）")
    lines.append("")

    for t in sorted(selected, key=lambda x: (x.get("issue", ""), x.get("id", ""))):
        lines.append(render_description(t))
        lines.append("")

    OUT_FILE.write_text("\n".join(lines), encoding="utf-8")
    print(f"OK: {len(selected)} 张卡 → {OUT_FILE.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

