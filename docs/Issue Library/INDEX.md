# Pylon Issue Library 索引

> 本索引按实施依赖关系而不是历史原编号排列。每个独立 Issue 文档保留原文档对应问题的全部内容，并在开头维护当前状态、结尾维护施工日志。

## 依赖总览

```text
ISSUE-01 Release 多 Agent 产品边界
  ├─ ISSUE-02 lifecycle/capabilities contract
  │    └─ ISSUE-03 unknown 状态
  │         └─ ISSUE-04 重连事务与生命周期分离
  │              └─ ISSUE-05 切换后状态快照对账
  │                   └─ ISSUE-06 冷启动/发送/重放链
  ├─ ISSUE-07 FileSheet source 清空与异步代际
  │    └─ ISSUE-08 SCM / Views / FileViewHost 拆域
  ├─ ISSUE-09 Workspace sidebar contract
  │    └─ ISSUE-10 Browser sidebar 折叠视觉
  ├─ ISSUE-12 Gateway adapter catalog/lifecycle
  └─ ISSUE-13 Settings 信息架构

ISSUE-11 Browser 新窗口请求接管（独立）
```

## Issue 列表

| 正式编号 | 原编号 | 标题 | 当前状态 | 依赖 | 简介 | 文档 |
|---|---:|---|---|---|---|---|
| ISSUE-01 | #13 | Release 多 Agent 产品边界 | 已交付（方案已写入） | 无 | 所有后续 Agent lifecycle、Session identity 与 GUI 路由工作的产品边界。默认单活 Release。 | [ISSUE-01.md](ISSUE-01.md) |
| ISSUE-02 | #10 | Agent lifecycle 与 capabilities 解耦 | 已交付（方案已写入） | ISSUE-01 | 将生命周期连接状态与能力协商状态拆开，避免 capability 缺失误判断线。 | [ISSUE-02.md](ISSUE-02.md) |
| ISSUE-03 | #11 | Agent unknown 状态统一 | 已交付（方案已写入） | ISSUE-02 | 统一无权威快照时的 unknown 语义，消除 Settings、titlebar、Sheet、InputBar 状态矛盾。 | [ISSUE-03.md](ISSUE-03.md) |
| ISSUE-04 | #12 | 重连事务与生命周期快照分离 | 已交付（方案已写入） | ISSUE-03 | 前端 command pending/error 不再覆盖后端 Agent lifecycle 快照，并处理 generation。 | [ISSUE-04.md](ISSUE-04.md) |
| ISSUE-05 | #9 | Agent 切换后状态快照对账 | 已交付（方案已写入） | ISSUE-04 | 切换成功后以 agent_status 末尾快照对账，避免 resetAll 清掉目标状态。 | [ISSUE-05.md](ISSUE-05.md) |
| ISSUE-06 | #1 | 冷启动、消息提交与 Agent 响应链路 | 待处理；消息重放子问题 P1 未收敛 / Release 阻塞 | ISSUE-05 | 覆盖启动快照、optimistic user message、ACP/Provider 错误可见性与会话重放。 | [ISSUE-06.md](ISSUE-06.md) |
| ISSUE-07 | #5 | FileSheet source 清空与异步代际 | 已交付（方案已写入） | ISSUE-01 | 无 source 时清空 Git/Views/File 数据，并阻止旧请求回写。 | [ISSUE-07.md](ISSUE-07.md) |
| ISSUE-08 | #6 | SCM、Views 与 FileViewHost 拆域 | 已交付（方案已写入） | ISSUE-07 | SCM 独占 Git 工作台，Views 展示 Agent touched files，统一文件/diff tab host。 | [ISSUE-08.md](ISSUE-08.md) |
| ISSUE-09 | #4 | Workspace sidebar contract 与折叠状态 | 已交付（方案已写入） | ISSUE-01 | 统一 Sheet sidebar capability、折叠状态、宽度 token 与响应式 context。 | [ISSUE-09.md](ISSUE-09.md) |
| ISSUE-10 | #3 | Browser sidebar 折叠文字泄漏 | 已交付（方案已写入） | ISSUE-09 | 折叠 Browser sidebar 时隐藏残留 unavailable 文本并加 CSS 边界。 | [ISSUE-10.md](ISSUE-10.md) |
| ISSUE-11 | #2 | Browser 新窗口请求接管 | 已交付（方案已写入） | 独立；可与 ISSUE-07/ISSUE-02 并行 | 将 target=_blank/window.open 安全接管到当前 Browser Sheet。 | [ISSUE-11.md](ISSUE-11.md) |
| ISSUE-12 | #7 | Gateway 适配器商店与实例生命周期 | 已交付（方案已写入） | 依赖 ISSUE-01；不阻塞 ISSUE-07/08 | 将 Gateway 从路由概览扩展为 adapter catalog、凭据配置和实例启停管理。 | [ISSUE-12.md](ISSUE-12.md) |
| ISSUE-13 | #8 | Settings 按设置域重构 | 已交付（方案已写入） | ISSUE-03、ISSUE-06、ISSUE-12 | 以外观、工作区、Agent 与连接替代 quick/advanced/expert 信息架构。 | [ISSUE-13.md](ISSUE-13.md) |

