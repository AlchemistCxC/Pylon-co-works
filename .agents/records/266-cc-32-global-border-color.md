# Dev Record — #266 CC-32「输入边框」归位全局 + 输入栏独立

## 元信息

- issue：#266（总账 · CC-32；来源卡 `待办\中控台CSS生效性审计-待查.md` §7.3 / §8.4）
- 分支：`feat/cc-32-global-border-color.1`（从远端 `main` @ a892d7ad 新建，已 `--unset-upstream`）
- 提交范围：未提交（用户当次未指示 commit；改动全部停留在工作树）
- 日期：2026-10-03
- 性质：refactor（字段区归属搬迁 + 死兜底删除），无 Rust

## 目标与范围

**达成**：

1. `inputBorderColor`（实为 `stroke.default` 角色源 → `--border` → 全应用通用边线色）从「中控台」区搬到「全局」区：zone `cc → global`、label「输入边框 → 通用边线色」、group「输入框本体 → 边线」，并补 hint 说明范围；`GROUP_ORDER.global` 新增「边线」组（「强调色」之后）。
2. `InputBar.css` 删掉三条「读不到自己的就回退 `var(--border)`」的兜底链——输入栏只认「输入栏边框色」（`--cc-input-border` 由中控根无条件注入，兜底恒够不着，删除为逻辑等价 + 切断从属）。
3. 出厂区域预设数据按预设 id 1:1 挪桶：gui（solarized ×1）+ terminal（claude/nord/tokyo/amber/matrix ×5），值一律 `""`。

