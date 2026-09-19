# Dev Record — #195 设置 sheet 打开后无法关闭、标题栏无法交互

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：#195
- 分支：`Ru5t/Reflector`
- 提交范围：`982eac73..c7ae2cdb`
- 日期：2026-09-19

## 目标与范围

用户原话：「设置sheet进入后，无法关闭设置sheet，无法与titlebar交互」。

达成：设置 sheet 活动时恢复常规关闭途径（页签 X / 右键关闭 / 键盘 Delete），标题栏不再整体锁死。依据 #154 阶段 4 的约定「sheet 由页签与 titlebar 关闭」与 ADR-0013 的幂等收敛语义。

不做：不新增关闭途径（不加 ESC、不加齿轮「关闭设置」项——待用户裁定另立 issue）；不动 `SheetTabStrip`（三条关闭路本就完整）；不动设置导航契约面。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/plugins/product/packages/builtin.pylon-shell/styles/App.css` | 「设置打开态」交互锁整块（pointer-events 规则、空匹配的例外选择器、冗余 z-index） | 删除（留一行防回潮注释） |
| `src/workspace-sheets/WorkspaceTitlebar.tsx` | `settingsOpen` / `onToggleSettings` props 及锁类拼接删除；`onOpenSettingsDomain` 转必选；`TitlebarContext.settingsOpen` 改由 `activeSheetKind` 派生 | 修改 |
| `src/App.tsx` | `onToggleSettings`（死 toggle 分支）与 `settingsOpen` 传参删除 | 修改 |
| `src/workspace-sheets/__tests__/workspaceTitlebar.css.test.ts` | 新增静态契约：App.css 不得含该锁 | 修改（新增用例） |
| `src/workspace-sheets/__tests__/workspaceTitlebarLaunchers.test.tsx` | baseProps 去 `onToggleSettings`；「设置打开时菜单可用」用例改 `activeSheetKind` 驱动 + 断言无锁类 | 修改 |
| `src/workspace-sheets/__tests__/workspaceTitlebarSidebarToggle.test.tsx` | 三处传参改 `onOpenSettingsDomain` | 修改 |
| `src/workspace-sheets/__tests__/agentStatusConsumerMatrix.test.tsx` | baseProps 去 `onToggleSettings` | 修改 |

## 方案要点

- **锁整体删除而非修补例外选择器**：设置已不是覆盖层而是普通布局 sheet，标题栏无锁的理由；修补例外等于保留一个无理由的锁。
- **死代码一并清理**：齿轮菜单重设计（`be6da8d8`）后 `onToggleSettings` 在生产接线中不可达（`App.tsx` 恒传 `onOpenSettingsDomain`），「齿轮 = 开关」语义已被菜单域跳转取代（ADR-0013 幂等收敛），删除而非复活——复活属新的产品决策。
- **`TitlebarContext.settingsOpen` 保留**：开发者版说明书 §6.8.1 明文的插件 API 面（全仓暂无插件消费），由 `activeSheetKind === 'settings'` 派生，值语义不变。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 样式表零条 `titlebar-settings-open` 规则 | ✅ 实机扫描全部 `document.styleSheets`，0 条命中（修复前 5 个规则块） |
| 设置活动态标题栏可点 | ✅ `.workspace-titlebar-workspace` / `.sheet-tab-strip` / `.workspace-titlebar-sidebar` / `.workspace-titlebar-menu-icon` computed `pointerEvents` 全部 `auto` |
| 页签 X 关闭设置 | ✅ 真实鼠标点击（`hitIsSelfOrDescendant: true`）关闭成功；兄弟页签（overview / agent）幸存、焦点回落到前一 sheet |
| 齿轮菜单域跳转 | ✅ 菜单在设置活动态可开合，「外观」域项点击后设置 sheet 聚焦激活（singleton 不重复开） |
| 非活动页签关闭 | ✅ overview 页签 X 关闭正常 |
| 窗口三钮 | 未实点（点了会真关窗口）；锁删除后其 pointer-events 链路无任何变化，computed `auto` |
| 静态契约测试 | ✅ 新用例绿（jsdom 测不到 pointer-events，故在 CSS 契约层钉死） |

## 测试处置

修改的既有行为测试（prop 契约变更，无降级断言）：

- `workspaceTitlebarLaunchers.test.tsx`：「设置菜单在设置页打开时仍可切换顶层域」→「设置 sheet 活动时标题栏不被锁：无打开态交互锁类，齿轮菜单照常切换顶层域」（`settingsOpen` prop 驱动改 `activeSheetKind="settings"`，新增无锁类断言）。
- `workspaceTitlebarSidebarToggle.test.tsx`：三处 `onToggleSettings={vi.fn()}` → `onOpenSettingsDomain={vi.fn()}`。
- `agentStatusConsumerMatrix.test.tsx`：baseProps 同上。

新增：`workspaceTitlebar.css.test.ts`「#195：设置打开态不得锁标题栏」。

## 证据

- commit：`c7ae2cdb`（fix）；协调提交 `982eac73`（L.md）
- 测试：定向 7 文件 54/54 通过；全量前端 **606 文件 / 4440 用例通过（0 failed，2 todo）**；`tsc -b` exit 0；`lint` 0 error（1 条 `RightRailHost.tsx` 既有 warning，他人文件域）；`check:first-party-styles`、`check:docs` exit 0
- 实机：`bunx vite build` → `cargo build --manifest-path src-tauri/Cargo.toml --bin pylon`（`CARGO_TARGET_DIR=D:/pylon-acceptance-target`，2m28s）→ 启动后经 webview2 MCP（Edg/153.0.4234.46）逐项点击验证，证据数值见上表；验收后实例已关闭
- 页签 X 的「悬停显现」是 #154 既有交互（`.sheet-tab.active:not(:hover):not(:focus-within)` 时隐藏），与本修复无关，实机按真实用户次序（先 hover 后 click）验证

## 与 spec 的偏差

- 无方案偏差。
- 补充观察（非本 issue 范围）：一次意外关窗（设置菜单交互中途）后，持久化恢复的 agent sheet 在关闭设置页签时连带消失，控制台伴有一条「读取最近会话失败」错误；干净启动序列中两次复验关闭路径均无级联，未再复现。判定为会话恢复失败的边缘一次性异常，与本修复无关（本修复未触碰 close/持久化链路），留观。

## 未解问题

- 齿轮菜单是否补显式「关闭设置」项、是否支持 ESC 关闭设置 sheet——产品决策，待用户裁定后另立 issue。

## 并行交集

本次碰过的共享文件：`builtin.pylon-shell/styles/App.css`、`src/App.tsx`、`src/workspace-sheets/WorkspaceTitlebar.tsx` 及三个 titlebar 测试文件。工作树中 `src-tauri/resources/sdk/pylon-plugin-sdk.js` 的在途改动非本 issue 产物，未 stage、未改写。
