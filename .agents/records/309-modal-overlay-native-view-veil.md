# Dev Record — #309 模态覆盖层打开期间原生子视图让位

## 元信息

- issue：[#309](https://github.com/AlchemistCxC/Pylon-co-works/issues/309)（bug，#308 的残留限制）
- 分支：`kumo/filesheet-stage0`（施工时共享工作树所在分支）
- 日期：2026-09-25
- 署名：Kumo
- spec：无

## 目标与范围

#308 修复后暴露的残留限制：活动 Browser Sheet 上打开 Sheet 启动器（或其它覆盖主区的模态层）时，弹窗被原生页面盖住——实测 `.sheet-launcher-dialog`（客户区 `(174,78) 780x720`）与原生子 WebView（`(240,124) 888x740`）重叠约 89%，重叠区内条目点不动，只能 Esc。

**修法（产品语义）**：覆盖层打开期间原生子视图**暂时隐藏**（页面继续运行），关闭后恢复。不在覆盖层与原生层之间做 z 序魔法——WebView2 子窗口天然在 DOM 之上，这是平台事实。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/app/modalOverlayStore.ts` | 新增：聚合「任一模态覆盖层打开」的 store + `useModalOverlayVeil(key, open)` 自我声明 hook | 新增 |
| `src/App.tsx` | 启动器 / Profile 编辑 / 会话设置三个覆盖层声明 veil | 修改 |
| `src/components/PermissionDialog.tsx` | 权限请求弹窗声明 veil（hook 在 early return 之前） | 修改 |
| `src/components/SessionOwnerRecoveryDialog.tsx` | 会话归属恢复弹窗声明 veil | 修改 |
| `src/components/sidebar/SessionsPanel.tsx` | 工作区设置弹窗声明 veil | 修改 |
| `src/sheets/browser/BrowserSheetView.tsx` | 原生子视图可见性判定 `isSheetActive && !modalOverlayOpen` | 修改 |
| `src/sheets/browser/__tests__/BrowserSheetView.modalOverlayVeil.test.tsx`、`src/app/__tests__/modalOverlayStore.test.tsx` | 回归用例 | 新增 |

## 方案要点

- **声明式而非 DOM 嗅探**：不在 BrowserSheetView 里用 MutationObserver 猜「有没有覆盖层」——小浮层（下拉、提示）会误伤（页面无谓闪烁）。由每个覆盖层一行 `useModalOverlayVeil(key, open)` 自我声明，store 聚合成一个布尔；新覆盖层照此一行接入。
- **多覆盖层聚合**：`openKeys: Set<string>`，任一打开即「打开」，全部释放才「关闭」；同一 key 重复声明不产生重复槽位。
- **不重复落盘**：veil 走 `browser_set_visible`（与切 Sheet 同一通路），不触 sink/journal。
- **页面隐藏期间继续运行**：只隐藏不销毁，标签/页面状态不丢（与 keep-alive 语义一致）。

## 验收标准与结果

实机（真实 Hermes 会话 + Browser Sheet 已导航出页面，窗口客户区 1128x864）：

| 观测 | 结果 |
| --- | --- |
| 启动器打开（Browser Sheet 活动） | 子 WebView `0x6F0C00` → `visible=False`（样式 0x52000000→0x42000000） |
| 窗口内命中测试（`ChildWindowFromPointEx`） | `launcher-center (640,300)` / `viewport-center` / `toolbar` 全部落**主** WebView（修复前 launcher-center 落子 WebView） |
| 启动器关闭（Esc） | 子 WebView 恢复 `visible=True` |
| 回归用例 | `BrowserSheetView.modalOverlayVeil.test.tsx` 2 例（让位/恢复、非活动 Sheet 不受覆盖层影响）+ `modalOverlayStore.test.tsx` 3 例（聚合/去重/卸载释放），5 passed |
| lint | 改动文件 `eslint` 0 告警 |

门禁说明：`bun run build` 的 `tsc -b` 当时被**他人正在编辑的** `src/sheets/file/__tests__/*` 挡住（非本改动），出包用 `bunx vite build`（产物等价），`cargo build` 通过；合入前应补跑完整 `check:frontend`。

## 测试处置

- 新增：5 条（见上）。
- 修改既有测试：无。

## 证据

- 实机脚本同 #308（`%TEMP%\pylon-{tree,hittest}.ps1`）；issue #309 评论区附逐项数值。
- 提交：`ee50df64`（pathspec，仅本改动 8 个文件）。

## 未解问题

1. 覆盖层清单是**显式**的：将来新增覆盖主区的模态层，需要一行 `useModalOverlayVeil` 声明（漏声明即复现本缺陷）。若想根治「漏声明」，需要布局层提供统一的 overlay host 事实源——另议。
2. 小型浮层（下拉/提示/右键菜单）**有意不让位**：它们不遮挡到「必须点按钮」的程度，让位会造成页面无谓闪烁。

## 并行交集

- `src/sheets/file/**`、`src/application/hooks/**` 属他人在途域，未触碰；提交一律 pathspec。
