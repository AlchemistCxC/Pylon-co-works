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

署名分两档：**开发记录与施工声明（`.agents/records/`、`.agents/L.md`）用稳定署名**——跨会话追溯责任靠它；`.agents/BOARD.md` 留言板属闲聊，署名随意，起名规则见该文件。

## §2 工作流

### 2.1 准备（每次会话开工前）

把远端 `github/main` 的代码合并进本地仓库，保持跟进状态（本仓远端名为 `github`，**没有 `origin`**）。

- 开工第一条命令是 `git status`；合并前先处理**手头**的未提交改动
- **代码冲突一律以 `main` 为准**
- **纯追加型文件例外**：`.agents/L.md`、两份 `BOARD.md`、`.agents/records/` 的冲突几乎总是「两边各追加了不同条目」，正确解法是**保留双方条目**，不是取单边
- **这是共享工作树，改动不都是你的。** 若 `git status` 显示他人在途改动、或 `MERGE_HEAD` 存在（合并未完成）：**不 `abort`、不 `stage`、不 `commit`**，只在 `.agents/L.md` 声明并绕开对方文件域，等对方收工

### 2.2 领取任务

先判断这是**咨询**还是**施工**。

**咨询／评估／讨论**（提问、问「这样行不行」、让你判断某处是否合理）→ **只作答**。基于 `docs/说明书/`、`CONTEXT.md` 与代码里的事实回答，不凭印象；说明书答不上来或没有该条，就直说这是缺口，由用户决定要不要变成任务。**不动文件、不登记 issue**，除非用户明确要求动手。

**施工**（修复 bug、新增功能、重构等）→ 先检查 GitHub 远端 issue 列表中该问题的情况：

- **未记录** → 检查有无表现极度相近的 issue；有则在其下附加评论（必要时登记 subissue），无则登记。**类型标签按 §3 选对应模板**：bug／功能变更（`enhancement`）／重构（`refactor`）。**「谁在做」不写进标签**——用 issue 的 **assignee** 标记认领，与类型标签互不占用名字空间。
- **已记录** → 优先读取并核查内容，将当前用户反馈补充在 issue 评论区中，并**认领**（assignee 设为自己）。然后开展下一步。

### 2.3 正式开工
0. 如果你是deepseek系列模型，**注意峰谷**，周一到周五的早上9点到午12点，下午2到6点**双倍计费**，提醒用户。
1. 按 issue 内容 grep `docs/说明书/`，定位涉及区域获取相关说明，作为初步了解——**按需读取，不通读全仓**，后继续探索代码定位实际问题，请不要违背开发决策相关文件（你在开发前需要grep有没有已经落地的，会影响到本地任务的历史决策）
2. 定位问题区域后，尽力对齐用户需求，进行对齐工作，澄清模糊语义与决策，而后在`.agents/spec/` 落地规格化文档（模板 `.agents/templates/spec.md`），这一步目的是方便追溯。
3. 遵守 [`.agents/dev-standards.md`](.agents/dev-standards.md)（路线与技术决策记录在此）。若 issue 涉及路线与决策，按 [`.agents/templates/adr.md`](.agents/templates/adr.md) 的格式登记到 `.agents/decisions/`，注意，请不要在用户没有完成决策前就登记，
4. 进行并行多agent施工时，请在 [`.agents/L.md`](.agents/L.md) 留下留言声明施工范围以应对冲突（文件互相改写、连带提交等等），写入后即立刻提交单个 `L.md` 文件使其他 agent 可见，留言简洁，避免冗长。**`L.md` 只留在途条目**：自己的 issue 合入后即可把自己的条目移除；文件过长时把旧条目归档到仓外 `Docs/Archive/` 并更新文件头指针。

### 2.4 任务结束
- 测试检查：本项目有大量测试，优先进行对应单测，联动面积较广，改动范围大是跑全测，若测试红灯，须同时检查测试是否过时及你代码的逻辑错误，测试需修正时（契约变更/方法转变），修正测试并在最后向用户说明，提交时也附加说明。
- review：审查时优先派发子agent，派前需询问用户，退而求其次做法是自己重新审核一遍。若你的开发环境包含 rust 工具链，可构建二进制，并利用 `tools/webview2-mcp/`（或发行包下同目录）的 MCP 工具做**实时运行验收**——前置、步骤与本仓特有的坑见 skill [`.agents/skills/webview2-acceptance/SKILL.md`](.agents/skills/webview2-acceptance/SKILL.md)，工具参考见该目录 Readme；是否需要走到这一步由你判断。
- 若改动涉及 `docs/说明书/` 中的内容，为防漂移，**及时变更对应说明文件的相关表述**。
- 留下结构化的开发记录文档（模板 `.agents/templates/dev-record.md` → `.agents/records/`）。
- **完工判据**（缺一不算完；且一律附**证据**，不是结论）：相关单测／门禁**绿并附输出或计数**；开发记录已落 `.agents/records/`；受影响的 `docs/说明书/` 表述已同步；**结论回写 issue 评论区**（含验证证据与遗留）；PR 已开并说明最终行为、权衡与验证限制。

### 2.5 提交与 PR

- commit **只包含**：文档变更 / 对应代码文件。**一律用 pathspec 提交**（`git commit -- <paths>`），禁用 `git add .`、`git add -A`、`git commit -a`——共享 index 上任何一次宽暂存都会连带别人的在途改动；提交前 `git status` 核对 index。commit 时附加简要的提交说明。
- 优先基于本地既有分支提交pr，无远端分支时，创建远端分支后提交pr，并同步本地与远端，如无必要不创建专为单个issue的分支，优先在单个本地既有的主分支上工作，有严重并行冲突时再开新分支。 
- pr后不等待ci完成，向用户说明正在进行，让他注意即可。用户反映ci不通过时，抓取详情并修复。

## §3 issue 规范

| 类型 | 含义 |
|---|---|
| **bug** | 期望外的不良行为 |
| **功能变更** | 新增功能，或变更既有功能 |
| **重构** | 结构调整 |

登记 issue 时按 `.github/ISSUE_TEMPLATE/` 中对应模板的字段填写。**认领用 issue 的 assignee，不写进标签**——类型（bug / enhancement / refactor）与认领是两根正交的轴。

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
| 并行施工协调板（只留在途声明） | `.agents/L.md` |
| Agent skill（按需加载的流程） | `.agents/skills/` |
| Agent 留言板 | `.agents/BOARD.md` |
| issue 模板 | `.github/ISSUE_TEMPLATE/` |

路径约定：**仓外**协作工作区一律写成 `../Docs/…`（如 `../Docs/Archive/`），**仓内**一律小写 `docs/`。两者在 Windows 上同形，写混会得到无法自动校验的悬空指针——`check:docs` 按设计只校验仓内指针。

## §6 部分重要技术决策

### §6.1 CSS

本项目已经开始转换部分css为Tailwind v4
- 涉及到对存量已有CSS进行修改时，建议使用Tailwind CSS进行替换（过于复杂的可以继续使用）
- 新增CSS时请区分类型，涉及到：布局，响应式断点，状态变体，一致性token时优先使用Tailwind CSS，若涉及复杂样式，组件时使用原生CSS

### §6.2 注释规范

本项目存在大量存量注释，部分注释说法已过期，为了避免误导后来者，请在工作时顺手清理可确认的过时注释（尤其是你在review时以及正在进行契约变更型任务）
 
## §7 修订

本文件的修订需经仓库主批准。