## 状态说明

- `已交付（方案已写入）`：原文档已有实施方案或修复记录，但不等同于三级真实应用验收全部通过。
- `待处理`：尚未完成对应修复。
- `P1 未收敛 / Release 阻塞`：原文档明确禁止继续宣称修复完成，必须先取得真实失败证据。

## 原文档全局说明

# Harness — prism-desktop Release 问题记录

> 本文已按源码依赖关系重排。问题编号仍保留原编号，便于和历史反馈、提交记录、测试名称对应。
> 本轮只读审查了实现所需的最小源码范围，没有修改 `src-tauri/`、业务代码或配置。

## 一、历史依赖叙述（已由下方 Harness v2 DAG 取代）

> 下文保留用于追溯原问题分析；执行时以“Harness v2 正式子任务与依赖重排”为准。

## 一、推荐实施顺序（依赖图）

### 0. 先冻结 Release 产品边界：问题 #13

Release 1.x 先明确为“多 Agent 可配置、GUI 单活切换”，而不是承诺多个 Agent Sheet 并行工作。这个决策是后续 Session identity、Sheet 聚焦、Agent lifecycle 和 workspace/Git 路由的前置条件。

- 若选择单活：按 #13 方案 A 收口，`switch_agent` 继续承担切换并停止旧 runtime；GUI 必须在聚焦非 active Agent Sheet 时先切换，不允许直接执行业务 command。
- 若选择并行：不能只修前端显示，必须进入 #13 方案 B 的 AgentContext 全链路改造；在该改造完成前不得对外宣称“支持多 Agent 并行工作台”。
- 本文后续顺序默认采用单活 Release 1.x 边界；并行工作台作为独立 2.0 工程，不与临近 Release 修复混做。

### 1. 统一 Agent runtime contract：#10 → #11 → #12 → #9

依赖关系不是原编号顺序：

1. **#10 生命周期与 capabilities 解耦**：先修 `connected` 的权威判据，否则后续所有状态快照对账都可能把“能力缺失”误报成“未连接”。
2. **#11 缺失状态统一为 `unknown`**：在 #10 的 contract 上定义快照不存在时的语义，消除 Settings/titlebar/Sheet tab/InputBar 各自 fallback。
3. **#12 重连事务与生命周期分离**：让 `agentStatuses` 只接受后端事件/快照，避免本地 `reconnecting/error` 覆盖权威状态；同时处理 generation 代际。
4. **#9 切换事务末尾快照对账**：依赖前三项的 store contract，拆分 `resetAll`，切换后以 `agent_status` 作为最终事实源。

