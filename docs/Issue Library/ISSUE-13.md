# ISSUE-13：Settings 按设置域重构

> 正式编号按 Release 实施依赖关系编排。原问题编号保留在正文中，便于追溯历史记录。

## 当前状态

- 正式编号：`ISSUE-13`
- 原问题编号：`#8`
- 状态：已交付（方案已写入）
- 依赖：ISSUE-03、ISSUE-06、ISSUE-12
- 简介：以外观、工作区、Agent 与连接替代 quick/advanced/expert 信息架构。
- 来源：`docs/release-issues.md`

## 已拍板决策（2026-08-09）

### D-15：消息历史默认永久保存

- 默认策略为永久保存，不执行自动清理。
- 按时间保留、按每个 Session 数量保留仅在用户显式选择后生效。
- 新安装、旧版本迁移、配置字段缺失或配置解析失败时都回退为永久保存，不能因默认值变化自动删除历史。
- 用户选择非永久策略时必须显示预计影响；保存策略不等于立即清理，自动清理由后端安全调度在事务边界执行。
- 手动“立即清理”是独立显式操作，实施前显示预计删除范围并要求确认；不得在修改下拉项时直接删除。


### D-01：Agent 资源策略进入“Agent 与连接”设置域

- Agent idle timeout 提供 `5 / 15 / 30 / 永不自动停止`，默认 15 分钟。
- 同时运行 runtime 上限提供 `2 / 4 / 8 / 不限制`，默认 4。
- 这些设置属于全局默认值；Agent 级覆盖首期不作为必须项。

实施方案成熟度：**仅有设置项决策，字段 schema、持久化键和 UI 排布尚无实施方案。**

### D-02：右栏折叠状态保持全局共享

- 右栏内容可随 Sheet 变化，但折叠状态跨 Sheet 保持。
- 设置页不得为不同 Sheet 创建互相冲突的右栏折叠设置。

实施方案成熟度：**已有行为决策。**

## 并行执行元数据

```yaml
formal_id: ISSUE-13
status: 已交付（方案已写入）
lane: settings
priority: P2
stage: consumer
size: L
dependencies: ["02-A", "04-A", "12-A"]
blocks: []
likely_modify: ["src/components/Settings.tsx", "src/components/Settings.css", "src/settings/"]
do_not_modify: ["不重新设计已拍板域内容"]
execution_rule: "先完成任务卡依赖，再领取本 Issue 的 ready slice；跨 Lane 变更必须经 contract/checkpoint。"
```

> 此处是 Harness 的机器可读入口。Issue 级状态不等于所有 slice 完成；以 `harness/queue.json`、任务卡和 checkpoint 为准。

### D-03：设置中提供消息历史保留策略

- “工作区”或与数据管理相关的设置页提供：永久保存、按时间保留、按每个 Session 消息数量保留。
- 设置页只描述策略和影响，不直接绕过 Rust 数据层删除消息。
- 默认值、档位和立即清理交互仍未形成实施方案。

实施方案成熟度：**仅有设置入口决策，字段 schema 与交互尚待设计。**

#### I13-A-FE-02 实施契约（2026-08-10 落地，验收地址）

历史保留策略设置契约：**设置只写策略，不绕过 Rust 删除；默认值/档位与实施契约一致**（AC-1）。

- 保留模式（D-03 三档）：`permanent` 永久保存 / `by_time` 按时间保留 / `by_count` 按每个 Session 消息数量保留。
- 默认值（D-15）：**永久保存**。新安装、旧版本迁移、配置字段缺失、解析失败、未知模式、越档值一律回退永久保存；不得因默认值变化自动删除历史。
- 档位（实施契约，前后端一致；越档值视为非法 → 回退永久保存）：
  - 按时间保留（天）：`7 / 30 / 90 / 180 / 365`，切换时默认 `30`。
  - 按数量保留（条 / 每 Session）：`100 / 500 / 1000 / 5000 / 10000`，切换时默认 `1000`。
