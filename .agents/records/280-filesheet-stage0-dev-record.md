# Dev Record — #280 FileSheet 阶段〇（Epic：内核合一/默认可写/写冲突锁/1MB/地基 12 卡）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 分域设计探索全文（A 内核/B LSP/C 工作台+Git/D Agent 联动/E1-E3 Chrome，8 案）与
> 裁决记录见 `.agents/spec/filesheet-strengthening/`（一次性，不入库），关键结论已并入本文。
> 产出路径：`.agents/records/280-filesheet-stage0-dev-record.md`

## 元信息

- issue：Epic [#280](https://github.com/AlchemistCxC/Pylon-co-works/issues/280) + 子卡 [#281](https://github.com/AlchemistCxC/Pylon-co-works/issues/281)~[#291](https://github.com/AlchemistCxC/Pylon-co-works/issues/291)（12 卡）
- 分支：`kumo/filesheet-stage0`（自 `kumo/prometheus` @19e2b21f 切出）
- 提交范围：`96cc4c2b..1f50b0ab`（24 个提交，逐卡 + 逐 review 反馈）
- PR：见本记录「PR」节（阶段〇聚合 PR）
- 日期：2026-09-24
- 施工方式：主 agent 逐卡施工，每卡完工后派独立子 agent review（后台、不阻塞），反馈并入后续提交；9 轮 review 全部回收处置。

## 已锁定的总纲裁决（用户逐项确认）

双轨并进（IDE 轨 + Agent 协作轨）· 重审 #252 → **默认可写**（强制只读仅物理例外 + 写冲突锁）·
Git 全量含 rebase 系（interactive rebase 首版即六操作）· diff 数据面前端化 · LSP 先 TS/JS+Rust 自举、
server 自备、地基卡提前阶段一 · fs 写审批默认 Direct · pre-image 落盘 `.pylon/undo/` ·
Zed 极简 chrome 主干（阶段一）· minimap 阶段二自建 · markdown 默认源码态（用户原话：「默认编辑态，
可通过快捷键切换」）· 1MB 抬升走前端传参且 agent 同步（勘察后确认 agent 路径本就不受限，见下）。

## 各卡交付与 review 结论

| 卡 | commit | 内容 | review |
|---|---|---|---|
| 0-E1 #281 | b553911d + e9412e1c | 样式 bug 三连修：`--bg-elevated` 落定义（亮/暗）、`--syn-cmt`/`--syn-mh` 兜底统一 #65737e、icon 与 on-accent 色值 token 化；4 条 token 卫生契约测试 | 通过；`#fff\b` 正则漏检 #ffffff 已修 |
| 0-C1 #287 | c9b6a7f6 + 558eb63a | `workspace_list_files` 有界枚举（10k 上限）+ `is_safe_segment` 新建名字谓词；8+5 条 Rust 测试 | 通过；is_safe_segment 收紧（UTF-16 口径/bidi 控制符/保留名 stem 尾空白）。**提交卫生事件**：lib.rs 曾连带他人在途 WebviewWindow 重构，soft reset 拆分剔除（他人 WIP 已还原未提交态） |
| 0-A0 #282 | 8690b745 + 1b48540b | 触碰文件生产端重接：`canonicalTouchedFileProjection`（main.tsx 安装，pluginEventBus 全局订阅，与 canonicalHookProjection 同型）；提取三级：diff block > locations（仅 edit 判定）> rawInput | 通过；EDIT_TOOL_NAMES 单源化、failed 尝试语义披露、补 completed/Write/patch 测试 |
| 0-A1 #283 | 4969bc34 + db82ed30(随卡) | **内核合一**：CM6 常驻单内核（editable compartment 两档）、只读 DOM 投影/highlightCode/sanitizeHtml/MarkdownPreview 只读分支退役、changedLines→Decoration(StateField map)、revealLine→scrollIntoView、`doc.eq` 结构共享脏检查、KernelSummary O(1) 摘要（含 Ln,Col，E2-P0）；FileTabView 瘦身为数据编排；DispatchBar 加 getContent（发送时刻取全文） | 打回 1 必修：错误卸载→恢复时 replaceDoc 落空产生伪 dirty + 旧内容以匹配基线静默写回（**AC-1 旁路**）→ setLoadedText 回退 + remount nonce + probeDisk 早退自愈（随 0-A2/A3 提交）；死代码清理（DispatchBar selectionchange、languageFromPath、selectionCapture.ts） |
| 0-A2 #284 | db82ed30 | **默认可写迁移**（ADR-0023 重审 #252）：编辑/退出编辑按钮退役、writable 仅物理例外、保存按钮常驻（未 dirty 禁用）、「编辑中」徽标退役；全部关闭守卫（beforeunload/liveCloseGuard/canLeaveActiveTab）零改动保留 | 通过；非阻塞项（窄竞态 nonce/保存键空写防护/死 CSS）已随 0-A3 落地 |
| 0-A3 #285 | 0dc44ae0 + bfd82356 | **写冲突锁**：冷却窗口 3s 内 touchVersion ≥2 次递增 → 内核只读 + warning 状态条 + 锁内禁保存（含 Mod-S）；静默满冷却解锁并 probeDisk 确认；「仍要编辑」逃生口（恢复编辑、保存仍禁）；6 条 fake-timers 测试 | 通过；文案改「解锁后可保存」、恰 3s 边界用例、解锁后 dirty 断言已补 |
| 0-A4 #286 | ddfd769d | **1MB 抬升**：`MAX_SAVE_BYTES` 改绑 `MAX_PREVIEW_BYTES`(1MB)、FileSheet readText 显式传 maxBytes=1MB、truncated 提示条带体积（派生自 FILE_SHEET_MAX_READ_BYTES） | 通过；提示条常量化已修 |
| 0-C2 #288 | 6ef24d26 + 6826f7af | `git_show_file`（rev 白名单 hash/HEAD~N/:0-:3 + 1MB 有界）+ `git_sequence_state`（进行态探测 + conflicts 派生）+ 前端 normalize/client/provider；6 条 Rust 测试含**真实冲突仓库** stage 读取 | 通过；normalize kind 回退清空孤儿 conflicts、真实冲突集成测试已补 |
| 0-C3 #289 | db5d16b5 + 1f50b0ab(随卡) | `useGitStatus` 共享 hook：GitPanel status 拉取收敛（行为不变，158 测试零断言修改）；history 留守面板；runMutation 迟到守卫保留 | 打回 2 必修：hook 单测缺失（已补 4 条）；刷新期无条件清空导致闪现「无变更」（改为仅 target 变化清空，对齐重构前语义）——均已随 1f50b0ab 提交 |
| 0-C4 #290 | 232a95e1 + a8620ae5 | GitProvider/FileProvider 契约可选方法扩充（logGraph/showFile/blame/sequenceState/stash/reset/revert/checkout/cherryPick/merge/rebase 系/文件树写操作/listFiles，全 optional）+ normalizeGitLogPage/Blame + `resolveGitCapabilities` 派生层；契约测试锁「未实现 → UI 隐藏」 | 通过；类型单源化（gitContracts 复用）+ normalize 口径对齐 family 已修 |
| 0-C5 #291 | 1f50b0ab | `@codemirror/merge@6.12.2` 引入 + `lazyMergeView` 门面（dynamic import，`typeof import` 全类型出口）；冒烟测试锁 API 面与 MergeView 构造；`check:bundle` 实跑 PASS（总 gzip 1,479,693 / 预算 1,615,000；merge 包当前无生产消费方被 tree-shake，1-C4/2-C2 接入后经门禁复验） | （与 0-C3 同批提交，独立 review 随 PR 抽查） |

## 验收证据

- **全量前端测试**：`npm test` → 645 文件 / **4,891 passed**（0 失败；含本阶段新增 ~60 条）。
- **file 域**：`npx vitest run src/sheets/file` → 158/158；plugin-runtime + infrastructure → 763/763。
- **Rust**：`cargo test -p pylon-foundations --lib` → 80 passed（workspace 39 + git 29 + 其余）。
- **check:solid**：全部门禁绿（含 CSS 消费审计「死注入与悬空引用均为 0」、运行时边界、theme 一致性）。
- **check:bundle**：PASS（fresh build 后；merge 包 tree-shake 零增量，门禁真实通过）。

## 设计内行为变化（需 issue 回写/用户知悉）

1. 只读观感从 `pl-*` 换编辑态同源 HighlightStyle（裁决 A-2，ADR-0020 消费面 4→3，主题校对列阶段一 1-A4）。
2. markdown 默认源码态（裁决 A-3，渲染态切换归 1-A1，依赖已合入的 MarkdownPreview）。
3. working-diff 统计 300ms 防抖按需计算（键击路径零全文串，性能契约 0-A1 §4.5）。
4. 重新加载不再「退出编辑」（无编辑态概念），语义 = 丢弃编辑回到磁盘真值并保持可写。

## 已声明的偏差与残余竞态

1. **写冲突锁单 probe**：A 案设计「连续两次 probeDisk 一致」解锁，实现为静默满 3s 后单次 probe——静默窗口 + 既有 300ms debounce 兜底下数据安全无损，仅只读面解除可能滞后一拍（issue #285 回写声明）。
2. **保存在途上锁窗口**：保存发起后才置锁不撤销在途写——写回的是用户完整内容（非半成品），agent 先落盘情形由 expectedBaseline CAS 拦为 conflict（issue #285 回写声明）。
3. **agent 读取抬升无改码**：勘察确认 agent 读取走 ACP fs 运行时（fs_policy.rs：16MB 文件 / 2MB 响应上限），本就不经 256KB 的 workspace 预览路径——「agent 同步抬至 1MB」的决策语义天然满足（issue #286 回写声明）。
4. **lsp-client/merge 维护风险**：@codemirror/merge 2026-04 归档只读、@codemirror/lsp-client 开发迁 Forgejo——接口面薄 + 备选已勘察（C/B 案风险表）。

## 验证限制（后续动作）

- **webview2 实机验收未跑**（本批以自动化测试 + 门禁交付）：1MB 文件打开/键击/保存三项基准、写冲突锁的真实 agent 节奏调参（3s/2 次初值）、truncated 提示条观感——列为 PR review 与合入前的实机验收清单（`tools/webview2-mcp` 流程）。
- LSP（B 线）与 Chrome 重组（E 线）按路线图属阶段一；阶段一/二卡正文草稿已备（`.agents/spec/filesheet-strengthening/issues-stage1-2-drafts.md`）。

## 协作纪事

- 共享工作树全程 pathspec 提交；0-C1 曾连带他人在途 lib.rs 改动（WebviewWindow→Window 重构），以 soft reset 拆分剔除并还原他人 WIP，未改写任何已推送历史。
- 开工前与完工后按 §2.3 维护 `.agents/L.md` 在途条目。
- 磁盘事件：G 盘两度写满（0 字节），清理可再生构建缓存 `target/debug/incremental`（16GB）后恢复；C 盘 1.1~1.4GB 为子 agent 首次探索失败根因。

## 合并 main（#279 Solid 化）的冲突解决与语义重移植（2026-09-25 补记）

阶段〇分支与 main 上的 #279「前端逐梯队 Solid 化」相撞：main 把**旧语义**的 FileTabView
整体搬运为 Solid 实体（`FileTabView.solid.tsx` 419 行 + `FileCodeEditor.solid.tsx` +
SolidMount 薄桥），本分支则在 React 侧原地演化出新语义（单内核/默认可写/写冲突锁）。
用户裁断：**取 main 架构，把我方语义重移植到 Solid 侧**。

落地方案（冲突仅 FileTabView.tsx 与 readonly 测试两处；其余自动合并）：

1. **内核工厂抽取**：新建 `fileCodeMirrorKernel.ts`（框架无关）——EditorView 装配、
   editable compartment、changedLines StateField、KernelSummary 摘要、api 句柄、
   语言懒加载、resolveTabSize（采用 Solid 侧的 isConnected+try/catch 加固版）。
2. **双适配器薄壳化**：`FileCodeEditor.tsx`（React）与 `FileCodeEditor.solid.tsx`
   （Solid）都改为消费内核工厂（约 -120 行重复逻辑）；Solid 侧保留其 jsdom destroy
   补刀模式与 isConnected 时序加固。
3. **Solid 实体重写**：`FileTabView.solid.tsx` 从「旧语义移植版」重写为「0-A1/A2/A3
   语义版」——默认可写（writable）、KernelSummary/apiRef、probeDisk 三分支、
   saveReceipt 锚点推进、AC-1 旁路防护（回退首载 + remountNonce）、写冲突锁簿记、
   markdown 默认源码态；删除投影/highlight/markdown 只读分支。
4. **薄桥 props 契约更新**：`FileTabView.tsx` 保持 SolidMount 结构，props 面换为
   writable/baseline/onSummaryChange/onWriteLockChange/apiRef（对齐 FileViewHost）。
5. **ADR 撞号**：main 的 0023 被 #279 solidification 占用——本侧默认可写 ADR 顺延
   改号 **0024-filesheet-default-writable.md**（FileViewHost 引用同步）。
6. `languageFromPath` 维持删除（重移植后无消费方）；readonly 测试采纳 main 的
   「Solid 桥 loading 态抢先 role=status」waitFor 修复。

门禁（合并后）：`tsc -b` 双类型图绿 · `check:solid` 全门禁绿（Solid 边界扫描 164 文件）
· file+plugin-runtime 523 绿 · 全量 646 文件 / **4,883 测试绿**。
移植使 Solid 实体获得 0-A1/A2/A3 全部行为；React 适配器测试（FileCodeEditor.test 7 条）
与桥端到端测试（FileTabView.readonly/edit 等）双层锁定。
