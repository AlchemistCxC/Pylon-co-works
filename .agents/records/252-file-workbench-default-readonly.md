# Dev Record — #252 File 工作台默认只读

## 元信息

- issue：#252（feat(file): 文件工作台打开文件建议默认只读——阅读路径不进「编辑中」态）
- 分支：`kumo/prometheus`
- 提交范围：`0c3cd565..c7fc2522`
- 日期：2026-09-24

## 目标与范围

打开文件默认**只读/预览态**（可滚动、可搜索、可复制）；显式点「编辑」才进编辑态，「保存」仅在编辑态出现；编辑态对未保存改动的退出加确认；Agent 发令栏与编辑态保持解耦。

**不做**：不改 FileTabView 双模式语义（已参数化）；不改 DispatchBar（本就与编辑态解耦，「选中代码回传会话」是读路径特性）；不加持久化字段（FileTabRecord 无 editing 标志）；不动 FileSheetView 导航层脏守卫（切 tab/关 tab/关 sheet/切工作区五处确认链已完备）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/sheets/file/FileViewHost.tsx` | editing 初始态与 viewIdentity 重置改 false；新增 handleExitEdit/handleToggleEdit；编辑切换按钮 disabled 加保存在途；两处过期注释清理 | 修改 |
| `src/sheets/file/__tests__/FileViewHost.test.tsx` | 「打开即编辑」契约改写为「默认只读 + 显式进入」 | 修改 |
| `src/sheets/file/__tests__/FileViewHost.save.test.tsx` | editAndType 助手前置「点编辑」；tab 切换/workspace 切换契约改只读默认；新增脏退出确认用例 | 修改 |
| `src/sheets/file/__tests__/FileSheetView.integration.test.tsx` | 三处编辑态前置；搜索定位用例改只读 reveal 判据；import 收敛 | 修改 |

## 方案要点

1. **撤销「打开即编辑」决策**（f86176f8，当时为避免只读→编辑器排版抖动，代价是把「可写入真实仓库文件」的高危态设为默认态，issue 判定不可接受）。阅读是 File 工作台高频路径，预览只读符合主流编辑器惯例。
2. **退出编辑即离开「可写面」**：有未保存改动时 `window.confirm('放弃未保存的修改并退出编辑吗？')`——确认则复用 conflict 分支的 discardAndReload（丢弃 + reloadToken 重拉磁盘），取消则留在编辑态。修复了现状的陷阱中间态：退出编辑后「保存」按钮消失但修改内容仍在只读视图显示（无徽标、不可保存）。确认丢弃后只读视图恒等于磁盘真值。
3. **保存在途时禁用编辑切换按钮**（`saveState === 'saving'`），对齐 FileSheetView 导航层「保存请求在途阻止离开」的既有语义，堵住在途保存回执与丢弃重拉竞争的角落。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 点开文件无「编辑中」徽标、无「保存」、无 CodeMirror | ✅ 用例「打开文件默认只读预览…」（FileViewHost.test） |
| 只读态键入无修改；点「编辑」才可输入；保存路径行为不变 | ✅ 保存/冲突/覆盖/Ctrl+S 用例全部保持原判据，仅前置编辑入口 |
| 脏态退出编辑：确认后丢弃重拉，取消留在编辑态 | ✅ 新增用例「脏态退出编辑先确认…」（FileViewHost.save.test） |
| 无脏退出编辑：直接回只读，无弹窗 | ✅ 「…退出回只读」用例断言 `window.confirm` 未被调用 |
| Agent 发令栏只读态保持可用（显式输入+发送） | ✅ DispatchBar 零改动，两态同渲染 |

## 测试处置

- 新增：`FileViewHost.save.test.tsx`「脏态退出编辑先确认：取消留在编辑态；确认丢弃并重拉磁盘（#252）」。
- 修改（契约跟随，非降级，逐条）：
  - `FileViewHost.test.tsx`：「file 模式：打开后直接保持编辑态…」→「打开默认只读预览…点编辑才进编辑态」。
  - `FileViewHost.save.test.tsx`：「打开文件直接进入 CodeMirror 编辑态…」→「打开文件默认只读预览…」；「tab 切换重置编辑瞬态并保持新文件编辑态」→「…并回到只读默认态」；「workspace identity 切换…」断言按钮 `退出编辑`→`编辑`；`editAndType` 助手统一前置「点编辑」；beforeEach 补 `vi.spyOn(window,'confirm')`（沿 FileSheetView.integration 先例）。
  - `FileSheetView.integration.test.tsx`：三个编辑态用例前置「点编辑」；「搜索结果会把行号传入文件 tab…」的编辑器选区判据改为只读视图 `[data-line="42"][data-revealed="true"]` reveal 判据（`fileEditorView` 导入随之移除）。
- 未动：`FileTabView.edit.test.tsx`（对 editing 已参数化，预期零改动，实跑确认）。

## 证据

- commit：`c7fc2522`（代码）、`0c3cd565`（L.md 声明）
- 测试：`bunx vitest run src/sheets/file` → **22 文件 / 150 用例全通过**（exit 0，Duration 8.04s）。
- 域内 lint：`bunx eslint` 四个改动文件 0 问题。
- 手工验证（实机）：**未执行**——共享工作树存在他人在途语法错误（`ContextPanelHost.tsx:118`，非本域），阻塞 `bun run build` 全链，二进制构建无法产出；单测已覆盖全部验收判据，实机复验建议在 PR 评审或下轮构建窗口补做。
- 全量门禁：`bun run check:frontend` 被上述他人在途文件阻断（tsc/lint 的报错 100% 收敛于 `ContextPanelHost.tsx`，本域零报错）。

## 与 spec 的偏差

无实质偏差。spec 预估 FileTabView.edit.test.tsx 零改动，属实。

## 未解问题

- 实机验收因共享工作树他人在途 WIP 阻塞构建未做（见证据节）；如需数值证据可后续用 webview2-mcp 复验「点开文件 → 无编辑中徽标 → 编辑 → 保存」链路。
- 「撤销 f86176f8」恢复了只读↔编辑器切换时的排版微移可能（该 commit 当年的动机）；issue #252 明确接受此权衡（高危默认态 > 几像素换行偏移）。若后续要彻底消除，需在 CodeMirror 与只读投影间统一排版度量，属独立优化。

## 并行交集

本轮触碰共享文件：`FileViewHost.tsx` 与三个同目录测试文件、`.agents/L.md`（条目保留至合入）。开工后工作树出现他人在途改动（`src-tauri/**`、`ContextPanelHost.tsx`、`mockBlocks.tsx`、`Sidebar.css`——#250 等域），全程未 stage、未改写，pathspec 提交。
