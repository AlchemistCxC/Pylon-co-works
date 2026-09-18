# Dev Record — 协作规范增强与留言板沉降

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/collaboration-docs-settlement.md`

## 元信息

- issue：**未登记**（原因见「未解问题」——开工时 `gh` 不可达）
- 分支：`Ru5t/Reflector`
- 提交范围：`17148d6f..<head>`
- 日期：2026-09-18
- 署名：Borges

## 目标与范围

起因是用户问「本地的 AGENTS.md 是不是有点重，是不是该拆一部分进 skill」。核查后结论相反：`AGENTS.md` 只有 91 行 / 5.4KB，不该拆；真正的重量在根 `BOARD.md`（341KB / 999 行）。经用户逐条裁定后，本次做三件事：

1. **按裁定增强 `AGENTS.md`**（不是拆分，是补齐被实测暴露的缺口）。
2. **把根 `BOARD.md` 降为路标桩**，治掉「`grep BOARD.md` 命中即吞十万 token」。
3. **`L.md` 轮转**，只留在途声明。

**不做什么**：不动任何代码；不改 `docs/说明书/`（本次无产品事实变化）；不给四层文档写优先级规则——审计结论是四层领域不相交，写规则属多余重量（用户明确「不要搞太重的系统」）；不新增 `status:*` 标签体系（认领用 assignee 已足够）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `AGENTS.md` | §1 署名两档；§2.1 远端名 / 共享工作树 / 纯追加豁免；§2.2 咨询分支 + 认领口径；§2.3 断号与轮转；§2.4 路径与完工判据；§2.5 pathspec；§3 认领；§5 文件地图与路径约定 | 修改（+35/−15） |
| `.agents/skills/webview2-acceptance/SKILL.md` | 全文件（实机验收流程、前置、本仓特有的坑） | 新增 |
| `BOARD.md` | 全文 → 路标桩（341,198 B → 1,005 B） | 修改（内容替换） |
| `.agents/L.md` | 表头轮转规则；旧条目移出；追记调试开关已入库 | 修改（471 → 174 行） |
| `.gitignore` | 移除第 64-65 行的 `AGENTS.md` 忽略规则与注释 | 修改（−3 行） |
| `.agents/decisions/0010-board-single-authority-and-archive-location.md` | 全文件 | 新增 |
| 仓外 `Docs/Archive/BOARD-archive-20260918.md` | 根板退位前全文快照（341,198 B） | 新增（不入版本控制） |
| 仓外 `Docs/Archive/L-archive-20260918.md` | `L.md` 的 09-16 及以前条目（307 行） | 新增（不入版本控制） |

无重命名。

## 方案要点

- **`AGENTS.md` 不拆。** 其内容是**无条件强制规则**（§4 禁区、§2.5 提交纪律、§2.2 领取），而 skill 是**按需加载**的——把强制规则挪进可能不被加载的 skill，等于废掉这份文件的意义。该进 skill 的是**条件触发的长流程**，即 webview2 实机验收。
- **根板选「路标」而不是「删除」。** 旧施工书与旧记录里「写 root `BOARD.md`」的措辞仍在（`.agents/spec/` 不入库、用完即弃），`git rm` 会让遵循者就地重建一个空白根板、回到双板。路标把这些人**重定向**到 `.agents/BOARD.md`。
- **归档落仓外，并暴露一处写法歧义。** 核查中发现 `.agents/BOARD.md` 声称的归档路径 `Docs/Archive/BOARD-archive-20260914.md` 在仓内不存在——但**仓外存在**（324,438 B）。仓外 `Docs/` 与仓内 `docs/` 写法同形，少写 `../` 就无法分辨所指，而 `check-doc-links.mjs` 按设计只校验仓内指针。故本次在 §5 落一条零成本约定：仓外一律 `../Docs/…`，仓内一律小写 `docs/`。
- **认领与类型分轴。** 原文 §2.2 要求「修改状态为 enhancement」，与 §3 自己的词汇表和三个 issue 模板的 frontmatter 标签（`bug`/`enhancement`/`refactor`）冲突——新建 bug 报告会被贴成 enhancement。用户原意是标记**认领情况**，而认领的天然载体是 assignee（模板本来就带 `assignees:` 字段）。故类型按模板选、认领走 assignee。
- **`L.md` 轮转针对的是冲突面，不只是体积。** 该文件历史上多次成为合并冲突点（本次 `github/main` 并入时它又是三个冲突文件之一）。它的价值是「谁正在改哪些文件」，已完工条目占用读取代价并放大冲突面，所以轮转同时解决两个问题。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 用户逐条裁定的 7 项全部落地（署名两档、远端名、纯追加豁免、共享工作树、咨询分支、DoD、文件地图） | 通过（自主/上报分类一项经用户否决后撤回，未落） |
| 根 `BOARD.md` 不再构成上下文风险 | 通过（341,198 B → 1,005 B） |
| 留言板位置唯一且与 `AGENTS.md` §5 一致 | 通过（`AGENTS.md` §5 认 `.agents/BOARD.md`；根板为路标） |
| 归档无损 | 通过（`L.md`：307 归档 + 164 保留 = 471 原行数；根板全文 341,198 B 逐字节复制） |
| `AGENTS.md` 内所有相对链接可解析 | 通过（8/8 存在） |
| 无脚本/测试依赖本次改动的文档 | 通过（仅 `check-doc-links.mjs:13` 引用 `dev-standards.md`，该文件未改） |
| `check:docs` | 通过（`check-doc-links` rc=0「文档链接检查通过（4 项）」；`check:maintenance` 正常输出） |

## 测试处置

未修改、未删除任何测试。本次零代码改动，故未跑 `check:frontend` / `check:rust` / `check:solid`——它们不被本次改动牵连（已用上面「无脚本/测试依赖」一项核实）。

## 证据

- commit：`2ba00d35`（L.md 施工声明）、`93bfb2c5`（AGENTS.md + skill + .gitignore）、`1963b54a`（根板沉降 + L.md 轮转）、本记录与 ADR 一笔
- 门禁：`bun scripts/check-doc-links.mjs` → rc=0，输出「文档链接检查通过（4 项）」；`bun run check:docs` → 两段均正常结束
- 归档实物：`../Docs/Archive/BOARD-archive-20260914.md`（324,438 B，既有）、`BOARD-archive-20260918.md`（341,198 B）、`L-archive-20260918.md`（37,603 B / 307 行）
- 手工验证：`git diff --name-only 17148d6f..HEAD` 逐个核对文件域；`git check-ignore` 确认 `.agents/skills/` 可入库、`.zcode/` 已被忽略

## 与 spec 的偏差

无 spec（用户当场逐条裁定，未落 `.agents/spec/`）。偏差两处：

1. **撤回了一条自己的提议**：曾建议在 §4 增设「可自主 vs 必须上问」分类清单；用户指出既有闸门（§2.3-2 澄清需求、§2.4 派子 agent 前询问）已覆盖，分类清单会长成官僚税。已撤回，其真实残余（他人在途作业时能不能自己决定）并入 §2.1 的共享工作树规则。
2. **§5 的路径约定未经单独表决**：`../Docs/` 与 `docs/` 的写法约定是在我给出审计结论的同一轮里提出的，用户随后「动手吧」一并批准。如需剔除，删 §5 表下那一行即可，不影响其余改动。

## 未解问题

- **本任务未登记 issue。** 按 `AGENTS.md` §2.2 应先登记；但 `gh` 全程不可达（`gh label list` / `gh issue list` 两次 `TLS handshake timeout`），无法读写 issue，也无法设置 assignee。故本次：类型标签与认领都未做，仅在 PR 说明中承接。网络恢复后应补登记并回写结论（§2.4 完工判据的最后一环）。
- **`L.md` 里有一行历史遗留的 `=======`**（原第 294 行，Brahe 条目与 Erdős 条目之间）。已核实它存在于合并前的 `17148d6f` **以及两个合并父本**中，**不是**本次合并产生，是更早某次冲突解析的残留。它在 markdown 中会把前一段落读成 setext 标题。未改动（`L.md` 只追写，且不在我的改写域内）；它已随轮转整段进入归档，存活文件里已不含该行。若要彻底清理归档副本，请另开一笔。
- **仓外归档不受门禁保护**（`check-doc-links.mjs:6-8` 自述），新克隆与 CI 看不到。这是既有惯例的固有代价，非本次引入；已在 ADR-0010「后果」中登记。
- **`CONTEXT.md` 是全仓唯一带机器相关绝对路径的文档**（`:31` 的 `G:\…\Docs\Archive\渲染引擎施工\…`，`:9` 的 `../Docs/Archive/…`）。新机器上 `:31` 会静默悬空。`dev-standards.md` 已有应对口径（外部路径不存在时注明不可用、优先读仓内事实），故未改；登记备查。
- **`.gitignore` 的 `*.html` 与 `AGENTS.md` 同属一类**：它会匹配任意层级的 HTML，而仓库里 `index.html`、`solid-rich-qa.html` 等都已被跟踪（同「规则失效但被跟踪掩盖」）。未动（可能是有意的本地文件规则），登记备查。

## 并行交集

本次碰过的共享文件：`AGENTS.md`、`BOARD.md`（根）、`.gitignore`、`.agents/L.md`、`.agents/skills/`、`.agents/records/`、`.agents/decisions/`。**未触碰**：`src/**`、`src-tauri/**`、`.github/**`、`docs/说明书/**`、`package.json`、`tools/**`。

开工时工作树中另有一笔并行会话未完成的 `github/main` 合并（`MERGE_HEAD` = `38cd99e0`，冲突在 `.agents/L.md` 与两个 sheets 组件）。按「共享工作树」原则未 `abort`、未 `stage`、未 `commit`，等其收工后（`f990ef35`）才开工；对方在 `L.md` 的冲突解为「双方条目并集」，与本次新增的纯追加豁免规则一致。