这四项完成后才进入 #1；否则 #1 的冷启动快照会被切换/重连路径再次清空或被错误解释。

### 2. 启动与发送链路：#1

#1 内部仍按以下顺序实施：

1. 先确保 Agent 状态快照 contract 和 listener 增量链稳定。
2. 再验证/保持 bootstrap 的 `list_agents → agent_status → registerListeners` 顺序。
3. 最后验证发送事务的 optimistic user message、错误收敛和空回合诊断。

#1 的 Hermes profile、Peri/LLM provider 证据属于运行环境前置，不应被前端状态灯修复掩盖。Release 验收必须分别记录“Agent ready”“ACP prompt response”“assistant 内容”三个事实。

### 3. FileSheet 数据域：#5 → #6

#5 是 #6 的状态清理前置：先保证 `source=null` 时不会残留旧 Git/Views 数据，再做 SCM/Views 职责拆分和统一 `FileViewHost`。否则重构后仍可能把旧 source 的 diff/touched files 显示在新域中。

### 4. Workspace layout contract：#4 → #3

#4 先统一 workspace/sidebar 的 capability、宽度 token 和唯一折叠状态；#3 只针对 Browser 内部工具栏的折叠内容做局部修复。若先修 #3，之后将 Browser sidebar 上移或改为 workspace sidebar 时很容易重复实现、再次产生状态漂移。

### 5. 独立产品域：#2 → #7 → #8

- #2 Browser 新窗口接管依赖真实 Tauri API 签名，属于可独立交付的后端 WebView 行为修复。
- #7 Gateway 是跨前后端的架构扩展，依赖 #13 对 Agent 路由语义的边界，但不应阻塞 Browser/File 的 P1 修复。
- #8 Settings 信息架构改造依赖 Agent/连接设置最终命名和 contract 稳定，放在 Agent 状态与 Gateway 入口收敛后实施，可避免重复迁移导航。

## 二、依赖关系总览

```text
#13 Release 多 Agent 边界
  ├─ #10 lifecycle/capabilities contract
  │    └─ #11 unknown 状态
  │         └─ #12 后端状态唯一来源 + reconnect transaction
  │              └─ #9 switch 后快照对账
  │                   └─ #1 bootstrap / send transaction / Release 现场验收
  ├─ #5 FileSheet source 清空与异步代际
  │    └─ #6 SCM / Views / FileViewHost 拆域
  ├─ #4 Workspace sidebar 统一布局
  │    └─ #3 Browser sidebar 折叠视觉修复
  ├─ #7 Gateway adapter catalog/lifecycle（跨后端扩展）
  └─ #8 Settings 按设置域重构

#2 Browser new-window hook（独立，可与 #5/#10 并行开发，但验收前需确认 Tauri API）
```

## 三、源码审查后的总体可行性结论

