# AGENTS.md · Pylon 协作规范

本文件规定**协作流程与约定**。代码怎么写见 [`.agents/dev-standards.md`](.agents/dev-standards.md)；项目是什么见 [`README.md`](README.md)；架构与事实见 [`docs/说明书/`](docs/说明书/)。

---

## §0 项目是什么

Pylon 是一个基于 [Agent Client Protocol（ACP）](https://agentclientprotocol.com/) 的通用 Agent GUI，提供高度可自定义的视觉组件。

- **简要信息**：仓库根 [`README.md`](README.md)
- **更多架构信息**：仓库 `docs/说明书/`——比 README 更丰富

## §1 协作模型

多个贡献者各自领取 issue、**并行开发**。标准工作流：

**拉取最新 main 到本地分支 → 完成任务 → review → 检查 CI 门禁 → 提交 PR**

职责边界：你负责实现、验证与记录。你不负责发布，不负责他人的任务，也不代人做架构判断。

署名：给自己起一个名字并沿用，起名规则见 [`.agents/BOARD.md`](.agents/BOARD.md)。

## §2 工作流

### 2.1 准备（每次会话开工前）

把 GitHub 远端 `main` 的代码合并进本地仓库，保持跟进状态。

- 合并前先处理手头的未提交改动
- **合并过程发生冲突时，一律以 `main` 为准**

### 2.2 领取任务

当收到与项目开发相关的消息（修复 bug、新增功能等）时，先检查 GitHub 远端 issue 列表中该问题的情况：

- **未记录** → 检查有无表现极度相近的 issue；有则在其下附加评论，无则登记（必要时登记 subissue）。然后开展下一步。
- **已记录** → 优先读取并核查内容，将当前用户反馈补充在 issue 评论区中，然后开展下一步。

### 2.3 正式开工

1. 按 issue 内容 grep `docs/说明书/`，定位涉及区域——**按需读取，不通读全仓**。
2. 先对齐用户需求：在 `.agents/spec/` 落地规格化文档（模板 `.agents/templates/spec.md`）。这一步需要充分了解用户意图。
3. 依据 spec 文档进行开发。
4. 遵守 [`.agents/dev-standards.md`](.agents/dev-standards.md)（路线与技术决策记录在此）。若 issue 涉及路线与决策，按 [`.agents/templates/adr.md`](.agents/templates/adr.md) 的格式登记到 `.agents/decisions/`。
5. 正在进行并行多agent施工时，请在.agents下的"L.md"依照同目录的BOARD.md留下留言来应对冲突（文件互相改写，连带提交等等），写入后即立刻提交单个L.md文件使其他agent可见。

### 2.4 任务结束

- 若改动涉及 `docs/说明书/` 中的内容，为防漂移，**及时变更对应说明文件的相关表述**。
- 留下结构化的开发记录文档（模板 `.agents/templates/dev-record.md` → `.agents/records/`）。

### 2.5 提交与 PR

- commit **只包含**：文档变更 / 对应代码文件。避免全量提交，并附加简要的提交说明。
- 提交 PR 前，确保本地 CI 通过，优先基于本地既有分支提交pr，无远端分支时，创建远端分支然后提交pr并同步本地与远端的情况，如无必要不要创建太多专为某个issue的分支，专心在单个分支上工作。
## §3 issue 规范

| 类型 | 含义 |
|---|---|
| **bug** | 期望外的不良行为 |
| **功能变更** | 新增功能，或变更既有功能 |
| **重构** | 结构调整 |

登记 issue 时按 `.github/ISSUE_TEMPLATE/` 中对应模板的字段填写。

## §4 禁区

1. **不猜**——方案、意图、契约找不准时，停下来问；禁止猜测后施工。
2. **不改写历史**——禁止 `git commit --amend`、`git push --force`。
3. **不绕过门禁**——禁止 `--no-verify`，禁止跳过或删改检查脚本使门禁假绿；测试过时、无法适应新需求时，一并修改测试。

## §5 文件地图

| 主题 | 位置 |
|---|---|
| 项目简要信息 | `README.md` |
| 架构与说明书 | `docs/说明书/` |
| 领域术语 | `CONTEXT.md` |
| 协作流程（本文件） | `AGENTS.md` |
| 代码规范 | `.agents/dev-standards.md` |
| 规格文档（一次性，不入库） | `.agents/spec/` |
| 开发记录（入库保留） | `.agents/records/` |
| 路线决策 ADR | `.agents/decisions/` |
| 模板 | `.agents/templates/` |
| Agent 留言板 | `.agents/BOARD.md` |
| issue 模板 | `.github/ISSUE_TEMPLATE/` |

## §6 修订

本文件的修订需经仓库主批准。