- 影响提示（D-15）：选择非永久策略必须显示预计影响（自动清理范围），并明确“保存策略不等于立即清理，自动清理由后端在事务边界安全执行”。
- 只写不删（D-03/D-15）：设置页仅持久化策略（独立 localStorage key `pylon-history-retention`），**无任何删除命令/删除路径**；实际删除由 Rust 消息仓库（`msg_repo`）在事务边界执行。
- 立即清理入口：**本卡不实施**——后端清理调度 command 未实现；后续后端清理卡必须消费本契约（Rust：`src-tauri/src/session/retention.rs`；前端：`src/components/settings/historyRetentionPolicy.ts`），并满足 D-15 的“独立显式操作 + 预计删除范围 + 确认”要求。
- 代码位置：Rust 实施契约 `src-tauri/src/session/retention.rs`；前端契约 `src/components/settings/historyRetentionPolicy.ts`；UI 组件 `src/components/settings/HistoryRetention.tsx`（当前挂载于设置「全局」页，与窗口/配置备份同区；I13-A-FE-01 落地后迁入“工作区”域）。

### D-04：配置备份导出显示普通凭据风险提示

- 设置页导出包含 Gateway 凭据和主密钥的备份时，显示普通提示，不增加强制二次确认。
- 提示必须准确说明备份持有者可解密 Bot 凭据。

实施方案成熟度：**已有交互决策，具体 UI 文案与位置待实现。**

## 原始问题记录

原问题编号：#8
严重度：P2
状态：已交付（方案已写入）

问题现象：
宫木云汇报：
“设置页的三种分区区分度不足，且排版存在问题。”

产品决策：
设置页改为按设置域分区：`外观 / 工作区 / Agent 与连接`，不再使用 `快速 / 进阶 / 专家`。

问题根因：
当前 quick/advanced/expert 不是三个稳定的信息架构：quick 使用独立的单列模板/基础字段页面，而 advanced 与 expert 共用完全相同的 `tier !== 'quick'` 分支，没有任何字段可见性差异；同时 tier 导航横排在 header 下方，advanced/expert 内部又出现第二层左侧 tab 导航和可选右侧预览，导致模式导航与功能导航叠加。Quick 内容没有 `settings-tabs-root/settings-body` 三列约束，模板预览又通过 `transform: scale` 和 `width:285%` 撑大内容，形成不同 tier 间排版结构、宽度和滚动行为不一致。

证据等级：L2 源码证据。

相关源代码：
- `G:/Project/prism-desktop/src/components/Settings.tsx:177-185`
  - 定义 quick/advanced/expert，但没有对应差异模型。
- `G:/Project/prism-desktop/src/components/Settings.tsx:318-346`
  - quick 独立渲染；advanced 和 expert 都进入同一个 `tier !== 'quick'` 分支。
- `G:/Project/prism-desktop/src/components/Settings.tsx:346-537`
  - 第二层导航按外观/运行 tab 分类，和 tier 导航构成重复层级。
- `G:/Project/prism-desktop/src/components/Settings.css:30-37,90-100,173-201`
  - advanced/expert 使用 nav/body/preview 三列。
- `G:/Project/prism-desktop/src/components/Settings.css:227-255`
  - quick 只是 `padding:16px; overflow-y:auto`；模板预览用 `scale(.35)` + `width:285%`，与其他布局体系不同。

解决方案：

方案 A（推荐，按设置域重构信息架构）：
- 改动位置：`Settings.tsx`、`Settings.css`、设置子组件与 theme field zone 映射。
- 具体改法：
  1. 删除 `TIERS`、`TIER_LABELS` 和 `tier` state。
  2. 一级导航固定为：
     - 外观：主题模板、全局、左栏、聊天/终端、中控区、右栏。
     - 工作区：窗口、布局、Sheet、宠物、配置备份；会话入口说明可放这里。
     - Agent 与连接：Agent 切换/重连、动态配置、Gateway/平台连接入口、运行诊断。
  3. 一级域进入后，左栏展示该域的二级页面；不要再叠加“难度模式”。高级字段继续使用现有 `def.tier` 或 `<details class=set-advanced>` 在页面内部渐进展开。
  4. 全部域统一使用同一 `settings-tabs-root` 布局：左 nav + body + 可选 preview。没有 preview 的工作区/连接页面让 body 占满剩余宽度，不显示空白右列。
  5. TemplateLibrary 移入“外观 / 模板”，卡片预览改为固定 aspect-ratio 容器；不要依赖 `width:285%` 参与外层布局。缩放层必须 absolute/contain，不产生布局宽度。
  6. 移除 Settings.tsx 中用于排版的 inline style，建立 `settings-agent-summary`、`settings-section-hint` 等类；统一 row label 宽度和窄屏断点。
  7. 设置搜索限定在当前一级域或提供全局搜索结果列表，避免搜索时大量手写组直接消失却没有位置提示。