| 问题 | 方案可行性 | 主要结论 | 不能直接假设的部分 |
|---|---|---|---|
| #13 | 单活方案高；并行方案低风险不可行 | 当前后端 GUI command 仍读全局 `active_agent`，单活是现有契约的真实边界 | 仅有多个 runtime registry 不等于 GUI 支持并行 |
| #10 | 高 | `AgentStatus.status` 已是后端 payload 字段，前端改 selector 不需改 ACP wire | capabilities 缺失时扩展能力默认值需逐项定义 |
| #11 | 高 | 可新增 `unknown` 并统一 selector | 要同步 statusLight、label、测试和能力 gate |
| #12 | 高 | 本地 pending/error 可从 `agentStatuses` 拆出 | generation 单调规则需确认后端是否对所有事件稳定递增 |
| #9 | 高 | `agentStatus()` 已存在，事务可做末尾对账 | 不能继续用 `resetAll()` 清整张 agentStatuses |
| #1 | 高（部分已实施） | bootstrap 已有快照入口；optimistic 消息链也已有实现记录 | “无回应”必须保留 ACP/Provider/Release 现场证据分层 |
| #5 | 高 | reducer 已支持 `source:null`，组件清理和 UI clear 可补齐 | source 清空后 open tabs 是否保留需产品决定 |
| #6 | 中高 | 当前 `openTabs` 是 string[]，需要 versioned tab schema 承载 diff mode | 后端 `git_diff`/workspace command 仍按 active runtime，受 #13 约束 |
| #4 | 中高 | registry 已有 sidebar slot，但缺失 capability/mode，ctx 读取存在非响应式快照 | Browser/File 内栏迁移会扩大布局回归面 |
| #3 | 高 | JSX/CSS 双保险直接可做 | 不能把 `on_navigation` 当作新窗口处理；那是另一个 #2 问题 |
| #2 | 中 | 现有 `BrowserManager` 有单实例 navigate，可复用 | Tauri 2.11 实际 `WebviewBuilder` 新窗口 hook 签名必须从依赖源码/API 验证，禁止凭记忆编码 |
| #7 | 低（架构扩展） | trait/registry 已提供抽象基础 | 生产只有 QQ，缺 factory、凭据存储和动态生命周期，非前端小修 |
| #8 | 高（UI 重构） | 现有字段 renderer 和 zone 可复用 | 需要迁移导航状态/测试，不能只改 CSS 假装三层有差异 |

## 四、统一实施纪律

每个问题按“契约 → 最小实现 → 单元/组件测试 → 集成证据 → fresh build”推进：

1. 先写/补行为测试，尤其是状态矩阵、source 代际、事件乱序和错误路径。
2. 只修改对应问题的最小文件集合；禁止顺手重命名、换视觉风格或改 `src-tauri/` 之外的产品行为。
3. 后端命令失败、ACP response、Tauri event、前端 reducer 必须分别记录，不能只用最终 UI spinner 作为证据。
4. 每个阶段结束执行 fresh `cargo check`、`cargo test --lib --no-run`、focused tests、完整 `cargo test --lib`、`npm run build`、`git diff --check`；真实 ACP/Release 场景另列为 executable evidence，不与 fake ACP 测试混淆。
5. 涉及 schema 的改动必须提供旧数据迁移、回滚/兼容读取和损坏数据测试。
6. 外部凭据只通过 profile/env 引用；日志只记录 profile 路径、provider、model、request/session/agent id，不记录 API key。

## 五、阶段化落地计划

### Phase 0：产品边界与阻断性外部条件

- 拍板 #13 单活/并行；默认按单活收口。
- 修正 Hermes `hermes_profile`/Release 环境，确认目标 profile 的 `.env`、provider、endpoint 可用。
- 对 Peri/Hermes 分别做 direct HTTP、ACP wire、Pylon event 三层基线；余额、401、无 provider、prompt timeout 要能区分。
- 输出一份 Release 环境诊断包格式，不包含 secret。

### Phase 1：Agent 状态与切换链

- #10 → #11 → #12 → #9，所有 status 消费方改用统一 selector。
- 事件乱序、快路径已连接、重连失败、旧 generation 迟到各补测试。
- #1 bootstrap 快照与发送事务验收；确认 `pylon:user/update/done/error` 时间线。

### Phase 2：FileSheet 与 layout 基础

- #5 清空 source 和异步回写防护。
- #6 拆 SCM/Views，建立 versioned `FileTab`/`FileViewHost`。
- #4 统一 sidebar contract、collapsed width、响应式 ctx。
- #3 处理 Browser 工具栏折叠残留文字。

### Phase 3：独立域交付

- #2 先用 Tauri 依赖源码确认新窗口回调，再实现同页导航和 scheme 安全测试。
- #7 先交 catalog/instance 只读契约，再做 QQ lifecycle；微信/其他平台只有真实 adapter 后才启用。
- #8 最后迁移 Settings 域导航，保留主题字段 schema。

### Phase 4：Release Gate

