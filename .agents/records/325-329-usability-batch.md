# Dev Record — #325 / #326 / #327 / #329 易用性批次（单 PR）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 规格：`.agents/spec/325-327-329-usability-batch.md`（一次性，未入库）。

## 元信息

- issue：#325（失败可解释）、#326（裸启动零占位 Agent）、#327（中文界面启动器/命令菜单不可达）、#329（`/` 命令菜单分层）
- 分支：`kumo/prometheus`
- 提交范围：`65f6775d..HEAD`（各 issue 独立提交，逐条列出见「证据」）
- 日期：2026-09-25
- **不在本批次**：#328 —— 用户裁决「有意设计、明确不做」，未施工。调查结论见下节。

## 目标与范围

**做什么**：四个 issue 各按其「期望行为」落地，合成一个 PR。
**不做什么**：

- #328 会话可见性（按 Agent 静默过滤无指示 + 会话名无自动标题）——用户裁决不做；本记录下方给出调查证据，
  供日后复核，**未改任何代码**。
- #325 的「恢复动作与错误类型错配」——issue 动机里点了这名缺陷，但「期望行为」只要求错误码人话映射；
  错配涉及 `recoveryForCode` 码表与 **72 处**调用点的显式 `recovery` 覆盖，属独立裁决面，另立 issue 追踪。
- `#334`/`#335`/`#336`（另一 agent 在途）与 `#321`（双持久化真源讨论）文件域一律未碰。

## #328 调查结论（不施工依据）

| 主张 | 证据 | 判定 |
| --- | --- | --- |
| 左栏会话列表按当前 Agent 过滤 | `src/components/sidebar/useSidebarContributionProps.ts:48-54`（`s.profileId === activeProfileId && s.agentId === activeAgent && !s.archivedAt`）；上溯 commit `a83fa893` 提交信息「侧栏会话列表按 activeProfile + activeAgent 双过滤，**永远跟随当前 agent**」 | **有意设计**，且背后有真契约：会话归属 `(profileId, agentId, source)`，`src-tauri/src/session/owner.rs` 的 resume 按 owner 路由、**无回退**；`openOwnedSessionTransaction` 要求先切 owner 再打开 |
| 该设计有仓库记录 | `.agents/records/2026-09-23-issue253-254-255-acceptance-fixes.md:38-42` 把左栏树口径当作**参照真值**（Overview 卡改为同时展示「N 关联 · M 当前」） | 有旁证，但**没有**任何 ADR/wontfix 明确写「#328 不做」 |
| 会话名无自动标题 | 全仓无自动命名实现；`autoName` 字段（`src/identityStore.ts:82`）只被写入 `''`、从无渲染点（遗留字段）；F2/双击重命名**已存在**（`SessionsPanel.tsx:157,159`） | **「未建」而非「拒绝」**——与「有意设计」不同类 |
| issue 对启动器「最近打开」的描述 | 该处列的是**最近打开过的 Sheet**（`SheetLauncher.solid.tsx:129-131`），不是会话 | issue 该条前提有误 |

结论：#328 的「过滤」部分确属有意设计，且本批次未施工；但该裁决**在仓内没有落点**（无 ADR、无 wontfix 记录）。
若日后要防重开，建议补一条 ADR 或说明书记载，**本 PR 不代用户立 ADR**（AGENTS §2.3-3：决策未完成前不登记）。

## 改动清单

