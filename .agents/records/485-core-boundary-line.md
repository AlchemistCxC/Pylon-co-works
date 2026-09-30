# Dev Record — #485 plugins/core 定性划线（方案 C）施工

## 元信息

- issue：#485（决策口裁决：方案 C 混合——core 定性为「经插件机制交付的首方实现」）
- 分支：`kumo/485-core-boundary`（独立 worktree `G:/Project/prism-team-workdir/pylon-485`，基于 github/main）
- 提交范围：`df6cd864..<head>`
- 日期：2026-10-01

## 目标与范围

按裁决三件事：① 盘点 core 导出面划线成文（清单入库、who/why）；② product-contribution guard 扩展管辖 sheets 与 core；③ 存量直连按划线处置（线内白名单豁免、线外改道走注册表）。

**不做**：不改 `src/plugins/**` 本体；不管辖 workspace-sheets/renderers（裁决字面只扩 sheets）；不处理非视图层直连（cli/domains/application，仅盘点）；不收缩 CONTEXT.md「插件」定义（方案 C 不收缩）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/app/interfaceModeLookup.ts` | 新增 `findInterfaceModeContribution(modeId)`：registry 真值优先 + builtin 表回退的唯一查询缝 | 新增 |
| `src/app/useActiveInterfaceModeContribution.ts` | 回退链两行改调共享查询，删 core 直连 import | 修改 |
| `src/components/settings/useSettingsContributionCatalog.ts` | mode 解析改调共享查询，删 core 直连 import 与多余 registry import | 修改 |
| `src/components/settings/RendererSuitePicker.tsx` | 同上（含 `modeRegistry` 局部变量收敛） | 修改 |
| `src/components/settings/RendererSettingsPanel.tsx` | 同上 | 修改 |
| `scripts/check-product-contribution-boundary.mts` | 规则二：core 划线符号级检查 + `CORE_INTERNAL_API_ALLOWLIST` 白名单（5 条 who/why）+ 管辖面加 `src/sheets/**` + 跳过测试文件 + guard-the-guard fixtures（线外/白名单/多行/re-export/命名空间/动态/副作用/非 core 八类） | 修改 |
| `docs/说明书/Pylon-模块维护地图.md` | 「第一方产品」行补 #485 划线口径与白名单唯一真源指引 | 修改 |

## 方案要点

- **划线原则**：贡献声明数据（将被 register 进注册表的清单，如 `BUILTIN_INTERFACE_MODES`）= 插件面，视图消费必须走注册表；契约常量（surfaceId、读取预算）与贡献产物读取端（`collectProfilePersona`/`collectFirstMessagePromptPrelude`，输入即注册表快照、按贡献 ID 匹配系产品特定语义）= 内部 API 面，白名单豁免。`runSessionPreflight` 属 application 层（非视图管辖），登记口径完整性未占白名单。
- **改道姿势**：回退语义原样收拢到 app 层共享查询（app 层是「registry+builtin 缝」的家，先例即 `useActiveInterfaceModeContribution`）。行为等价依据：`registerMode` 以 `contribution.id` 为 `contributionId`，`registry.resolve(modeId)` 与原 `snapshot.entries.find(e => e.value.id === modeId)` 同谓词同快照源；组件测试（registry 未填充直接挂载）行为不变、零断言改动。
- **guard 形态**：符号级白名单（文件 → 符号 → 理由）而非文件级——防止白名单文件 future 混入线外符号；命名空间/默认/动态/副作用/re-export-all 一律不可豁免（`*` 形态无法证明符号身份）；`export {...} from` 视同直连管辖；测试文件（`__tests__`/`*.test.*`）不入管辖（测试本就直连被测实现；原 product 规则现状测试面零违规，收窄为行为等价）。
- **清单即文档**：划线明细唯一真源 = guard 脚本 `CORE_INTERNAL_API_ALLOWLIST`（机器执行与文档合一），维护地图引用之。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| guard 绿（12 处现状：4 改道消失、5 白名单放行、3 非视图不扫） | ✅ `product contribution boundary passed（App/components/sheets；core 划线白名单 5 条符号豁免）` |
| 实操负向验证：sheets 加线外 core import → guard 红 | ✅ 精确报 `[core 插件面] src/sheets/OverviewSheetView.tsx: import { BUILTIN_INTERFACE_MODES } ...`，exit 1；恢复后绿 |
| `check:solid` 全链绿 | ✅ 全部静态门禁通过（runtime-boundaries 25 条 legacy 仅报告为既有口径） |
| `tsc` 主配置 + solid 配置 | ✅ 双绿（worktree 需先 `build:wasm` 生成产物） |
| 相关单测 | ✅ `src/components/settings src/sheets` 609 通过；`src/__tests__ src/app` 842 通过；`src/components src/domains/interface src/plugin-runtime/interface-mode` 437 通过 |

## 测试处置

无既有测试修改/删除。guard 脚本内嵌负向 fixture 扩展（见改动清单）。

## 证据

- 测试命令与计数见上表；guard 输出原文见验收表。
- 手工验证：`bun scripts/check-product-contribution-boundary.mts`（绿）→ 临时注入违规行（红，exit 1）→ 恢复（绿）。

## 与 spec 的偏差

无实质偏差。补充决定：guard 对测试文件的收窄（spec 未提前写明，实现时确认测试直连被测实现属正当场景，收窄对 product 规则行为等价）。

## 未解问题

- `src/renderers/solid-workbench/smoke/mountSolidRichQa.solid.tsx` 存在 3 行 `plugins/product` 直连（QA smoke 挂载件）——不在本次管辖（裁决字面只扩 sheets），留作后续若扩管辖 renderers 时的已知存量。
- agent-workbench 三件的白名单条目在 #486 项1 将 `src/sheets/agent-workbench/**` 迁 `src/application/agent-workbench/**` 后随迁失效（application 非视图不入管辖），届时由搬移方移除条目（L.md 已互相声明）。

## 并行交集

- `docs/说明书/Pylon-模块维护地图.md`：#486 项7 亦声明改此文件（域边界段）——本批仅动「第一方产品」表格行，段落不相邻。
- 共享工作树在施工期间被 #482/#483/#487 现场占用（HEAD 处于 `kumo/487-488-legacy-sunset-hygiene2`），本批按 §2.5 开独立 worktree 隔离施工，共享树内仅动过 `.agents/L.md`（在途声明）。
