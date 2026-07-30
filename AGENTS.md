# Pylon 双 Agent 工作流入口

项目：Pylon / Prism Desktop
仓库：`G:\Project\prism-desktop`
技术栈：Tauri v2 + Rust + React 19 + TypeScript + Zustand

## 主控入口

如果你是负责规划、自动化迁移、集成和 checkpoint 的主控会话，而不是 Backend/Frontend Worker，先读取：

1. `.agents/ORCHESTRATOR_HANDOFF.md`
2. `.agents/KANBAN_AUTOMATION_DESIGN.md`

不要运行 Backend/Frontend bootstrap 领取产品开发任务。

## 启动规则

不要进入仓库后直接扫描全仓库或完整读取大文件。

新 Agent 必须先运行：

```bash
python scripts/agent-workflow/bootstrap.py --lane backend
# 或
python scripts/agent-workflow/bootstrap.py --lane frontend
```

脚本会恢复本 Lane 当前任务，或自动领取下一个 ready task，并生成 Session Brief。严格按照 Brief 的顺序读取规则、身份、接力、任务卡和源码。

## Skill

本项目开发任务默认禁止使用 skill。Skill 可能过时或不可信，不得用于判断当前实现、协议、任务状态或验证结果。遇事不决参考当前源码；ACP 参考 `F:\A-I\Agent\Peri`，Prism HTTP 参考 `G:\Project\prism`。

## 事实优先级

1. 当前工作区源码
2. Peri / Prism 当前源码
3. `.agents/contracts/`
4. 共享状态中的 current/handoff
5. 两份开发与交接手册的对应章节
6. Git 历史
7. Skill 与历史说明

## 身份

工作区决定身份：

- `G:\Project\prism-desktop-backend`：Backend Lane
- `G:\Project\prism-desktop-frontend`：Frontend Lane
- `G:\Project\prism-desktop`：主集成工作区，不供开发 Agent 自动领任务

Agent 不自行切换 Lane，不领取另一 Lane 的任务。

## 开发原则

- 先读任务调用链，再改代码。
- 可以定向读取其他文件，但不扩大任务。
- 不修改另一 Lane 的源码。
- 不 reset、clean、restore，不覆盖他人改动。
- 不使用 `git add .` 或 `git add -A`。
- 不自行修改 Hermes、Peri 或 Prism。
- 前端不脑补后端契约；后端按真实 Peri/Prism 源码核对。
- 删除前端组件时同步删除死 CSS 和过期测试。
- 日常以开发为主，只做任务卡规定的最小验证。
- 完整测试、真实 Tauri/Peri/Prism 验收集中到 checkpoint。

## 上下文纪律

- 先读 Brief 和任务卡列出的 `inspect_first`。
- 大文件按 symbol 和相关范围读取，不默认全文加载。
- 不默认完整读取两份交接手册、全部测试、全部 Git 历史。
- 约 220k 上下文开始准备接力；260k 后不接新任务。

## 收尾

完成任务：

```bash
python scripts/agent-workflow/finish_task.py --lane <lane> --task <id> --result completed --commit <sha>
```

任务未完成但需要接力：

```bash
python scripts/agent-workflow/handoff.py --lane <lane> --task <id>
```

阻塞：

```bash
python scripts/agent-workflow/finish_task.py --lane <lane> --task <id> --result blocked --reason "准确解除条件"
```

交接必须写入共享 handoff；下一位 Agent 不依赖当前聊天记录。