- 影响面：改变设置页导航和排版，不改变具体设置字段与存储行为。用户不再选择快速/进阶/专家，高级字段改在各功能域内渐进展示。
- 验证方式：
  1. 三个一级域视觉和语义明确，所有现有设置项都有唯一归属。
  2. 1200×800 下无横向溢出；820px 以下 preview 收起后 body 正常。
  3. 外观模板卡片不撑大滚动宽度。
  4. advanced 字段仍可展开、搜索、重置。
  5. Agent/会话/配置备份等非主题项不再混在“专家”概念下。
  6. 切换域不丢未保存的主题 state。
- 风险与取舍：需要迁移导航测试和文案，但不涉及主题数据 schema；这是比继续给 quick/advanced/expert 增加样式差异更稳定的长期结构。

---

### 源码复核后的实施细化

1. 先把 `tier` 从信息架构中移出：当前 `Settings.tsx` 明确维护 `quick/advanced/expert`，且 advanced/expert 共用 `tier !== 'quick'` 分支；只改 CSS 不会产生真正区分。
2. 建立 domain config：`appearance/workspace/agent-connection` 各自声明二级 tab、字段 zone、是否 preview；把 `TABS`、`TAB_LABELS` 和手写 Group 映射到配置表，避免再次出现重复导航。
3. 保留 `ThemeFieldDef.tier` 作为字段渐进 disclosure，而不是页面一级导航；`TemplateLibrary` 移到 appearance/template，预览容器固定尺寸且缩放层 absolute/contain。
4. 搜索应返回当前 domain 的命中位置或全局结果列表；不要继续通过 `isSearching` 直接隐藏手写组而不给用户定位信息。
5. 等 #10～#12、#7 的 Agent/连接命名稳定后再迁移“Agent 与连接”页面，避免二次改导航。

可行性：高，但属于组件级信息架构重构；应保留主题字段和存储 schema，先迁移测试再删旧 tier 代码。

---


## 逐项验收清单

### 6.14 问题 #8：Settings 按设置域重构

#### 等级 1：测试通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| domain navigation | `appearance/workspace/agent-connection` 配置完整，每个设置项只有一个归属 | `src/components/Settings.tsx` / settings config tests | [ ] |
| tier 退役 | 页面一级不再存在 quick/advanced/expert；字段级 advanced disclosure 保留 | Settings component tests | [ ] |
| 搜索与 preview | 搜索能定位结果；无 preview 域不留空列；模板缩放不制造布局宽度 | Settings/TemplateLibrary tests | [ ] |
| 状态保持 | 切换域不丢未保存主题 state，存储 schema 不变 | Store/Settings integration tests | [ ] |

#### 等级 2：前端网页验收通过（仅限前端）

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 三个设置域 | 一级导航清晰显示“外观 / 工作区 / Agent 与连接”，无快速/进阶/专家 | `http://localhost:5173/` → titlebar 设置按钮 | [ ] |
| 布局 | 1200×800 无横向溢出；820px 以下 preview 收起，body 正常滚动 | `http://localhost:5173/` → Settings；调整 viewport | [ ] |
| 模板与高级字段 | 模板卡片不撑宽；高级字段可展开、搜索、重置 | `http://localhost:5173/` → Settings → 外观 | [ ] |
| Agent/连接入口 | Agent 状态、重连、Gateway/Runtime 入口归属清楚，错误态可见 | `http://localhost:5173/` → Settings → Agent 与连接 | [ ] |

#### 等级 3：真实应用验收通过

| 相关功能 | 验收行为表现 | 验收地址 | 结果 |
|---|---|---|---|
| 设置写入 | 修改主题、窗口、宠物、Agent 配置后真实生效；关闭重开保持 | 真实应用 → Settings 各域 | [ ] |
| 系统能力 | 窗口尺寸重置、配置导入导出、文件选择等 Tauri 功能可用 | 真实应用 → Settings → 工作区/外观 | [ ] |
| Agent 与连接 | 切换、重连、Runtime/Gateway 入口调用真实 command，状态与日志一致 | 真实应用 → Settings → Agent 与连接 | [ ] |
| Release 排版 | Release 在 1200×800、窄窗口、高 DPI 下无截断/横向溢出 | Release `pylon.exe` → Settings | [ ] |