- 逐条按问题触发条件回归，记录版本、配置摘要、agent/profile、source/session、request id。
- P1 必须有真实 Release 或等价打包环境证据；只有 fake ACP 通过不得标记为真实修复。
- 任何未完成的产品拍板项标为阻塞，不以默认猜测关闭。

---

## 统一验收等级

### 6.1 验收等级定义

每一个问题必须保留三级验收记录，不允许用高级别验收替代低级别验收：

1. **等级 1：测试通过**
   - 范围：纯函数、reducer、组件测试、typed client、Rust 单元测试、fake ACP、fixture、构建与静态检查。
   - 通过标准：相关 focused tests 通过；完整前端/后端测试无回归；`npm run build` 与 `git diff --check` 通过。
   - 限制：只能证明受控测试环境正确，不能证明真实 WebView、ACP 子进程、Provider、Gateway 长连接或 Release 包可用。
2. **等级 2：前端网页验收通过（仅限前端）**
   - 范围：`npm run dev` 启动的 Vite 页面，只验证 React、CSS、Zustand、组件交互、错误态和 mock/浏览器 fallback。
   - 统一入口：`http://localhost:5173/`。
   - 限制：网页模式没有真实 Tauri IPC、child WebView、ACP 子进程和系统窗口能力；涉及这些能力时，只验收前端壳、禁用态、mock 数据或错误提示，不得据此标记真实功能完成。
3. **等级 3：真实应用验收通过**
   - 范围：真实 Tauri 应用、Release 或等价打包环境、真实 Peri/Hermes、真实 WebView2、真实 Gateway Adapter、真实文件系统和 Git 仓库。
   - 开发入口：在仓库根目录执行 `npm run tauri dev`。
   - Release 入口：`src-tauri/target/release/pylon.exe` 或本次待发布 zip 解压后的 `pylon.exe`。
   - 通过标准：按问题触发步骤复现，保存运行日志、Tauri event、ACP wire、截图/录屏或真实平台收发证据；只有 UI 看起来正常但无运行链证据，不得标记通过。

验收结果统一填写：

```text
[ ] 未验收
[x] 已通过
[!] 阻塞（必须写明阻塞原因和证据位置）
[-] 本等级不适用（必须说明为什么不适用，不能留空）
```

## 原文档总体验收汇总

### 6.15 总体验收汇总表

只有对应问题的三个等级均完成，或等级 2 被明确标记为“原生能力不适用”且等级 3 已通过，才允许把问题状态改为“验收完成”。

| 问题 | 等级 1：测试 | 等级 2：前端网页 | 等级 3：真实应用 | 总结论 | 证据位置 |
|---|---|---|---|---|---|
| #13 多 Agent 边界 | [ ] | [ ] | [ ] | [ ] | |
| #10 lifecycle/capabilities | [ ] | [ ] | [ ] | [ ] | |
| #11 unknown 状态 | [ ] | [ ] | [ ] | [ ] | |
| #12 重连状态来源 | [ ] | [ ] | [ ] | [ ] | |
| #9 切换状态对账 | [ ] | [ ] | [ ] | [ ] | |
| #1 冷启动/发送链 | [ ] | [ ] | [ ] | [ ] | |
| #5 FileSheet 清空 | [ ] | [ ] | [ ] | [ ] | |
| #6 SCM/Views/FileViewHost | [ ] | [ ] | [ ] | [ ] | |
| #4 Sidebar contract | [ ] | [ ] | [ ] | [ ] | |
| #3 Browser 折叠视觉 | [ ] | [ ] | [ ] | [ ] | |
| #2 Browser 新窗口 | [ ] | [-] | [ ] | [ ] | |
| #7 Gateway Adapter | [ ] | [-] | [ ] | [ ] | |
| #8 Settings 信息架构 | [ ] | [ ] | [ ] | [ ] | |

## 未决策项

当前仍未完成的产品拍板、以及已拍板但尚未形成完整实施契约的内容，集中维护在 [`未决策项.md`](未决策项.md)。

