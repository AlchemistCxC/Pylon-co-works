# Dev Record — #197 #171 收口小修：布局白名单补 7 + 警示色改挂正式 token + L.md 收口

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 产出路径：`.agents/records/issue-197-cc-layout-whitelist7-and-warning-token-closeout.md`

## 元信息

- issue：AlchemistCxC/Pylon-co-works#197（总 issue #109；收口来源 #171）
- 分支：`feat/preset-v2.2`（从 `main@0168057b` 开；★ 后续刀5 同分支续做）
- 提交范围：`0168057b..f741aa90`（两个存档点：`bbd03d1c` 小修四件事、`f741aa90` 契约快照修正）
- 日期：2026-09-19
- 施工单：`05a-施工单-刀5前置-中控区小修.md`
- 独立核验：05a 单核验通过（用户确认，2026-09-19）
- 署名：AquaTur5235

## 目标与范围

**要达成**（刀5 前置批次，#171 收口遗留的「建议修」档）：

1. `ccLayout` 版本白名单补 `7`：v7 老布局不再整份回落默认值。
2. `--ekgYellow` 残留改挂正式警示 token `--state-warning`（无视觉变化——`state.warning` 语义角色无供源字段，`--state-warning` 恒取调色板兜底，吃的本来就是原兜底值）。
3. skinSchema 兼容说明（`control-center` variant 下线）写入开发者文档 §7。
4. `.agents/L.md` 移除 #171 在途条目。

**不做**：不碰刀5 的预设菜单/两级结构；不新增/删除主题字段（⇒ 快照内容层面无新增变化）；不动 `CC_LAYOUT_SCHEMA_VERSION`（9）/ `THEME_SCHEMA_VERSION`（11）的值；不做「警示色可定制」（语义供源字段，留预设大系统细改）。

## 改动清单

