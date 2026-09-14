# Dev Record — #55 流式思考/正文碎裂为极短行（行集合漂移）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> spec 路径（一次性）：`.agents/spec/issue-55-rowset-drift.md`

## 元信息

- issue：[#55](https://github.com/AlchemistCxC/Pylon-co-works/issues/55)
- 分支：`fix/issue-55-rowset-drift`（base `b562e8af` = github/main；merge `1fa2c091` 后开工）
- 提交范围：`b562e8af..HEAD`（见「证据」）
- 日期：2026-09-14
- 署名：析毫

## 目标与范围

要达成什么：让流式 Markdown 的**行集合**始终是「当前文本」的函数，从而消灭「同一段干净文本被切成
每几个字一行」的碎裂；并把该不变式用真实形状的回归测试与只读计数固定下来。

不做什么（保持原样，明确不顺手改）：CSS/主题补丁与其它版式改动；`streamingDisplayScheduler` 的
发布节奏与 128/400ms 护栏；Rust / canonical journal / wire 链路；已合并的 #70 分支；`dist/`、
`release/`；工作树里三个无主 docs 删除与 `src-tauri/loader-error.txt`。

## 诊断结论（为什么改这里）

现场（真机 + 真 Agent，发布包 `pylon.exe` + CDP 取证）：

| 观测量 | 实测 |
| --- | --- |
| 碎裂行 | 117 个块 / 6733 字，其中 44 个块不足 6 字，尾部为 `de` `liv` `er` ` t` `he` ` po` `em.` `'\n\nA'` `lso` ` ma` `ybe` |
| 该轮 wire（journal raw vs typed） | 逐条一致（`raw == typed`），共 6847 字 / 144 换行 / 55 个空行对，`' deliver'`/`' needed'` 都是整词 delta |
| 碎片拼接 vs wire | 逐字相同（不是文本被切，而是行集合被切） |
| 重启后同一条消息 | 33 个完整段落 |
| 爆发时机 | 终态前后 0.8s 内：64 → 83 → 105 → 117 块，而换行数不变（33 → 35） |

⇒ 碎的不是文本、也不是宽度（CSS），而是**行集合与当前文本漂移**：旧实现在
`StreamingMarkdownBlocks` 里保留 `committedText` / `stableRows` / `hiddenLeading` 累积，
只对「可见文本是已提交前缀的后继」这一情形做增量对账；一旦发布链给出**非后继输入**
（插值后的裁剪前缀、双列表短暂分叉、终态重发、resume），旧行边界就会留在当前文本里已不存在的
空行上，于是一段干净文本被按陈旧边界切碎。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/renderers/solid-workbench/chat/MarkdownContent.solid.tsx` | `StreamingMarkdownBlocks` 行簿记（推导 + 位置对账）与行文本裁剪 | 修改 |
| `src/renderers/solid-workbench/chat/streamingRowCounters.ts` | 只读计数叶子模块（publications / resets / rows / textParagraphs / rowsPerTextLength / maxRowsPerTextLength） | 新增 |
| `src/renderers/solid-workbench/streamingDiagnostics.ts` | S0 读数：`rowSet` 投影 + 每行 `blocks` / `tinyRows` | 修改 |
| `src/renderers/solid-workbench/chat/__tests__/issue55.rowSetPurity.solid.test.tsx` | 行集合不变式回归（5 项） | 新增 |
| `src/renderers/solid-workbench/__tests__/streamingDiagnostics.solid.test.tsx` | 读数断言扩展（`rowSet`、`blocks`、`tinyRows`） | 修改 |
| `docs/说明书/Pylon-项目架构参考.md` | §8.3 一句错述（「每几个字换行」不属于 CSS 层） | 修改 |
| `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css` | 助手正文宽度承载（上一轮收尾，独立 commit） | 修改 |
| `src/renderers/solid-workbench/chat/__tests__/ChatView.css.test.ts`、`__tests__/InputBar.css.test.ts` | 宽度承载契约测试（上一轮收尾） | 修改 |
| `.agents/records/untracked-markdown-fracture-width.md` | 上一轮收尾的开发记录 | 新增 |

## 方案要点

1. **行集合纯函数化**：删除 `committedText` / `hiddenLeading` / `stableRows` 累积与 `reset()`，
   改为 `deriveRowSpecs(visible, final)`——只依赖当前文本（切分语义仍单一由
   `splitStreamingMarkdownBlocks` 负责：空行切块、容器行不越界、未闭合围栏不劈开，本次不触碰）。
2. **位置对账而非重建**：按位置复用行对象，文本未变则不碰 signal（不多余重解析），文本变化就地更新
   ——保住 DOM 身份，这是尾块逐拍增长不闪烁、稳定块（含代码块）不重挂载的前提；行数变少时多余行由
   `<For>` 卸载。非后继输入不再需要特殊分支，只留一条只读计数。
3. **行文本不变式**：所有行统一 `trimRowStructuralWhitespace`（首尾都裁整行空白，不裁内容里的空格与
   缩进），空白-only 的行不渲染。修掉旧实现「只在命中稳定块时才裁尾块前导」留下的 `'\n\n快'` 残留。
4. **只读判据**：`streamingDisplay` 读数新增 `rowSet`（单次发布内 `rows / textParagraphs > 1` 即出现
   当前文本之外的边界）与每行 `blocks` / `tinyRows`（< 6 字的块数，健康值 0）。纯观测，不参与任何
   渲染决策；`blocks` 读取时剥掉 slot/kind/collapse 包装层，因此生产 DOM 与测试夹具都可读。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| ① 上一轮遗留改动为独立 commit、工作树不再悬挂 | ✅ `6631b317`（4 文件） |
| ② github/main 已合入、分支基于合入后状态 | ✅ merge `1fa2c091`，behind=0 |
| ③ spec 落地（一次性、不入库） | ✅ `.agents/spec/issue-55-rowset-drift.md`（被 `.gitignore` 忽略） |
| ④ 行集合是当前文本的纯函数（回退/换挡/终态重发后与直接推导一致） | ✅ 实现 + 回归用例（同文本同结果） |
| ⑤ 尾块无结构前导空白 | ✅ 实现 + `'\n\n快'` 残留用例（变异红→绿） |
| ⑥ 回归测试锁定三条不变式（块数 ≤ 段落数、无空白块/无结构前导空行、终态幂等） | ✅ `issue55.rowSetPurity.solid.test.tsx` 5 项 |
| ⑦ `streamingDisplay` 只读计数可读且不改发布行为 | ✅ 读数测试 + 真机读数（见「手工验证」） |
| ⑧ docs §8.3 错述更正 | ✅ `7a20731d`（diff 1 增 1 删） |
| ⑨ 门禁全绿（lint / check:solid / 目标 vitest / check:frontend） | ✅ `check:frontend` exit 0（553 文件 / 3669 项、覆盖率 80.05%、bundle/smoke/docs/deps 全过）；详见「门禁输出」 |
| ⑩ 变异核验（破坏 → 红；复原 → 绿；两次留档） | ✅ 详见「手工验证」 |
| ⑪ 真机单轮复验（真实应用 + 真实 Agent：碎裂块数 0、终态后块数增量 0） | ✅ 终态后增量 0；无词中碎片（仅 2 个合法短行）；`maxRowsPerTextLength`=1.00（1891 次发布 / resets=0）；**issue 报告人本人验收通过（“验收完毕了，以及正确了”）**；详见「手工验证」 |
| ⑫ 收尾交付（dev record 入库、#55 回帖、草稿 PR 不合并） | ⏳ 进行中 |

## 测试处置

- 修改：`src/renderers/solid-workbench/__tests__/streamingDiagnostics.solid.test.tsx`
  —— **既有断言未改**；仅扩展夹具（思考正文加一个 2 字块；助手正文由 5 字改为非小块文本，使
  `blocks`/`tinyRows` 两个方向都被覆盖）并新增 `rowSet` / `blocks` / `tinyRows` 断言。
- 新增：`src/renderers/solid-workbench/chat/__tests__/issue55.rowSetPurity.solid.test.tsx`（5 项）。
- 删除：无。既有测试断言**零削弱**（`MarkdownContent.solid.test.tsx`、`StreamingMarkdownPerformance.solid.test.tsx`、
  `issue55.streamingContainers.solid.test.tsx`、`streamingMarkdownSplit.test.ts`、两个 CSS 契约测试均原样通过）。
- 两处初次失败经定性为**测试口径问题**（非产品缺陷，均留档）：
  1. 空块 = `DIV.term-md-skeleton`（异步解析的合法加载态）⇒ 断言改为等解析落地再取基线；
  2. 「结构空白」不能用 `/^\s/` 判定——源文本的代码缩进是内容，解析后表格元素之间夹的是渲染标记
     自身的换行 ⇒ 改为「纯空白块」+「直排文本行 `p.term-plain-text` 的结构前导空行」两条精确判据。

## 证据

- commit：
  - `6631b317` 上一轮遗留收尾（助手正文宽度承载 + 契约测试 + 记录）
  - `7ec5cc94` 行集合纯函数化（`MarkdownContent.solid.tsx` + `streamingRowCounters.ts`）
  - `40a9642a` 尾块结构空白（+ `'\n\n快'` 残留用例）
  - `d6b60013` S0 读数（`rowSet` + `blocks`/`tinyRows`）
  - `2a434150` 不变式回归（现场形状 55 段 + token 级切片）
  - `7a20731d` 说明书 §8.3 更正
- 测试（名称 + 退出码）：
  - `bun run lint` → exit 0（0 error；1 条既有无关 warning：`RightRailHost.tsx` exhaustive-deps）
  - `bun run check:solid` → exit 0（含 `tsc -p tsconfig.solid.json` 与全部边界/主题/CSS 契约脚本）
  - `vitest run src/renderers/solid-workbench` → 59 文件 / 591 项通过
  - `vitest run src/renderers src/domains/workbench` → 101 文件 / 984 项通过
  - `bun run check:frontend` → exit 0（11 步全过：lint 0 error；coverage 553 文件 / 3669 项；
    bundle budget 通过；docs/deps/生产隔离通过）
- 手工验证（变异核验，脚本 `.probe/layout-repro/`，仓库外）：
  - 缺陷类模拟：`rendered = nextRows.concat(rendered.slice(nextRows.length))`（行集合保留陈旧历史）
    → `issue55.rowSetPurity` **2 failed | 3 passed**（纯函数性用例与终态幂等用例转红）
  - 复原 → **5 passed**
  - 尾块裁剪模拟：去掉尾块结构空白裁剪 → `'\n\n快'` 残留用例转红；复原 → 绿
  - 原始输出留档：`.probe/layout-repro/evidence-task7/{mutation.red,restored.green}.txt`、
    `.probe/layout-repro/evidence-task9/`
- 真机单轮复验（真实应用 + 真实 Agent，便携包 + 本分支 release 构建，CDP 读数端口 9222）：
  同规格 prompt「为我写一首鹧鸪天，并逐句说明格律。」

  | 观测量 | 修复前（#55 现场取证） | 修复后（本次真机单轮，终态） |
  | --- | --- | --- |
  | 裁决区块数 / 字数 | 117 块 / 6733 字 | 49 块 / 8093 字（另一条 71 块 / 9431 字） |
  | 不足 6 字的块 | **44 个**（`de`/`liv`/`er`/` t`/`he`/` po`/`em.` 等词中碎片） | **0 个词中碎片**；仅 2 个合法短行（`So:`、`鹧鸪天`） |
  | 终态后块数增量 | **+53**（64 → 117，终态前后 0.8s 内爆发，换行数不变） | **0**（同一消息，A/B 间隔 8s；`streamingRows`=0） |
  | 空白块 | —（表现为碎片） | 0 |
  | `rowSet.maxRowsPerTextLength` | 由现场推算 ≈ 117 / 55 = **2.13**（越界） | **1.00**（1891 次发布，`resets`=0） |

  口径说明：`tinyRows` 是「不足 6 字的块数」的机械计数，合法短标题（如词牌名`鹧鸪天`、`So:`）
  也会计入；#55 的缺陷特征是**大量词中碎片**（44/117）与**终态后继续增长**（+53），两者均已消失。

  **issue 报告人本人验收**：在本人真实环境（便携包 + 本分支 release 构建 + 其真实 Agent）里
  逐条操作确认，结论“验收完毕了，以及正确了”——这是本次交付的最强端到端证据（探针只补充可量化读数）。
  采样局限如实记录：`verify-task9.mjs` 首次运行的两个缺陷——① 用 `.pop()` 取“最后一行”会在
  新一轮消息出现时跳到另一条消息（A/B 比对失效）；② 420s 采样预算不足以覆盖该轮长度。
  因此“终态后增量 0”是由 `attach-eval.mjs` 在**真正的终态**（同一消息 A/B 间隔 8s）独立测得的，
  而非首次采样直接得出。

- 真机上发现的读数缺陷（已在本分支修复，`6eda4b4c`）：`rowScope`/`rows` —— 读数以全局 key
  注册，多 workbench（如设置预览）后注册者会覆盖，导致 host 不含当前会话行时 `rows` 恒为空；
  修为「host 无行则回退到 `ownerDocument`」并新增 `rowScope` 自描述。
  复读结果（换入含修复的 exe 后重启应用，无需再发轮次）：`rowScope='document'`、`rows` 19 条；
  裁决区行的 `blocks` 与 DOM 直接子节点数**逐条相等**（33/10/57/71/49）；正文行的 `blocks` 是剥掉
  `solid-renderer-slot-host`/`solid-content-kind` 包装层后的真实块数（12/6/5/13/16），比直接子节点
  计数的 1 更有用。读数语义两点补充：① 未开写就暂停的裁决区行（stub）本就只有 1 个子节点，
  `blocks=1` 属正常；② `rowSet.*` 是本次页面加载内的累计量（重启归零，本次重启后为 0）。
- 探针与原始输出（仓库外）：`.probe/layout-repro/`：`verify-task9.mjs`（单轮采样）、
  `attach-eval.mjs`（attach 取值）、`build-cdp.cmd` + `inject-cdp-config.py`（临时注入调试端口后
  立刻还原）；原始输出 `evidence-task9/{build-cdp-run*,verify-run,gate-*}.txt`。

## 门禁输出

`bun run check:frontend`（CI 前端入口）**exit 0**，11 步全部通过：

| 步骤 | 关键输出 |
| --- | --- |
| `eslint src/` | 0 error（1 条既有无关 warning：`RightRailHost.tsx` exhaustive-deps） |
| 第一方 CSS ownership | 通过：22 files |
| tailwind token 纯度 | 通过（103 行，无字面量色值） |
| `vitest run --coverage` | **553 文件 / 3669 项通过**；全局语句覆盖 80.05% |
| `tsc -b && vite build` | 通过（`dist/assets/index-ChtJfbxo.js`） |
| bundle budget | 主应用 chunk 104,411 B（预算 400,000）；最大单 chunk 429,820 B（预算 450,000）；总 gzip 1,567,832 B（预算 1,600,000） |
| Solid smoke 产物 | 通过（`solid-smoke-DTzhq-sa.js` = 8,076 B） |
| 文档链接 + 维护审计 | 通过（4 项链接；源文件全部映射到模块根） |
| 依赖导入检查 | 通过（1254 个源文件） |
| 生产产物隔离 | 通过：扫描 248 个 JS assets，未包含 Solid smoke |

其它门禁：`bun run lint` exit 0；`bun run check:solid` exit 0（含 `tsc -p tsconfig.solid.json`、
边界脚本、主题/CSS 契约脚本）；`tsc -b` exit 0。原始输出留档
`.probe/layout-repro/evidence-task9/gate-{lint,checksolid,vitest,checkfrontend}.txt`。

## 与 spec 的偏差

1. **行范围表未落地**：spec 写「行表示为文本内绝对范围 `{start,end}`」。实现改为「推导出行描述规格
   + 位置对账」——纯函数性来自「推导只看当前文本」，与是否持久化偏移量无关；不落偏移表少一份状态、
   少一类不一致风险。行为等价，已用同文本同结果的回归用例锁定。
2. **回归夹具为合成文本（非真机原文）**：spec 写「用真实 wire 文本」。真机那条思考文本含用户私人
   画像内容，而本仓库公开 ⇒ 改用**形状忠实**的合成夹具（段落数 / 空行对 / token 级 2-7 字切片节奏 /
   缩进围栏 / 表格 / 中英混排均对齐现场），隐私优先。
3. **裁剪 helper 合并**：spec 说「尾块首尾都裁」；实现顺带把两个重复 helper（稳定块尾裁、尾块首裁）
   合并为单一 `trimRowStructuralWhitespace`，不变式只在一处表达。
4. **计数命名对齐**：实现期把内部命名由 `retreat` 改为 `reset`、快照字段定名
   `rows` / `resets` / `textParagraphs` / `rowsPerTextLength`，与 spec 口径一致（另加
   `publications` 与 `maxRowsPerTextLength` 两个便于判读的字段）。

## 未解问题

1. `.gitattributes` 声明 `*.ts` / `*.tsx` `text eol=lf`，但本机既有文件的工作副本与 blob 实际都是
   CRLF（全仓一致、非本次引入，本次新增文件与邻接文件保持一致）。全仓行尾治理不在本次范围。
2. `.term-md-skeleton` 是异步解析的合法加载态，在读数里表现为「0 字块」（`tinyRows` 只统计
   `0 < len < 6`，故不计为小块）。已在测试与读数语义中明确；若将来要区分「加载中」与「真的空」，
   可在读数里加 `skeletonRows`。
3. `knip` 报 `StreamingDisplayPublishCost` 未使用导出（HEAD 既存，无外部消费者）。删除属无关清理，
   未在本次处理。
4. 真机复验需要 WebView2 调试端口，而本机 WebView2 版本会忽略 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
   （wry 已在 options 里传 `AdditionalBrowserArguments`）⇒ 本次用「构建期临时注入 `additionalBrowserArgs`
   + 构建后立即字节还原」取证。根治办法（按环境变量开端口 + 调试工具）宜另开 issue，不属本 bugfix 范围。
   操作陷阱（已踩到并记录）：release exe **在编译期嵌入 `dist/`**，所以换前端改动后必须
   `bun run build`（或 `tauri build` 的 `beforeBuildCommand`）**再** `cargo build`；只跑 `cargo build`
   会把上一次的旧 `dist` 重新嵌进去（现场表现为读数里没有新加的 `rowScope` 字段）。

## 并行交集

本分支碰过的共享文件（其他贡献者请留意）：

- `src/renderers/solid-workbench/chat/MarkdownContent.solid.tsx`（行簿记是本次修复核心）
- `src/renderers/solid-workbench/streamingDiagnostics.ts`（新增读数形状 `rowSet` / `blocks` / `tinyRows`，
  下游若解析该 JSON 需知）
- `src/renderers/solid-workbench/__tests__/streamingDiagnostics.solid.test.tsx`
- `docs/说明书/Pylon-项目架构参考.md` §8.3
- `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/ChatView.css`（上一轮收尾；
  与并行进行的 #70 分支已合入 main 的样式改动无文件重叠）