## Harness 并行开发入口

本 Issue Library 支持按依赖关系拆分为可独立领取的开发 slice，并通过 Lane、共享队列和 checkpoint 进行并行施工：[`HARNESS.md`](HARNESS.md)。

- 启动说明：[`harness/README.md`](harness/README.md)
- 并行纪律：[`harness/CONSTITUTION.md`](harness/CONSTITUTION.md)
- 共享队列：[`harness/queue.json`](harness/queue.json)
- 集成闸门：[`harness/checkpoints.json`](harness/checkpoints.json)
- 任务卡：[`harness/tasks/`](harness/tasks/)
- Lane 身份：[`harness/lanes/`](harness/lanes/)
- 共享契约：[`harness/contracts/`](harness/contracts/)
- 未决策阻塞：[`未决策项.md`](未决策项.md)

执行规则：Issue 是产品域，task slice 才是领取单位；有依赖的 slice 不得抢跑；共享契约必须先由 owner Lane 冻结并通过 checkpoint；每个 Lane 同时只能有一个 active task。

## 文档维护约定

1. 修改某个 Issue 时，只在对应 `{ISSUE-XX}.md` 的“施工日志”追加记录。
2. 如果依赖、状态或简介变化，同步更新本索引。
3. 原问题内容只允许在获得明确证据后修订；修订应在施工日志说明原因、证据和影响。
4. 正式编号不随历史 issue 编号变化；原编号仅用于追溯。
5. 三级验收清单必须分别保留测试、前端网页、真实应用三个等级，不得用高等级证据替代低等级证据。

## Harness v2 正式子任务与依赖重排（2026-08-09）

### 编号规则

`I<大任务两位>-<角色>-<类型>-<序号两位>`

- 角色：`A` 主开发、`B` 动效/视觉设计、`S` 共享集成。
- 类型：`FE` 前端、`BE` 后端、`DATA` 数据、`SEC` 安全、`TEST` 测试、`DOC` 文档/契约、`UX` 交互体验、`FX` 动效/粒子/沉浸效果。
- 示例：`I08-A-FE-02` 表示 ISSUE-08、A 负责、第二个前端子任务。
- 依赖只引用 task id；Issue 编号是产品归属，不再承担机器执行顺序。

### Issue 级推荐拓扑

```text
I01 Agent/Session/Workspace 边界
  ├─ I02 lifecycle/capabilities
  │    └─ I03 unknown selector
  │         └─ I04 reconnect/generation
  │              └─ I05 switch snapshot
  │                   └─ I06 message store/send/replay
  ├─ I07 FileSheet source/generation
  │    └─ I08 SCM/Views/FileViewHost/editor
  ├─ I09 workspace sidebar contract
  │    └─ I10 Browser collapsed visual
  ├─ I12 Gateway catalog/instance/credential
  │    └─ I13 Settings Gateway/connection consumers
  └─ I13 Settings Agent consumers

I11 Browser new-window（独立，可与 I02/I07 并行）
```

### 可并行批次

| 批次 | 可并行任务域 | 进入条件 |
|---|---|---|
| P0 | I01 契约；I11 API 调查 | 无 |
| P1 | I02；I07；I09；I12 domain contract；I11 实现 | 对应 I01 producer 已冻结/合并 |
| P2 | I03；I08 只读域；I10；I12 lifecycle | 各自 producer 通过 L1 |
| P3 | I04；I13 基础信息架构；B 的 frozen-contract 视觉卡 | contract 已冻结，scope 无重叠 |
| P4 | I05；I06 数据/发送/replay；I08 编辑 vertical slice | 前置 transaction/data contract 进入 main |
| Release Gate | 所有 required L3 任务 | 主线 fresh build/test + 真实 Tauri/ACP/Gateway/Browser 证据 |

### Task 总表

