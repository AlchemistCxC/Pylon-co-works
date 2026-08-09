# 旧 Harness 清理记录

本次按用户拍板直接重写 `docs/Issue Library/harness/`：旧单 Agent 的 queue/lane/current/checkpoint 执行结构已删除，当前目录只保留双人双 Agent Harness。

## 已删除的旧结构

- `queue.json`
- `checkpoints.json`
- `events.jsonl`
- `lanes/`
- `current/`
- 旧 `tasks/*.yaml`
- 旧单 Agent `CONSTITUTION.md`/模板

## 历史追溯

旧数据仍可从 Git 历史读取，不在工作树保留第二套执行真值。当前唯一入口为 `docs/Issue Library/HARNESS.md` 和本目录 `README.md`。

## 迁移规则

- 旧 Issue 级 task 不继承状态；以当前 45 张 task card 重新领取。
- 旧 checkpoint 中仍有效的共享边界必须转成 `contracts/proposals/`，经冻结后才可实施。
- 不允许恢复旧 queue/current 作为并行锁；跨机器领取事实由远端分支、task card 和 handoff 表达。