## 施工日志

| 2026-08-09 | 拍板决策同步 | 已将本轮已确认的产品决策与当前实施成熟度写入“已拍板决策”。未形成措施的内容明确标注为仅有决策。 | 关联未决策项见 `未决策项.md` |
| 日期 | 类型 | 记录 | 证据/备注 |
|---|---|---|---|
| 2026-08-09 | 文档拆分 | 从 `docs/release-issues.md` 拆分为 `ISSUE-13`；保留原问题记录、追加调查、修复记录与三级验收内容。 | 本文件生成于 Issue Library 初始化 |
| 2026-08-09 | 产品拍板 | Settings 增加消息历史保留策略入口。 | 与 ISSUE-06 D-11 对齐 |
| 2026-08-09 | 产品拍板 | 配置备份导出显示普通凭据风险提示，不强制二次确认。 | 与 ISSUE-12 D-07 对齐 |
| 2026-08-10 | 实施落地 | I13-A-FE-02 建立历史保留策略实施契约（模式/档位/默认永久保存/回退语义/影响提示，只写不删）。 | `docs/Issue Library/harness/handoffs/I13-A-FE-02.md` |


## 本轮源码核验与可验收子任务（2026-08-09）

### 逐条源码核验矩阵

| 原主张 | 判定 | 当前源码证据 | 方案修正 |
|---|---|---|---|
| Settings 仍使用 quick/advanced/expert 一级结构 | 属实 | `src/components/Settings.tsx`；`src/themeFieldDefs.ts:43,63,75-174` | 一级导航改为 domain config，字段 tier 仅作渐进 disclosure。 |
| 历史策略可由前端直接清理 | 不属实 | 当前无 SQLite 消息仓库；删除必须进入 Rust 数据事务 | Settings 只保存策略/显示影响，实际清理由 `I06-A-DATA-01` 后端执行。 |
| Gateway 备份风险提示可独立完成 | 部分属实 | UI 可先布置，但真实导出 DTO 依赖 ISSUE-12 加密/备份契约 | consumer 依赖 `I12-A-SEC-01` 后实施。 |


> 本节是本轮对当前源码的增量审计与执行切分。原编号只用于追溯；以下 task id 才是 Harness v2 的执行单位。

### 核验结论
- ✅ Settings 当前仍以 `quick/advanced/expert` 组织页面；方案“domain config 替换一级 tier”属实，但消息保留和 Gateway 备份提示分别依赖 ISSUE-06/12 的实施契约。证据：`src/components/Settings.tsx`、`docs/Issue Library/未决策项.md:13-30`。

### 子任务清单

| Task ID | 类型 | 归属 | 依赖 | 验收标准 | 最低证据 |
|---|---|---|---|---|---|
| `I13-A-FE-01` | FE | A | I03-A-FE-01 | Settings domain config 替换 tier 一级导航；appearance/workspace/agent-connection domain 配置驱动导航，保留字段 tier 仅做 disclosure。 | L1 |
| `I13-A-FE-02` | FE | A | I06-A-DATA-01 | 历史保留策略设置契约与影响提示；设置只写策略，不绕过 Rust 删除；默认值/档位必须与实施契约一致。 | L1 |
| `I13-A-FE-03` | FE | A | I12-A-SEC-01 | Gateway 备份风险提示接入；导出前普通提示说明备份持有者可解密凭据，不阻断、不伪装安全。 | L2 |
| `I13-B-FX-01` | FX | B | I13-A-FE-01 | Settings domain 切换与 preview 动效；不改变设置 schema/行为，支持 reduced-motion，预览区域稳定。 | L2 |
| `I13-A-TEST-01` | TEST | S | I13-A-FE-02, I13-A-FE-03 | Settings 全域回归与真实应用验收；导航、搜索、保存、备份提示在真实应用可验收。 | L3 |

### 本轮施工日志

| 2026-08-09 | 源码核验 + 任务切分 | 已对照当前源码建立证据结论；按一张卡一个独立可验收结果切分，B 视觉任务仅在基座/契约明确后进入。 | `docs/Issue Library/harness-v2/` |
