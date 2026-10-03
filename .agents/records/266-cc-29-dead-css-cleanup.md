# Dev Record — #266 CC-29 死 CSS 清理（悬空规则 + 够不着的兜底 + 修守卫错正控）

> ★ **本记录为 2026-10-02 补写**（原单完工时漏落）。补写依据 = 仓外归档施工单 `已处理\07-施工单-死CSS清理（CC-29）-已结案.md` + 清单 `待办\中控台CSS生效性审计-待查.md` + 2026-10-02 门禁/实机复核（`origin/main @ 1a285642`）。入库保留。

## 元信息

- issue：[#266](https://github.com/AlchemistCxC/Pylon-co-works/issues/266)（CC-29）
- 分支：`feat/cc-dead-css-cleanup.1`（已并入 main）
- 提交范围：PR [#428](https://github.com/AlchemistCxC/Pylon-co-works/pull/428) / 合并 `d3e78f14`
- 日期：原施工 2026-09-28；记录补写 2026-10-02

## 目标与范围

清掉「设置里能改、界面没反应」的同类死项。判据按**逻辑**（用户 2026-09-28 口径：「位置不对可以调，逻辑不对问题更大」——**不**以「零视觉变化」为验收启发式）。

- **做**：
  - **A + A′**：删悬空规则（选择器类名在生产代码零命中），按类名**全量 grep** 清（含 CC-01 漏删的 `.cc-footer-status-row` 族）；
  - **B**：修 `ccPrunedFieldsGuard` 里那条**错的正控**——它保护的 `.pill-mono` 本身是死规则（删规则 + 正控换真活规则）；
  - **C**：简化 5 处「被恒有值的内联变量挡住的中间层」：`var(--cc-input-x, var(--input-x, 兜底))` → `var(--cc-input-x, 兜底)`；连同 `WorkbenchContent.solid.tsx` 的 `--input-font-size` 死注入一并删。
- **不做**：`.input-binding-status` / `--error`（**保留并接线**，另立 CC-30 单）；域外同病（ChatView / PetCompanion，用户定「先不处理」）；D 兼容性注意项（用户定「无用户 ⇒ 不留兼容层」）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `…/components/chat/InputBar.css`、`chat/StatusBar.css`、`components/ControlCenter.css`、`solid-workbench/WorkbenchChrome.css` | 删悬空规则（含 A′ 那族） | 修改 |
| `src/renderers/solid-workbench/WorkbenchContent.solid.tsx` | 删 `--input-font-size` 死注入 | 修改 |
| `src/domains/cc/__tests__/ccPrunedFieldsGuard.test.ts` | StatusBar 用例正控 `.pill-mono` → 真活规则；其余断言一条不动 | 修改 |
| `src/domains/theme/themeFieldDefs.ts` | `inputBorderColor` 加 `noCssVar: true`（升级裁定 A） | 修改 |

## 方案要点

- 「悬空」= 类名在生产代码**零命中**（必须用**原始 grep** 复核——初筛脚本曾把动态拼出的类名误判为悬空）；
- 「够不着」= 外层变量**恒有值**（ControlCenter 内联注入 / 定义表自动注入）；
- C 组简化后 `--input-border-color` 成**死注入**（其唯一读者是被删的兜底层）⇒ 升级裁定 **A**：给 `inputBorderColor` 加 `noCssVar: true`（与同文件 `inputFocusBorder` / `sidebarGroupSize` 先例一致）；该字段仍是 `stroke.default` 的**语义源**（角色解析读字段值，不读直投变量）⇒ 字段仍生效。该变量随之退出皮肤契约（89→88）。
- B 修好后仍能挡「被删字段回归」（临时放回 ⇒ 守卫变红 ⇒ 改回）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| A / A′ 逐类名 grep ⇒ 0 | 施工时验收通过（原始输出已随报告目录清理） |
| B 正控已换 + 反向验证（指不存在类名 ⇒ 红） | 施工时完成并贴红（同上） |
| C 5 处已简化 + 死注入已删 | **10-02 复核**：`InputBar.css` 读点均为单层 `var(--cc-input-*, 兜底)`；CSSOM 里 `--input-font-size` **0 命中** |
| CSS 消费审计 | **10-02 复跑 `bun run check:solid` ⇒ EXIT=0**，原文：「CSS 消费审计通过（注入 105 / 消费 337 / 声明 358，死注入与悬空引用均为 0）」 |
| 实机生效性抽查 | **通过**：`输入字号` 15 → 20（真实键盘）⇒ 预览中控内联 `--cc-input-font-size: 20px`、输入框 computed `font-size: 20px`；还原 15 ⇒ 15px；无 console 错误 |
| 门禁五步 + 契约快照 | 施工时全绿 + 快照重拍（原始输出已清理）；10-02 复跑 `check:solid` 绿 |

## 测试处置

| 文件 | 处置 |
| --- | --- |
| `ccPrunedFieldsGuard.test.ts` | **主改**：StatusBar 用例正控换真活规则；其余断言不动 |
| 其它断言这些类名/CSS 文本的用例 | 逐个点名同步（施工前先全量跑一次定位） |

## 证据

- commit：`d3e78f14`（PR #428）
- 测试：10-02 `bun run check:solid` EXIT=0（含上述审计行原文）
- 手工验证：应用内「输入字号」15↔20 的注入→computed 链路读数（复核报告内）
- 复核报告（仓外）：`E:\Acode\FILES\任务\工作台优化\报告等\CC-02与CC-29实机复核\2026-10-02-翻译验收报告.md`
- ★ **已知遗留（留在卡内，不属本单）**：
  - 三处同族零命中残留：`.cc-footer` / `.cc-footer-status`（`ControlCenter.css:108,109`）、`.input-composer-shortcut`（`InputBar.css:137,138,184`）；
  - `App.css`（tactical-blue）两条无读者变量定义（`--input-text-color` / `--input-placeholder`）；
  - 扫描面缺口：本遍只扫「读 `var()` 的规则」——下一遍应扩到**全部规则**；
  - `inputBorderColor` / `inputBorder` 字段重叠（待产品判断）。

## 与 spec 的偏差

- 升级裁定 A（C 组简化引出死注入 ⇒ `noCssVar: true`）为单内升级，已记入本记录；其余按单执行。

## 未解问题

- 上列「已知遗留」三项 + 字段重叠一项（均登记在卡 `待办\中控台CSS生效性审计-待查.md`）。

## 并行交集

- `ControlCenter.css` / `chat/InputBar.css` / `WorkbenchChrome.css` / `themeFieldDefs.ts`（中控与输入栏样式面）。
- ★ 2026-10-02 起：`#410`（左栏 + 中控区重设计）曾声明占用 `ControlCenter.css` / `chat/InputBar.css`；同日用户转述该件**已搁置** ⇒ 对上述文件的避让**解除**。