**不做**（照施工单）：「消息边框」与它抢同一角色导致静默忽略的历史问题（留卡另议）；「输入背景」「焦点边框」两个同类字段（留卡另议）；不改 key、不加迁移、不碰 `--cc-input-border` 注入链、不碰 `src-tauri/`。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/domains/theme/themeFieldDefs.ts` | `inputBorderColor` 定义行（zone/label/group/hint 四项；key、`default`、`noCssVar`、`semanticRole`、`semanticSource` 未动）；`GROUP_ORDER.global` 加 `{ title: '边线' }` | 修改 |
| `src/plugins/product/packages/builtin.pylon-renderers/styles/components/chat/InputBar.css` | `.input-textarea` 边框、`.input-textarea:focus` 边框色、非 classic 版式 `.input-bar` 边框三处：`var(--cc-input-border,var(--border))` → `var(--cc-input-border)` | 修改 |
| `src/domains/theme/zones/factory/gui-cc.ts` | solarized 桶删 `inputBorderColor`；尾部簿记计数更新 | 修改 |
| `src/domains/theme/zones/factory/gui-global.ts` | solarized 桶 values 末尾补 `inputBorderColor: ""`；尾部簿记计数更新 | 修改 |
| `src/domains/theme/zones/factory/terminal-cc.ts` | 5 桶各删 1 处 `inputBorderColor`；尾部簿记计数更新 | 修改 |
| `src/domains/theme/zones/factory/terminal-global.ts` | 5 桶 values 末尾各补 1 处 `inputBorderColor: ""`；尾部簿记计数更新 | 修改 |
| `src/domains/cc/__tests__/ccSettingsGrouping.test.ts` | 冻结清单摘 `'inputBorderColor'`；计数注释与「可渲染 N 项」用例名/断言 66 → 65 | 测试同步 |
| `src/domains/cc/__tests__/widgetDefinitionTable.test.ts` | `ccFields` 69 → 68、`input` 组 26 → 25、总数 69 → 68；`'input/textarea'` 归属列表摘 `'inputBorderColor'`；注释补链路 | 测试同步 |
| `src/domains/interface/__tests__/interfaceMode.test.ts` | `CC_INPUT_TOKEN_KEYS` 摘 `'inputBorderColor'`（语义清理：字段已不属于 cc 区；该文件在摘除前并未红） | 测试同步 |

派生物未手改：`ZONE_FIELDS` / `CC_MEMBER_FIELDS` / `GROUP_ORDER.cc` 均为派生，只改 defs 自动跟随（判据①读数证实）。

## 方案要点

- **角色解析事实**（只读核验，`themeCssSnapshot.ts` `resolveRoleValues` / `:178`）：`stroke.default` 角色按 defs 定义序取首个显式值，落到 `vars['--border']`。本单只换字段的 zone/label/group/hint，defs 物理顺序未动，`messageBorderColor`（chat 区，同角色、序在前）与解析行为均不变——「两个都填时被静默忽略」的历史问题原样保留，等留卡另议。
- **兜底删除的等价性**：`--cc-input-border` 由中控根无条件注入（`inputBorder` 字段，`cssVar: '--cc-input-border'`），CSS 里 `var(--cc-input-border,var(--border))` 的 `var(--border)` 分支恒够不着；删除后渲染值不变（门禁与快照双证）。
- **测试预期红灯 = 需同步全集**：改完生产代码、未动测试时先跑全量，2 文件 5 用例红，全部落在施工单点名清单内，无清单外红灯——佐证引用面排查（全仓 grep `inputBorderColor`）没有漏。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `inputBorderColor` zone=global / label=通用边线色 / group=边线；key 与语义源三件套未动 | ✅（diff 逐字段核对） |
| `GROUP_ORDER.global` 含「边线」组（「强调色」之后） | ✅（diff） |
| 判据① `ZONE_FIELDS.global` 含该字段 = true、`ZONE_FIELDS.cc` 不含 = false（cc 68 / global 17） | ✅ |
| 判据② `InputBar.css` 中 `cc-input-border,var(--border)` 计数 = 0 | ✅ |
| 判据③ 出厂数据 `inputBorderColor: ""` 赋值行恰 6 处，全在 gui-global / terminal-global | ✅ |
| 门禁五步（lint / build:example-plugin / build / check:solid / test）全绿 EXIT=0 | ✅ |
| `check:solid`：主题字段 176、CSS variables 88 不变 | ✅ |
| 全量：655 files passed \| 1 skipped (656)；5123 passed \| 1 skipped \| 1 todo (5125) | ✅ |
| 契约快照 `--write` 后 `git diff` 只有 `generatedAt`（已 restore） | ✅ |
| 开发记录落 `.agents/records/` | ✅（本文件） |
| 实机验收（全局区出现「边线 → 通用边线色」等四条） | 翻译复验事项，非本单（施工单 §五 已注明） |

**用例总数与施工单基线（666 files / 5218）的偏差说明**：开工 `git fetch` 后 `main` 前进（afb459f0 → a892d7ad，PR #526 即 #520 收尾批），该批删除了 11 个测试文件、净删约 1700 行测试代码，故本单全量口径为 656 files / 5125 tests；与本单改动无关（红灯定位阶段已证实本单只波及点名清单内的 2 文件 5 用例）。

## 测试处置

| 文件 | 处置 |
| --- | --- |
| `ccSettingsGrouping.test.ts` | 改：冻结清单摘 1 项；计数注释补「66 → 65」链路；「可渲染 66 项」用例名与 `toHaveLength(66)` 断言 → 65 |
| `widgetDefinitionTable.test.ts` | 改：`toHaveLength(69)` → 68（用例名「68 个」至此与断言重新对齐）、`input: 26` → 25、`toBe(69)` → 68、`'input/textarea'` 列表摘 1 项、两处注释补链路 |
| `interfaceMode.test.ts` | 改：`CC_INPUT_TOKEN_KEYS` 摘 `'inputBorderColor'` + 注释说明（摘除前该文件本就全绿，属语义同步） |
| `builtinPresentationProfiles.test.ts` | **复核未动**：三处引用（tokens 快照 / COMPLETE_SURFACE_TOKENS / COMPLETE_CC_INPUT_TOKENS）均按 key 冻结 profile 覆盖，与区归属无关；全量跑未红 |
| 生产侧关联未动 | `themeTypes.ts:38`（类型声明）、`builtinPresentationProfiles.ts`（按 key 覆盖值）与区归属无关，未动 |
| 新增测试 | 无 ⇒ 反向验证不适用（施工单 §八） |

## 证据

- commit：无（用户未指示 commit；分支 `feat/cc-32-global-border-color.1` 工作树留 9 个改动文件）
- 门禁（本地，2026-10-03）：
  - `bun run lint` → EXIT=0（eslint src/）
  - `bun run build:example-plugin` → EXIT=0（dist/entry.js + dist/styles.css + dist/entry.d.ts 已重建）
  - `bun run build` → EXIT=0（tsc -b + vite build，✓ built in 9.10s）
  - `bun run check:solid` → EXIT=0（主题字段 176 个；Workbench CSS variables 88 个；ZONE_FIELDS 一致性契约通过）
  - `bun run test` → EXIT=0（Test Files 655 passed | 1 skipped (656)；Tests 5123 passed | 1 skipped | 1 todo (5125)）
- 判据读数与完整命令输出：`E:\Acode\FILES\任务\工作台优化\待办\17-施工单-CC-32输入边框归位全局与输入栏独立\2026-10-03-工作者汇报.md`
- 手工验证：实机四条（全局区「边线」组、中控台「输入框本体」减项、两个改色方向互不影响）留翻译复验（施工单 §五 注明非本工人事项）

## 与 spec 的偏差

1. **出厂数据尾部簿记计数**：4 个文件的「本文件 5 条 / N 个字段值」注释在本次改动**之前**已过时（实测 gui-cc 106≠127、gui-global 51≠52、terminal-cc 345≠420、terminal-global 80≠85——历史删字段时未同步）。已按改后实测值修正（105 / 52 / 340 / 85）并在注释内写明来历。这是施工单未点名的簿记修正，已在回单「阻断与新增」同步报备。
2. 其余与施工单一致，无增减。

## 未解问题

- 「消息边框」（chat 区）与「通用边线色」抢 `stroke.default` 角色、前者序在前导致后者被静默忽略——施工单明确留卡另议。
- 「输入背景」（`surface.raised` 源）、「焦点边框」（`state.focusRing` 源）两个同类字段的归位与否——留卡另议。

## 并行交集

本单碰过的共享文件：`src/domains/theme/themeFieldDefs.ts`（多线共用的字段定义单一真值）、`.agents/records/266-cc-32-global-border-color.md`（新增）。其余改动均在 zones/factory 数据、builtin.pylon-renderers 样式与各自测试文件内。