| Issue | 正式 Task | 归属 | 依赖摘要 |
|---|---|---|---|
| ISSUE-01 | `I01-A-DOC-01`, `I01-A-BE-01`, `I01-A-FE-01`, `I01-A-TEST-01` | 见各任务 ID 角色位 | 见 [ISSUE-01.md](ISSUE-01.md) 子任务清单 |
| ISSUE-02 | `I02-A-FE-01`, `I02-A-TEST-01` | 见各任务 ID 角色位 | 见 [ISSUE-02.md](ISSUE-02.md) 子任务清单 |
| ISSUE-03 | `I03-A-FE-01`, `I03-A-TEST-01` | 见各任务 ID 角色位 | 见 [ISSUE-03.md](ISSUE-03.md) 子任务清单 |
| ISSUE-04 | `I04-A-FE-01`, `I04-A-BE-01`, `I04-A-TEST-01` | 见各任务 ID 角色位 | 见 [ISSUE-04.md](ISSUE-04.md) 子任务清单 |
| ISSUE-05 | `I05-A-FE-01`, `I05-A-TEST-01` | 见各任务 ID 角色位 | 见 [ISSUE-05.md](ISSUE-05.md) 子任务清单 |
| ISSUE-06 | `I06-A-DATA-01`, `I06-A-FE-02`, `I06-A-FE-03`, `I06-B-UX-01`, `I06-A-TEST-01` | 见各任务 ID 角色位 | 见 [ISSUE-06.md](ISSUE-06.md) 子任务清单 |
| ISSUE-07 | `I07-A-FE-01`, `I07-A-FE-02`, `I07-B-UX-01`, `I07-A-TEST-01` | 见各任务 ID 角色位 | 见 [ISSUE-07.md](ISSUE-07.md) 子任务清单 |
| ISSUE-08 | `I08-A-FE-01`, `I08-A-BE-01`, `I08-A-FE-02`, `I08-B-FX-01` | 见各任务 ID 角色位 | 见 [ISSUE-08.md](ISSUE-08.md) 子任务清单 |
| ISSUE-09 | `I09-A-FE-01`, `I09-A-FE-02`, `I09-B-FX-01` | 见各任务 ID 角色位 | 见 [ISSUE-09.md](ISSUE-09.md) 子任务清单 |
| ISSUE-10 | `I10-A-FE-01`, `I10-B-FX-01`, `I10-A-TEST-01` | 见各任务 ID 角色位 | 见 [ISSUE-10.md](ISSUE-10.md) 子任务清单 |
| ISSUE-11 | `I11-A-BE-01`, `I11-A-BE-02`, `I11-A-TEST-01` | 见各任务 ID 角色位 | 见 [ISSUE-11.md](ISSUE-11.md) 子任务清单 |
| ISSUE-12 | `I12-A-BE-01`, `I12-A-BE-02`, `I12-A-SEC-01`, `I12-B-UX-01`, `I12-A-TEST-01` | 见各任务 ID 角色位 | 见 [ISSUE-12.md](ISSUE-12.md) 子任务清单 |
| ISSUE-13 | `I13-A-FE-01`, `I13-A-FE-02`, `I13-A-FE-03`, `I13-B-FX-01`, `I13-A-TEST-01` | 见各任务 ID 角色位 | 见 [ISSUE-13.md](ISSUE-13.md) 子任务清单 |

### 重要修正

- 修复原索引中的自依赖错误：ISSUE-07→ISSUE-01、ISSUE-08→ISSUE-07、ISSUE-09→ISSUE-01、ISSUE-10→ISSUE-09、ISSUE-13→ISSUE-03/06/12。
- “已交付（方案已写入）”只表示文档存在，不能当作实现完成。每个 Issue 的真实执行状态以后以 task 证据为准。
- B 的工作不预设目录或修改范围；只有任务卡 scope 与 frozen contract 同时存在时才可实施。纯视觉任务可与 A 并行，公共基座变更必须串行冻结后再并行 consumer。