### #327 中文界面下启动器搜索不可达

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/workspace-sheets/SheetLauncher.solid.tsx` | 索引串改为「标题+描述+kind+分类标签+keywords」；宿主管理卡片补中文检索词；Agent 组两套空态；徽标/页脚去内部术语 | 修改 |
| `src/plugins/core/sheet/builtinWorkspacePlugins.ts` | 8 个注册条目补中文 `keywords` | 修改 |
| `src/plugins/product/builtinPylonGateway.ts` | Gateway 条目补中文 `keywords` | 修改 |
| `src/contracts/agentCommandSet.ts` | `CommandSetDescriptor` 新增可选 `keywords` | 修改 |
| `src/plugin-runtime/commands/commandRegistry.ts` | `CommandDescriptor.keywords` 投影 | 修改 |
| `src/host/commandSetResolver.ts` | 建议项带出 `keywords` | 修改 |
| `src/components/chat/commandRegistry.ts` | 过滤扩为中英关键词；`attachPluginKeywords`→`decorateSuggestions`（#329 合并） | 修改 |
| `src/plugins/core/commandSet/builtinCommands.ts` | 6 条会话命令补中文关键词 | 修改 |
| `src/plugin-runtime/packageManifest.ts`、`shared/pylon-plugin-manifest.schema.json`、`src-tauri/resources/sdk/**` | 插件 API 升 **2.4**（只做加法）+ 重新生成随包离线 SDK | 修改 |
| `docs/说明书/Pylon-插件系统说明书-开发者版.md` | §6.1 命令描述符字段、§6.3 launch `keywords` 语义、§6.11.3 版本策略 | 修改 |
| `scripts/plugin-devkit-verify.mjs` | 版本断言写死 `'1.0/1.1/1.2'` → 改从随包 schema 推导 | 修改 |

### #329 `/` 命令菜单分层

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/contracts/agentCommandSet.ts` | 新增 `CommandTier` 与可选 `tier` | 修改 |
| `src/plugin-runtime/commands/commandRegistry.ts` | `tier` 投影；**缺省 internal** | 修改 |
| `src/host/commandSetResolver.ts`、`src/components/chat/commandRegistry.ts` | 建议项带出 `tier`；会话上报命令按 user 兜底 | 修改 |
| `src/plugins/core/commandSet/builtinCommands.ts` | 6 条会话命令标 `tier: 'user'` | 修改 |
| `src/renderers/solid-workbench/input/InputBar.solid.tsx` | 两层菜单 + 「显示全部命令」切换项（进环选）+ 索引越界夹取 | 修改 |
| `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css` | `.cmd-toggle` 样式 | 修改 |
| `docs/说明书/Pylon-插件系统说明书-开发者版.md`、`packageManifest.ts`、schema、SDK | 2.4 说明扩为 keywords + tier | 修改 |

### #326 裸启动零占位 Agent

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/agent_config/embedded_agents.yaml` | **零 Agent** 注释样例（内嵌兜底新目标） | 新增 |
| `src-tauri/src/agent_config/load.rs` | Embedded 分支改指新样例；`parse()` 接受空 agents（**agents 键仍必需**） | 修改 |
| `src-tauri/src/agent_config/patch.rs` | 写入路径显式拒绝清空 agents 表（原为 `parse()` 的副作用） | 修改 |
| `src-tauri/src/agent_config/tests.rs` | 零 Agent 解析、内嵌兜底接线回归锁、共享读取入口对账改写 | 修改 |
| `src-tauri/src/gateway/mod.rs` | `include_str!` 由仓库根开发示例改指内嵌样例 | 修改 |
| `src-tauri/src/lib.rs` | 零 Agent 时的 stderr 提示改中性并给出路径 | 修改 |
| `src/identityStore.ts` | `setAgents`：当前 Agent 已不在列表（含零 Agent）时清空 `activeAgent` | 修改 |
| `src/App.tsx`、`src/components/PermissionDialog.tsx`、`src/components/right-panel/FileContextPanel.tsx`、`src/sheets/OverviewSheetView.tsx`、`src/workspace-sheets/SheetLayout.tsx` | 摘除 6 处 `|| 'peri'` 硬编码回退（空串 = 没有 Agent） | 修改 |
| `src/components/Settings.tsx` | 「当前 Agent 概况」如实空态（此前回落 `'peri'`） | 修改 |
| `resources/release/README.txt`、`resources/release/agents.example.yaml` | 首跑说明改以 GUI 引导为首要路径，YAML 降级为高级选项 | 修改 |
| `docs/说明书/Pylon-项目架构参考.md`、`Pylon-发行包清单.md` | 配置来源优先级与发行清单口径同步 | 修改 |

### #325 失败可解释

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/pylon-core/src/agent_detection.rs` | 诊断新增 `candidateId`/`executable`；`probe_diagnostic`/`scan_diagnostic` 两族构造器；聚合循环补归因 | 修改 |
| `src/errorCodeExplanations.ts` | 错误码 → 人话解释**单源**（~80 码） | 新增 |
| `src/__tests__/errorCodeExplanations.test.ts` | 码表稳定性看守 | 新增 |
| `src/components/ErrorCenter.tsx`、`src/renderers/solid-workbench/chat/LifecycleCard.solid.tsx` | 技术详情区码 + 人话 | 修改 |
| `src/components/settings/agentDetectionDiagnostics.ts` | 探测码解释改为消费单源表（删除手抄副本） | 修改 |
| `src/components/settings/AgentRuntimePanel.tsx` | 诊断按候选归因到 Agent 卡 + 「重试探测」；`detectRuntimes(force)` | 修改 |
| `src/domains/agent/agentDetector.ts`、`src/infrastructure/acp/agentClient.ts` | DTO 镜像 + 归一化；`force` 透传 | 修改 |
| `src/plugins/product/**/styles/**`（App.css / Settings.css / ChatView.css） | 三处新样式类 | 修改 |
| `docs/说明书/Pylon-Agent-检测器.md` | 结构化归因与 force 语义 | 修改 |

## 方案要点

1. **#327 走既有机制而非新框架**：`WorkspaceLaunchOption.keywords` 已存在且被启动器消费、插件开发者文档的
   示例本就用中文关键词 → 只需把「描述也并进索引串」这处结构性缺口补上 + 注册处补母语词。
   命令面同理新增 `keywords`（**搜索用，不进执行命名空间**——`aliases` 才是执行别名，两者分轴）。
2. **#329 默认 internal 是刻意的**：83 条注册命令里只有 6 条会话命令声明 `user`，其余（browser 全家族、
   skin、file/git、layout、theme）正是 issue 点名的「带原始 JSON 参数签名」那批。分层**只作用于人看的菜单**，
   agent 提示词注入面继续按 priority 截断全量命令（有单测钉住，避免把能力面一起砍掉）。
3. **#326 读写两侧意图相反且各自显式**：读取容许零 Agent（首跑空态），写入拒绝清空（不得把用户删到空）。
   放宽 `parse()` 会连带移走写路径的旧守卫，故把该断言搬到 `validate_candidate` 并写明理由。
   前端的关键点是 `identityStore.setAgents`——`activeAgent` 初值 `'peri'`、零 Agent 时后端不发 `active`，
   若不清空则会整场显示一个不存在的 Agent（这是审查抓到的：只改展示面在裸启动上打不到）。
4. **#325 归因走结构化字段而非文本解析**：候选本就带 `candidate_id`/`executable`，把关联信息挪到诊断上，
   前端零猜测（spec 116 曾把「前端映射表 vs 后端结构化诊断」挂起，本批按后者落地）。
   错误码解释做**单源表**，探测码的中文映射改为消费它，消除双表漂移。
5. **插件 API 2.4 承载 two 加法**：`keywords`（#327）与 `tier`（#329）同批发布，字段只增不改；
   顺带修 `PYLON_PLUGIN_API_SUPPORTED` 末尾写 `LATEST` 导致升版即把上一版静默移出 allowlist 的隐患。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| #327 启动器搜「设置」命中；中英关键词均可命中；空态无内部术语 | 通过（新增 3 条用例；审查探针实测「设置/主题/配置/管理/运行日志/浏览器」命中矩阵符合预期） |
| #327 `/新` 命中 `new`（含 agent 上报命令分支） | 通过（`attachPluginKeywords`/`decorateSuggestions` + 输入栏接线用例） |
| #329 默认层只列 user；「全部」展开可见原清单 | 通过（新增分层用例：默认只见 user，点「显示全部命令」后 internal 可达） |
| #329 agent 提示词不受分层影响 | 通过（断言注入文本里仍有 internal 命令、且条数 > user 层） |
| #326 无 agents.yaml 裸启动为零 Agent 空态、无占位 Agent、启动无配置报错 | 通过（内嵌兜底接线回归锁 + 零 Agent 解析用例；`load_app_config` 零 Agent 下 agents=Ok(empty)） |
| #326 设置页不再伪造 Agent（零 Agent） | 通过（store 级 3 条不变量 + 设置页空态用例） |
| #325 Agent 卡显示探测失败原因 + 重试探测 | 通过（按候选归因用例：卡片出现码与人话；重试断言 `force: true`） |
| #325 错误中心/聊天错误卡显示码 + 人话；未知码回退原文 | 通过（ErrorCenter/LifecycleCard 用例 + 未知码返回 null 用例） |
| #325 码表有稳定性单测 | 通过（精确集合 + 非空 + 不泄漏码 + 未知回退） |
| 受影响的 `docs/说明书/` 已同步 | 通过（插件开发者版、架构参考、发行包清单、检测器、项目架构参考） |
| 结论回写 issue 评论区 | 见「证据」末尾（本 PR 收尾时执行） |

## 测试处置

**修正的既有测试**（契约变更所致，逐条说明）：

| 测试 | 改动 | 原因 |
| --- | --- | --- |
| `src/host/__tests__/commandSetResolver.test.ts` | 精确对象断言补 `keywords`/`tier` 字段 | 建议项形状按契约新增字段 |
| `src/plugin-runtime/__tests__/packageManifest.test.ts` | 2.0/2.3 用例里「未知更高版本」探针由 `2.4` 改 `2.5`；新增 2.4 用例与 allowlist 结构不变量 | 2.4 成为合法版本后，原探针不再「未知」 |
| `src/workspace-sheets/__tests__/sheetLauncherRegistry.test.tsx` | 保留原关键词用例；新增中文命中/两套空态/徽标用例 | 新增可搜字段 |
| `src/components/settings/__tests__/AgentRuntimePanel.default.test.tsx` | 调用形状补 `force: false`；原因文案改为引用单源表；新增卡片归因 + force 重试用例 | 契约变更 + 单源化 |
| `src/components/settings/__tests__/agentDetectionDiagnostics.test.ts` | 「执行超时」字面量改为断言取自单源表 | 文案归单源 |
| `src-tauri/src/agent_config/tests.rs` | `load_and_load_gateway_config_share_read_entry` 去掉「agent 非空」断言，改为独立 serde 结构对账 | 零 Agent 成为合法状态 |

**新增测试**：`src/__tests__/errorCodeExplanations.test.ts`（码表稳定性）、`src/__tests__/identityAgentReconciliation.test.ts`
（零 Agent 清空 activeAgent 三条不变量）、Rust `parse_accepts_zero_agents_but_requires_the_key`、
`embedded_fallback_registers_no_agent_and_keeps_gateway_parsable`、`embedded_source_serves_the_zero_agent_sample`、
pylon-core `version_probe_timeout_is_bounded_and_visible`（扩为含归因断言）与 `unknown_detector_...`（补无归因断言）。

## 证据

- commit（按时间序）：
  - `3aeca17f` chore(L)：L.md 登记本批施工范围
  - `87054b94` #327 主体
  - `4b60ff14` #327 审查反馈修正（**注意：本条提交信息被 shell 反引号吞掉了内联标识符，内容不全**；
    完整说明见本条正文——原因是我在 `-m "..."` 里写了反引号代码标识符，触发了命令替换。
    未 `--amend`：AGENTS §4 禁止改写历史）
  - `1d6b9a4b` #326 主体
  - `805a9fd7` #326 审查反馈修正（零 Agent 真正清空 activeAgent 等 8 项）
  - `ce9ff344` #329 主体
  - `da246750` #325 主体
  - 各 issue 的审查反馈修正提交（见 PR 提交列表尾部）
- 测试（退出码均为 0）：
  - 前端全量：`vitest run` → **652 文件 / 4987 用例通过**（1 skipped, 1 todo；末轮修正后复跑）
  - `tsc -b` 干净；`eslint src/` 干净；`check:solid` 通过（含 `check-plugin-manifests`）
  - Rust：`cargo test -p pylon-core --lib agent_detection` → 36 passed；
    `cargo test --lib agent_config` → 64 passed；`cargo test --lib gateway` → 231 passed
  - `python -m unittest discover -s scripts/tests`（pack_release）→ 22 passed（审查 agent 代跑）
- 审查：每个 issue 完成后派发子 agent 异步审查，逐条落地（#327 三项 P1、#326 两项 P1 + 多项 P2/P3；
  #329/#325 审查结论见 PR 描述与后续提交）。
- 手工验证：**未做真机（webview2）验收**——本批改到了首屏与设置页布局，按 `.agents/dev-standards.md:82`
  本应实机看一眼；受限环境（磁盘 99% 满、需重建 Tauri 应用）未执行，列为限制，见「未解问题」。

## 与 spec 的偏差

| 偏差 | 说明 |
| --- | --- |
| spec 写「命令名按 `startsWith`、keywords 按 `startsWith`」，实现为 keywords 按 **`includes`** | 中文无词边界，「会话」应能命中关键词「新会话」，前缀匹配会漏。已在代码注释与插件开发者文档写明该语义。 |
| spec 未写「user 层无命中时回落到全量」 | 实现中曾加这条例外，**审查 P1 判定过宽后删除**：条件是「user 层为空」而不是「用户在敲内部命令」，敲 `/b` 就会漏出 34 条 browser 命令、`/s` 漏出 11 条 skin 命令——正是本 issue 要治的病。现在默认层严格只列 user 级，内部命令一律经底部「显示全部命令」显式展开（该切换项进环选，键盘可达），并补了「普通前缀不漏出内部命令」的回归用例。 |
| spec 预计 #326 需修 `load.rs` + 前端展示面 | 实际还必须修 `identityStore.setAgents` 与 6 处 `|| 'peri'` 回退——否则展示面修复在裸启动上不生效（审查发现）。 |
| spec 期望 #325 只加前端映射表 | 实际按裁决同时扩了 Rust 诊断 DTO（结构化归因），见方案要点 4。 |
| spec 裁决 1 要求「移除对 message 文本正则的依赖」 | 现已做到：呈现层优先取 `diagnostic.executable`，正则只在旧载荷缺该字段时兜底（审查 P2 指出此前只改了一半）。 |
| 码表规模 | spec 未定规模；落地为 **111 条**——审查 P2 指出首版只覆盖 78 条、漏掉整片「用户能碰到」的词表后补齐：Gateway/实例存储 18 条、插件运行时 8 条、ACP 崩溃原因 5 条、`agent_spawn_io_failed`、以及 `invalid_transition`/`route_in_use` 等。同时删掉两条不可能出现的条目（`renderer.mount.failed` 是猜的名字，真实码是 `renderer.slot.*` / `application_mount_failed`；`agent_detection_refresh_cancelled` 后端只作为 `protocol_error` 的 message 发出）。 |

## 未解问题

1. **真机验收缺位**：本批涉及首屏（#326）与设置卡（#325）的可见变化，未跑 webview2 实机验收。
   建议合并前或合并后尽早补一次裸启动实机核对（重点：零 Agent 空态文案、Agent 卡失败原因行布局）。
2. **#325 恢复动作错配**：`recoveryForCode` 只映 6 个码，且 72 处调用点的显式 `recovery` 覆盖它
   （`runtimeError.ts:259`），导致恢复按钮与错误类型常不匹配。**另立 issue**。
3. **#328 的裁决无仓内落点**：见#328 调查结论。
4. **磁盘**：G: 在本次会话期间一度仅剩 796 MB（`src-tauri/target` 34 GB），`npx` 因 ENOSPC 失败过；
   已改用 `node node_modules/vitest/vitest.mjs` 规避。未清理任何构建产物（共享工作树）。
5. `App.tsx` 之外仍有演示/夹具字符串 `'peri'`（`chatMockData.ts`、`demo/` 等），属演示数据，未动。
6. **`agent_detection_refresh_cancelled` 的语义错位**（审查 P2 发现）：后端把它塞进 `PylonError::Protocol` 的
   message，于是用户主动取消探测会看到「错误码 protocol_error」；码表因此不再收录它。修法是让后端为取消
   发一个中性结果（不报错）或独立码——属 Rust 域，未在本 PR 动。
7. **候选折叠后的归因**：`candidate_id` 在候选合并前算出，多启动形式的 Agent（hermes/claude-code）
   失败的那个形式可能不在最终候选列表里。前端已按可执行文件路径回退匹配兜住卡片归因；Rust 侧未改
   （合并循环重写归属更彻底，但属独立改动）。

## 并行交集

- **#334/#335/#336（另一 agent，在途）**：`src-tauri/src/dispatcher/**`、`pylon-acp/src/{state,turn_ledger}.rs`、
  `src-tauri/src/session/create.rs`、`src-tauri/src/session/model.rs`、`pylon-session/src/event_repo/**`。
  **本批一律未碰**；本批提交全部用 pathspec，未 `git add .`。
- 共享文件面：本批碰过 `src/identityStore.ts`、`src/App.tsx`、`src/plugin-runtime/packageManifest.ts`、
  `shared/pylon-plugin-manifest.schema.json`、`docs/说明书/**`、`resources/release/**`——
  后续若有人改这些，注意本批已把「零 Agent」与「插件 API 2.4」两个契约写进去。