存档点 ①（`bbd03d1c`，7 文件，`+37/−37`）：

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/ccLayoutState.ts` | `normalizeCcLayout` 版本白名单数组补 `7` | 修改 |
| `src/domains/cc/__tests__/ccLayoutV8.test.ts` | 新增用例「v7 老布局不被重置」；既有「不在白名单里整份回落」样本 `7`→`2` | 修改 |
| `src/domains/theme/__tests__/themeSchemaV8Backfill.test.ts` | v10 用例夹具删虚构 `tokens` 键（断言未动） | 修改 |
| `src/index.css` | `--brand-node-warn` 供源 `var(--ekgYellow,…)` → `var(--state-warning,…)`（变量名保留） | 修改 |
| `src/sheets/RuntimeSheetView.tsx` | runtime log warn 行 `text-[var(--ekgYellow,…)]` → `text-[var(--state-warning,…)]` | 修改 |
| `docs/说明书/Pylon-插件系统说明书-开发者版.md` | §7 Stylesheet 生命周期末尾加「skin variant 兼容说明」段 | 修改 |
| `.agents/L.md` | 删 `[2026-09-19 14] [AquaTur5235] [#171]` 整条（0 增 24 删）；312 行 `=======` 属 #180 条目遗留，保留 | 修改 |

存档点 ②（`f741aa90`，1 文件，`+20/−20`，经用户确认后补）：

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json` | **脚本重拍**纠偏：`sidebarNameSize` 13→14、`sidebarGroupSize` 11→12（10 个内置预设）；主题字段 191、CSS 变量 98、fixture 15 计数不变 | 修改 |

## 方案要点

1. **v7 重置即 bug 本体**：白名单 `[3,4,5,6,8,9]` 缺 `7` ⇒ v7 布局整份回落默认值且静默。补 `7` 后归一化按 id 保留现役控件位置、已删 id（`session`/`ekg` 等）自然丢弃、legacy `send` 走既有别名机制迁 `cc-send-button`。
2. **两条既有测试「拿 v7 当反例」是补 7 的直接后果**，不处理门禁必红（详见「测试处置」）。其中 `themeSchemaV8Backfill` 的失败暴露出该测试此前一直靠「v7 被重置」这条副作用路径通过——夹具里手工塞的 `tokens` 旧位置在真实 v7 数据（pct 时代，tokens 随 v8 才出现）中不可能存在；修正后「tokens 补到默认位」改由真实的「缺失 id 补位」机制达成，回归锚点不放宽。
3. **`--state-warning` 是正式 token 而非新字段**：`state.warning` 语义角色当前无 `semanticSource` 供源字段，`--state-warning` 恒取调色板兜底（按界面模式×明暗，`src/index.css` 5 处）。改挂它 = 吃正式调色板，视觉零变化；`--brand-node-warn` 变量名保留（`App.css` 消费 + `visualMaterialContract.test.ts` 断言）。警示色可定制（供源字段）是另一个量级的需求，本单明确不做。
4. **契约快照漂移根因（合并伪影）**：区块栈提交 `1d66da28`（09-18）改预设字号值 13→14 / 11→12，但刀4 从更早的 `d2beaf40` 起步、其重拍用的是旧值代码；合并进 main 后基线与代码错位。fixture 全仓无消费方（纯写入基线，`scripts/check-workbench-theme-contract.mts` 是唯一读写点），重拍纠偏无行为影响。

## 验收标准与结果

| 验收项（05a 单 §三） | 结果 |
| --- | --- |
| 白名单含 7；新测试绿 + 反向验证四段 | ✅ 绿（5 passed）→ 拿掉 7 红（1 failed @ `ccLayoutV8.test.ts:63`）→ 改回绿（5 passed） |
| `--ekgYellow` 非测试面 0 命中 | ✅（带 `--` 前缀口径 `git grep -n -- "-ekgYellow" -- src` 0 命中；单子字面命令 `rg "ekgYellow"` 剩 `migration.ts:46/79` 两处 = 刀4 删键清理名单，应保留） |
| 开发者文档段落已加 | ✅（diff 见存档点 ①；`skinSchema.ts` 实际路径 `src/plugin-runtime/skin/`，5-9 行与引用相符） |
| `L.md` 该条已移除、其余原样 | ✅ `git diff --numstat` = `0 24` |
| 契约快照重拍后无新增改动 | ✅ 内容层面唯一 delta = 上述既有合并伪影（与本单改动面无关，已单列存档点 ②）；主题字段/CSS 变量计数不变 |
| 门禁五步全绿 | ✅ lint（0 errors，1 条既有 warning 非本次引入）→ build:example-plugin → build（✓ 20.06s）→ check:solid → test（606 文件 / 4440 passed / 2 todo） |
| `git status` 只含本单文件 | ✅（提交前 7 文件；3 条禁区未跟踪项原样未动） |
| PR：草稿 → CI 全绿 → ready | ⏳ 存档点已打、**未推送**；草稿 PR 待用户开 |

## 测试处置

新增：

- `ccLayoutV8.test.ts`「v7 老布局不被重置（版本白名单补 7，#197）」——种 v7 + 旧控件 id（`session`/`ekg`/legacy `send`），断言 version 升至当前值、现役 id 位置保留、`send`→`cc-send-button` 改名不改位、已删 id 丢弃。已反向验证。

修改（既有测试，施工单未点名，均为补 7 的直接后果，最小改动、断言不放宽）：

1. `ccLayoutV8.test.ts`「不在白名单里的版本整份回落默认布局」：样本 `version: 7` → `2`。该用例测「非白名单版本走回落」路径，样本版本本可任取。
2. `themeSchemaV8Backfill.test.ts`「存量 v7 布局（pct 时代）迁移后：pct 消失，用量控件落到权限控件右侧」：夹具删虚构 `tokens` 键（附注释说明），断言一字未动。首轮全量即此用例红（`1 failed | 4439 passed`）。

## 证据

- commit：`bbd03d1c`（7 文件 +37/−37）、`f741aa90`（1 文件 +20/−20），均在 `feat/preset-v2.2`，未推送
- 测试：`bun run test` 全量 `606 passed (606)` / `4440 passed | 2 todo`，EXIT=0；反向验证三段输出见施工汇报
- 手工验证：未做实机（纯逻辑/样式变量供源替换，无视觉变化；按 webview2-acceptance skill 的适用判据不必走实机）

## 与 spec 的偏差

施工单即规格（无独立 spec）。偏差三处，均已报备并经核验通过：

1. 两条既有测试的最小修正（单子未点名，不处理则门禁必红）。
2. 验收「0 命中」口径：字面命令命中 `migration.ts` 删键名单两处，按 `--ekgYellow`（带前缀）口径达成——已与核验方对齐。
3. 契约快照纠偏以独立存档点落库（单子原要求「重拍后无 diff」，重拍揭示的既有伪影经用户拍板单独提交）。

## 未解问题

- 「警示色可定制」（`state.warning` 语义供源字段）——留预设大系统细改（05a 单非目标）。

## 并行交集

- `.agents/L.md`（公用协调板，本轮只删自己条目）
- `docs/说明书/Pylon-插件系统说明书-开发者版.md`（公用文档，§7 追加一段）
- `src/renderers/solid-workbench/__fixtures__/workbench-skin-baseline.json`（契约快照，脚本重拍）
