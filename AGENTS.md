# AGENTS.md · Pylon 协作规范

本文件规定**协作流程与约定**。代码规范见 [`.agents/dev-standards.md`](.agents/dev-standards.md)；项目情况见 [`README.md`](README.md)；架构与事实见 [`docs/说明书/`](docs/说明书/)。所有本文档路径采用相对路径。

---

## §0 项目定位

Pylon 是一个基于 [Agent Client Protocol（ACP）](https://agentclientprotocol.com/) 的通用 Agent GUI，提供高度可自定义的插件化GUI交互体验。

- **更多架构信息**：仓库 `docs/说明书/`——比 README 更丰富

## §1 协作模型

多个贡献者各自领取 issue、**并行开发**。标准工作流：

**拉取最新 main 到本地分支 → 完成任务 → review → 提交 PR**

职责边界：你负责实现、验证与记录。你不负责发布，当用户需要时。你可提供架构，方向，规划方面的建议，但你不代人做架构判断，裁断权留给你的用户。

署名：给自己起一个名字并沿用，起名规则见 [`.agents/BOARD.md`](.agents/BOARD.md)。

## §2 工作流

### 2.1 准备（每次会话开工前）

把 GitHub 远端 `main` 的代码合并进本地仓库，保持跟进状态。

- 合并前先处理手头的未提交改动
- **合并过程发生冲突时，一律以 `main` 为准**

### 2.2 领取任务

当收到与项目开发相关的消息（修复 bug、新增功能，重构等）时，先检查 GitHub 远端 issue 列表中该问题的情况：

- **未记录** → 检查有无表现极度相近的 issue；有则在其下附加评论（必要时登记 subissue）并修改状态为enhancement，无则登记并修改状态为enhancement。然后开展下一步。
- **已记录** → 优先读取并核查内容，将当前用户反馈补充在 issue 评论区中，然后开展下一步。

### 2.3 正式开工

1. 按 issue 内容 grep `docs/说明书/`，定位涉及区域获取相关说明，作为初步了解——**按需读取，不通读全仓**，后继续探索代码定位实际问题，请不要违背开发决策相关文件（你在开发前需要grep有没有已经落地的，会影响到本地任务的历史决策）
2. 定位问题区域后，尽力对齐用户需求，进行对齐工作，澄清模糊语义与决策，`.agents/spec/` 落地规格化文档（模板 `.agents/templates/spec.md`）。
4. 遵守 [`.agents/dev-standards.md`](.agents/dev-standards.md)（路线与技术决策记录在此）。若 issue 涉及路线与决策，按 [`.agents/templates/adr.md`](.agents/templates/adr.md) 的格式登记到 `.agents/decisions/`，注意，请不要在用户没有完成决策前就登记，
5. 进行并行多agent施工时，请在.agents下的"L.md"依照同目录的BOARD.md留下留言来应对冲突（文件互相改写，连带提交等等），写入后即立刻提交单个L.md文件使其他agent可见，留言简洁，避免冗长。

### 2.4 任务结束
- 测试检查：本项目有大量测试，优先进行对应单测，联动面积较广，改动范围大是跑全测，若测试红灯，须同时检查测试是否过时及你代码的逻辑错误，测试需修正时（契约变更/方法转变），修正测试并在最后向用户说明，提交时也附加说明。
- review：审查时优先派发子agent，派前需询问用户，退而求其次做法是自己重新审核一遍。若你的开发环境包含rust工具链，可构建二进制，并利用"tools\webview2-mcp"目录下给定的MCP工具进行实时运行验收（你需判断这一步的必要性，详情见该工具的Readme）。
- 若改动涉及 `docs/说明书/` 中的内容，为防漂移，**及时变更对应说明文件的相关表述**。
- 留下结构化的开发记录文档（模板 `.agents/templates/dev-record.md` → `.agents/records/`）。

### 2.5 提交与 PR

- commit **只包含**：文档变更 / 对应代码文件。不全量提交，commit时附加简要的提交说明。
- 优先基于本地既有分支提交pr，无远端分支时，创建远端分支后提交pr，并同步本地与远端，如无必要不创建专为单个issue的分支，优先在单个本地既有的主分支上工作，有严重并行冲突时再开新分支。 
- pr后不等待ci完成，向用户说明正在进行，让他注意即可。用户反映ci不通过时，抓取详情并修复。

## §3 issue 规范

| 类型 | 含义 |
|---|---|
| **bug** | 期望外的不良行为 |
| **功能变更** | 新增功能，或变更既有功能 |
| **重构** | 结构调整 |

登记 issue 时按 `.github/ISSUE_TEMPLATE/` 中对应模板的字段填写。

## §4 禁区

1. **不猜**——方案、意图、契约找不准时，停下来问。
2. **不改写历史**——禁止 `git commit --amend`、`git push --force`。

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
