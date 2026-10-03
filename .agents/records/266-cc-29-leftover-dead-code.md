# Dev Record — #266 CC-29 遗留死代码清理（同族死规则 + 战术蓝死变量）

> ★ **本记录为完工后补写**（2026-10-03）：原施工单未点名「开发记录」这一条（同 CC-30 的疏漏，已一并记教训）；施工与验收本身按单完成。

## 元信息

- issue：[#266](https://github.com/AlchemistCxC/Pylon-co-works/issues/266)（**CC-29 遗留**；清单真值 = 卡 `待办\中控台CSS生效性审计-待查.md`）
- 分支：`feat/cc-29-leftover-cleanup.1`（从 `origin/main` 新建，已 `--unset-upstream`；**待提交**）
- 提交范围：**未提交**（等用户口令）｜单：`待办\16-施工单-CC-29遗留死代码清理.md`
- 日期：2026-10-03（施工与翻译验收同日）

## 目标与范围

把 CC-29 主单「只登记未动」的同族残留删干净——都是旧 UI 残骸（类名/变量在生产代码零命中）：

1. `.cc-footer` / `.cc-footer-status`（`ControlCenter.css`；状态行旧类名族，真身是 `.cc-status-row`）；
2. `.input-composer-shortcut`（`chat/InputBar.css` 三条，含一条单规则 media）；
3. 战术蓝 `--input-text-color` / `--input-placeholder` 两条定义（`builtin.pylon-shell/styles/App.css`；**用户 2026-10-03 拍板一起删**）。

- **不做**：`inputBorderColor` / `inputBorder` 字段重叠（产品判断）；扫描面扩到全部规则（另办）；域外同病；任何布局/视觉参数。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `…/components/ControlCenter.css` | 删 `.cc-footer` / `.cc-footer-status` 两行 | 修改（删） |
| `…/components/chat/InputBar.css` | 删 `.input-composer-shortcut` ×2 + 单规则 media ×1；CC-29 注释改写为「四段规则均已删」 | 修改（删 + 注释同步） |
| `…/builtin.pylon-shell/styles/App.css` | 删战术蓝块里 `--input-text-color` / `--input-placeholder` 一行 | 修改（删） |

净：**3 文件、1 insertion / 8 deletions**。

## 方案要点

- **判据**：「死」= 选择器类名 / 变量在**生产代码里零命中**，一律用**原始 grep**（`/usr/bin/grep`）复核——本机 `grep` 默认是 **ugrep**，`--include` 语义不同（环境坑，见「未解问题」）。
- **注释随删同步**：InputBar.css 里那句「shortcut 一段不在本单清单内，原样保留」随本次删除而失真 ⇒ 同轮改写为与事实一致（本单点名的第 3 处改动）。
- `cc-footer` 的唯一 TS 命中是 `ControlCenter.solid.tsx:803` 的 JSX 注释（`.cc-footer-peri`），**非活类名**——判活时逐条排除。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 五对象 grep 读数 | CSS 侧 **全 0**；生产 TS/TSX 仅剩那 1 处注释 ✓ |
| 改动面 | 恰 3 文件、1+/8−、无越界 ✓ |
| 门禁五步（翻译独立重跑） | `EXIT 0/0/0/0/0`；`666 files / 5216 passed | 1 skipped | 1 todo (5218)` |
| CSS 消费审计 | 「死注入与悬空引用均为 0」；**声明 358 → 356**（与单预期吻合） |
| 皮肤契约 | 176 字段 / **88 变量不变**（二变量不在契约内） |
| 契约快照 `--write` | 唯一 diff = `generatedAt`（实质零变化）；已还原 |
| 实机（重建 debug 二进制） | CSSOM 四对象全不在、`.cc-status-row` 与 `.input-binding-status` 在；中控 6 件 / 输入栏正常；零视觉变化（预期） |

## 测试处置

| 文件 | 处置 |
| --- | --- |
| —— | **零改动**（复核确认无测试/夹具断言这三个类名；快照不含这两条变量） |
| 本单不新增测试 ⇒ 反向验证**不适用**（铁律：只对新测试做）；替代核验 = 删前/删后 grep + 门禁 + 快照 + 实机 | |

## 证据

- 改动：工作树 `git diff --stat`（3 文件 / 1+ / 8−）
- 门禁与审计原文：见报告
- 报告（仓外）：`工作台优化\报告等\16-施工单-CC-29遗留死代码清理\2026-10-03-翻译验收报告.md`（含工作者汇报同目录）
- 同族复查登记（19 类名）：已整理进卡 `待办\中控台CSS生效性审计-待查.md` §八

## 与 spec 的偏差

- 无（单内 3 处改动 + 1 处注释同步，逐条按单落地）。

## 未解问题

1. 卡内遗留两项仍挂：扫描面扩到「全部规则」；`inputBorderColor` / `inputBorder` 字段重叠（待产品判断）。
2. **环境坑记两条**：① 本机 `grep` = ugrep（`--include` 语义不同）⇒ 死代码复核用 `/usr/bin/grep`；② 契约快照 `--write` 每次机械刷新 `generatedAt` ⇒ 跑完须 `git restore` 那一行。

## 并行交集

- `…/styles/components/`（ControlCenter.css 等）与 `…/styles/components/chat/`（InputBar.css）、`builtin.pylon-shell/styles/App.css`（战术蓝块）。
- `#410` 已搁置、避让已解除；本单未碰任何布局/视觉参数。
