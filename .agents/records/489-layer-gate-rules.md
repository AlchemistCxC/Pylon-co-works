# Dev Record — #489 分层门禁规则补全（infra→domains 运行时值 / kernel 依赖方向 / host-app-cli 纳管）

## 元信息

- issue：[#489](https://github.com/Teens-in-Times/Pylon-co-works/issues/489)（enhancement(gate)，2026-10-01 维护者批准三条推荐条文）
- 分支：`kumo/489-layer-gates`（独立 worktree `F:/Project/pylon-489`，基于 github/main `ea82ac88`；G 盘满故 worktree 置 F 盘）
- 提交范围：`ea82ac88..<head>`
- 日期：2026-10-01

## 目标与范围

把维护者批准的三条分层规则机器化进 `scripts/check-layer-boundaries.mts`：① infrastructure 不得 import domains 的运行时值（type-only 边豁免）；② kernel 只能被 app 挂载（domains/视图层禁引 kernel；kernel 出向既有引用按 bootstrap 装配语义豁免）；③ host/app/cli/application 纳管（最低限度：domains 不得依赖四者）。**不做什么**：不改任何 `src/**` 生产代码——存量违规一律「边级豁免表 + 理由」起步（先立规后清债），零改道。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `scripts/check-layer-boundaries.mts` | 头注（三条新规 + 刻意不管清单）、`LayerRule` 增 `allowEdges`/`typeOnlyExempt`、`isTypeOnlyImport` 语句级判定、规则表 4→11 条、豁免陈旧检测、汇总行动态化 | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | 「验证」节追加一句 #489 规则扩表表述 | 修改 |
| `.agents/records/489-layer-gate-rules.md` | 本记录 | 新增 |

## 方案要点

- **批准条文 → 7 个规则实例**：规则 1（infra→domains 运行时值，`typeOnlyExempt: true`）；规则 2 拆入向（视图/domains→kernel）与出向（kernel→app/application/plugin-runtime/infrastructure/domains，bootstrap 装配豁免 15 条）；规则 3 拆 domains→四层（批准的最低限度，豁免 14 条）+ 按现状依赖图核准的三个扩展：cli→视图层（2 豁免）、application→视图层（净禁令）、app→视图层（1 豁免）。
- **type-only 判定**（`isTypeOnlyImport`）：语句级 `import type`/`export type`，或花括号内全部 inline `type` 修饰符；语句头回溯以「最近的 `\nimport`/`\nexport`/`;import`/`;export`」定位，找不到语句头时**从严按运行时值**。修复过程中发现文件首语句（其前无换行）会误判为运行时值，已处理（窗口触到文件头仍无关键词时按首语句处理）。
- **边级豁免 `allowEdges`**（`${file} -> ${target}` 键）：文件级 allowlist 豁免面过宽，57 条存量豁免全部用边级、逐条带理由（who/why 以类别前缀 + 括注清偿方向表达）。
- **豁免陈旧检测**：违规边消失（改道/搬迁）后豁免条目变成死豁免，门禁直接红并提示删条——防止死豁免长期占位。首跑即抓出 **6 条死条目**：存量 5 条（`domains → 视图层` 的 chat 三件——结构全修批搬迁后已无视图层 import；`contracts → 实现` 的 sheets.ts/agentCommandSet.ts 两条——其边不在禁令集合内永不触发）+ 勘察误计 1 条（`interactionTransport.ts → agentContracts.ts` 实为多行 `import type`，粗判脚本误计为运行时值），均已删并留注释。
- **刻意不管清单**（头注）：plugins/sdk/utils/devtools/demo/test*/wasm/assets/styles/css01 作为源侧不受管辖；根入口 main.tsx/App.tsx 为组合根；视图→app（~77 边）、视图→host（挂载桥正用面 18 边）、host→domains、infra/plugin-runtime→`app/runtimeError`（错误上报口）明示允许；kernel→视图层（2 边）与 kernel→plugins（productPluginIds 常量 2 边）批准条文未含、暂不设防；plugin-runtime→kernel（1 条 type-only）不在批准的 domains+视图层条文内；同层互引不设防。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 三条规则机器化，负向验证 fixture 能红 | ✅ 5 个临时 fixture 触发 6 处越界（application→视图 / cli→视图 / 视图·domains→kernel / domains→四层 / infra→domains 运行时值 / kernel→五层），exit 1；同 fixture 内 `import type { Session }` 边**未**触发（type-only 豁免生效）；删 fixture 后恢复绿 |
| 存量豁免每条带 who/why 理由 | ✅ 边级 57 条全部带理由 |
| 陈旧豁免检测 | ✅ 6 条死条目抓出并删除（含存量 5 条） |
| 门禁脚本头注同步刻意不管清单 | ✅ |
| `check:frontend` 全绿 | ✅（见证据） |

## 测试处置

无新增/修改/删除测试。门禁脚本沿用仓库先例：无独立测试框架，负向验证以临时 fixture 完成（本记录留痕，fixture 已删）。

## 证据

- 门禁正向：`bun scripts/check-layer-boundaries.mts` → `分层边界门禁通过：852 个生产文件，11 条规则零越界（文件级豁免 0 条、边级豁免 57 条，均有理由登记且无陈旧条目）`，exit 0。
- 门禁负向：fixture 期输出 `分层边界门禁失败：6 处越界`（六条规则 label 全部命中），exit 1。
- `bun run check:solid` → 全链（tsc solid + 10 个边界/契约门禁脚本）exit 0。
- `bun run check:frontend` → exit 0（lint / csp / canonical-types / retention-policy / export-sanitize-vocabulary / ipc / first-party-styles / tailwind-tokens / example-plugin / wasm / vitest / build / bundle / solid-smoke / docs / immer / production-excludes 全链）。
- `bun run test` → `Test Files 661 passed | 1 skipped (662)`、`Tests 5179 passed | 1 skipped | 1 todo (5181)`，exit 0。
- 勘察读数（规格承接）：infra→domains 37 边 = 23 运行时值 + 14 type-only；kernel 出 26 / 入 12；domains→四层 = 2+12+0+0。

## 与 spec 的偏差

无实质偏差。spec 勘察读数中「24 运行时值」被门禁精确检测修正为 23（多行 `import type` 误计），已在方案要点说明。

## 未解问题

- kernel→视图层（KernelRoot 引 ErrorBoundary/SkinPreviewBar）与 kernel→plugins（productPluginIds 常量）是否扩权纳入禁令，待仓库主裁决（issue 评论区已留口）。
- 23 条 infra→domains 运行时值豁免的清偿节奏（transport 注入改道 vs schema/端口下沉）待后续 issue 拆解；范本形态已在豁免注释指向 `workbenchCommandFacade.ts:265` / `threeSourceExport.ts:226`。
- plugin-runtime→kernel 的 1 条 type-only 边是否纳入「只能被 app 挂载」条文，同待裁决。

## 并行交集

本次只改 `scripts/check-layer-boundaries.mts` + `docs/说明书/Pylon-模块维护地图.md`（验证节一句）+ 本记录。#487/#488（共享树在途，Rust 域）与 #490（`session/expiry.rs` + 维护地图 Native session 行）文件域零重叠；维护地图同文件不同行，按 hunk 分账无冲突。
