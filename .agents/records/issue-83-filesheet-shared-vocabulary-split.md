# Dev Record — #83 FileSheet.css 跨 sheet 共享词汇解耦为独立基座文件

## 元信息

- issue：[#83](https://github.com/AlchemistCxC/Pylon-co-works/issues/83)
- 分支：`Ru5t/Reflector`
- 提交范围：开工 HEAD（`cf8f4919` 之后工作区）→ 本 commit
- 日期：2026-09-14

## 目标与范围

把 FileSheet.css 中的跨 sheet 共享词汇（解耦评估批 1 登记的 `shared` 豁免面）
剥成独立基座文件，file 域样式回落 `plugin-scope`——解耦评估的第一刀。

**不做**：FileSheet 内部域绞杀；共享词汇 utilities 化；`search-result-line/file`、
`file-section-panel/muted`、`file-main` 等内部类迁移；两个 adaptive.css 的任何
改动；行为断言修改。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `builtin.pylon-workspace/styles/SheetVocabulary.css` | 新文件，约 60 行 | 新增 |
| `builtin.pylon-workspace/styles/sheets/file/FileSheet.css` | 头部注释 + 9 处规则块移除（file-section-title/hint 两代、file-main-kicker/title、file-tree-error、search-result 五类三代、focus 组选择器成员、git-status 三组瘦身） | 修改 |
| `builtin.pylon-workspace/styleAssets.ts` | glob 数组首位挂载 SheetVocabulary.css | 修改 |
| `src/plugins/product/firstPartyStyleOwnership.ts` | 新增 SheetVocabulary 条目（`shared`）；FileSheet 条目 `shared`→`plugin-scope`，note 更新 | 修改 |
| `src/plugins/product/__tests__/firstPartyStyleOwnership.test.ts` | expectedCssPaths 增加新路径；workspace owner 计数 6→7 | 修改 |

## 方案要点

1. **消费方矩阵先行**：逐文件 grep 确认外部消费面后划线——只迁外部消费的
   9 个类（含 `:hover`/`:focus-visible` 变体与 `.search-result-text mark`
   后代规则）；内部类（`search-result-line/file` 等）留在 FileSheet.css。
   注意 P93 注释里的 `file-main-`/`search-result-` 前缀匹配多为注释文本，
   HistorySheet 实际已不带共享词汇（其基线已并入 utility）。
2. **压平再搬家**：`file-section-title`（两代）、`search-result-list/row/path/text`
   （两至三代）按「同优先级后代规则覆盖前代」解析为单一 canonical 版本。
   两处易漏的**首代残留**被保留：`search-result-row` 的 `font-size:12px;
   font-family:var(--font)`（末代 grid 版未覆盖，持续生效）；
   `search-result-path` 的 `font-size:11px` 来自组选择器代。`flex-direction:
   column`（首代遗留）在 `display:grid` 下失效，不随迁。
3. **跨文件耦合核对**：workspace `adaptive.css` 的 modern-gui
   `.search-result-row` 覆写（含 hover `border-left-color`）依赖基座
   `border: 1px solid transparent`——压平版保留；二者特异性不同，与挂载顺序
   无关。ContextPanel.css 的 `.context-panel-body …` 覆写均为 (0,2,0) 后代
   选择器，压过基座 (0,1,0)，行为不变。FileSheet.css 保留
   `.file-section-panel > 子类` 的 margin-inline 上下文覆写（父类属 file 域，
   外部消费方不经过该上下文）。
4. **挂载顺序**：vite glob 按路径排序，`SheetVocabulary.css`（`S` < `a`/`c`/`s`）
   先于 adaptive/components/sheets 注入；拆分后两文件无选择器重叠，顺序无
   行为影响。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `check:first-party-styles` | ✅ 23 files，workspace 7 |
| `check:tailwind-tokens` / `check-css-var-consumption` | ✅ / ✅（325 消费、0 悬空） |
| 定向 vitest（ownership / FileSheet.css / gatewayPackage / Sidebar.css / workspaceTitlebar.css） | ✅ 5 文件 16 用例 |
| `tsc -b` | ✅ 0 |
| 级联终值等价性（脚本比对 git HEAD FileSheet.css vs 新双文件，含组选择器与 shorthand 展开） | ✅ EQUIVALENT（仅 `flex-direction` 例外：grid 下失效属性） |
| 行为断言未被修改 | ✅（仅所有权清单测试按事实更新） |
| 未新增白名单豁免 | ✅（`shared` lifecycle 为既有类别，文件数 +1） |

## 遗留与后续

- 共享词汇 utilities 化（消灭全局类名泄漏）留待后续批次单独评估。
- FileSheet.css（现 1,154 行）内部域绞杀降级为顺手做；CodeMirror/gutter
  区段与 issue #69 几何契约为永久残量。
- GatewaySheet 对 `file-tree-error`/`file-section-hint`/`search-result-path/text`
  的复用自此有显式契约文件可依，P92 登记的 gateway 解耦评估可基于本刀继续。
