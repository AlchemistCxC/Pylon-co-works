# Dev Record — #274 设置 sheet 插件贡献页导航被困 + 双入口重复

## 元信息

- issue：[#274](https://github.com/AlchemistCxC/Pylon-co-works/issues/274)
- 分支：`kumo/prometheus`
- 提交范围：`7b21b39e..f855ba6d`（L.md 声明 → fix → test → docs）
- 日期：2026-09-24

## 目标与范围

修复实机验收发现的两个问题：① 插件贡献页 `pluginPageId` 一旦写入设置 sheet 状态即无法经任何 UI 路径清除，内容区永久被困（侧栏/标题栏菜单/速搜全部失效）；② 宿主「插件管理」分区（P53 重定向渲染贡献页）与贡献页独立侧栏条目内容完全重复。

**不做**：不改 `patchSheetState` 浅合并语义（store 层全 sheet kind 通用）；不改 `normalizeSettingsIntent` 域/分区/深链契约（ADR-0013）；不动 `rendererCategoryId` 同型陈旧隐患（仅 renderers 分区消费，无用户可见危害，挂账）；不动插件管理器面板内容与样式。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/settingsDomains.ts` | `SettingsIntent.pluginPageId` 类型放宽 `string \| null` + 新增 `HOSTED_PLUGIN_MANAGER_PAGE_ID` 常量 | 修改 |
| `src/workspace-sheets/settingsSheetState.ts` | normalize 的 pluginPageId resolve（显式 null=清除）+ serialize 剥 null + 注释 | 修改 |
| `src/sheets/SettingsSheetSidebar.tsx` | plugins 域插件页列表过滤宿主托管贡献 | 修改 |
| `src/components/Settings.tsx` | P53 重定向处硬编码贡献 id 换常量 | 修改 |
| `src/workspace-sheets/__tests__/settingsSheetState.test.ts` | 形状断言跟随 + 新增 #274 回归 describe | 修改 |
| `src/sheets/__tests__/settingsSheetNavigation.test.ts` | 新增深链逃逸用例 | 修改 |
| `src/components/__tests__/Settings.pluginPageDedupe.test.tsx` | 侧栏去重 + 导航跟手 jsdom 集成 | 新增 |
| `docs/说明书/Pylon-插件系统说明书-用户版.md` | §5 管理面板入口表述同步 | 修改 |

## 方案要点

1. **清除语义放在 codec，不动 store**：困局根因是「归一输出把 null 归并成键缺失 × patchSheetState 浅合并 × activePluginPageId 非空即渲染插件页」三段接力。normalize 输出改为**恒含** `pluginPageId`（string 或 null），作为完整快照参与「最后写入胜出」——侧栏预归一、`openOrFocusSettingsSheet` 深链、速搜全部自动获得清除语义，零调用方改动；`serialize` 落盘前剥除 null，持久化形状与历史版本零差异（ADR-0013 决定 4 老状态可读：旧盘上只有「无键/非空字符串」两种形状，新 codec 对二者解释逐字节不变，且已中招用户升级后点任意导航即可逃逸）。
2. **去重取「保留宿主条目」**：贡献存在时宿主分区已直接渲染该页（P53 重定向，`Settings.tsx` case 'pluginManager'），贡献页条目无独立信息量；宿主条目在插件未激活时还承载授权卡回落页。过滤按共享常量 `HOSTED_PLUGIN_MANAGER_PAGE_ID`（与重定向处同源），其余插件贡献页不受影响。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| codec：显式 null → 输出含 `pluginPageId: null`；serialize 剥除；patch 序列卡死复现回归 | ✅ vitest 绿（4 用例） |
| 深链逃逸：卡死状态经 `openOrFocusSettingsSheet` 清除 | ✅ vitest 绿 |
| 集成：贡献注册下侧栏 0 独立条目 + 宿主分区承载 + Hook 诊断点击内容跟手 | ✅ vitest 绿（2 用例） |
| 实机：本轮产物核验 | ✅ 运行中 App 加载 `first-party-pylon-shell-0x0SFO0Q.js`（含本轮独有的去重 filter，旧 bundle 无此代码）；入口 chunk `index-B3qC5A4K.js` mtime 03:43 本轮 |
| 实机：插件域侧栏分区条目 | ✅ 恰好 2 个（插件管理/Hook 诊断），独立插件页条目 0（修复前 1） |
| 实机：宿主分区重定向 | ✅ 点「插件管理」→ `data-plugin-manager-page` 挂载 |
| 实机：导航逃逸 | ✅ 点「Hook 诊断」→ `section=hookDiagnostics`、插件页 DOM 卸载、内容渲染 Hook 诊断面板（修复前内容永远停在插件页）；安全模式往返后复核一致 |
| 门禁：`tsc -b` / eslint / 全量 vitest | ✅ 0 error（lint 唯一 warning 在 `RightRailHost.tsx`，非本轮文件）；**636 文件 / 4819 用例全绿**（1 skipped/1 todo） |
| 门禁：cargo build | ✅ dev profile 2m42s（`CARGO_TARGET_DIR=D:/pylon-acceptance-target`） |

## 测试处置

- `settingsSheetState.test.ts`：既有 6 条 `toEqual` 形状断言**逐条跟随**「恒含 pluginPageId 键」（非降级，语义增强所致）；新增 4 条（显式 null 清除 / serialize 剥除 / patch 序列回归 / 贡献深链不误伤）。
- `settingsSheetNavigation.test.ts`：新增 1 条卡死逃逸用例。
- 新增 `Settings.pluginPageDedupe.test.tsx`（2 条，复用 `settingsSheetHarness` + 真实 kernelBootstrap 授权路径，预算口径沿用 `pluginManagerDefaultPage` 的 4s waitFor）。
- 其余既有测试零修改。

## 证据

- commit：`71491fea`（fix）、`f3d00ed9`（test）、`f855ba6d`（docs）
- 测试：`bunx vitest run` 全量 exit 0，`Test Files 636 passed | 1 skipped (637)`、`Tests 4819 passed | 1 skipped | 1 todo`
- 手工验证：webview2-mcp 实机（调试端口 9222，D 盘 target 构建）。产物核验命令：页面内 fetch 加载 chunk 检索 `contributionId!==`；侧栏计数 `nav.querySelectorAll('.set-nav-btn.plugin-page').length === 0`；逃逸复现 `data-settings-section` 与 `data-plugin-manager-page` 联动比对。

## 与 spec 的偏差

无实质偏差。实现细节一处与 spec 措辞不同：spec 写「`openOrFocusSettingsSheet` 需显式补 `pluginPageId: null`」，实现采用更简的「normalize 输出恒含该键」方案，深链入口零改动即获得清除语义（若深链显式携带贡献 id，字符串优先，不误伤）。

## 未解问题

1. `rendererCategoryId` 存在同型陈旧隐患（仅在 renderers 分区消费，危害有限），待后续 issue 决定是否统一处理。
2. 本轮暴露一个流程坑：**纯前端改动 + 零 Rust 改动时，`cargo build` 可能因 pylon crate 判定 fresh 而不重嵌新 dist**（本轮以「运行中 chunk 检索本轮独有代码」核验兜住）。建议后续在 `webview2-acceptance` skill 的产物核验条目中把「检索本轮独有代码标记」固化为标准步骤，替代 hash 比对（hash 对不上入口/普通 chunk 容易误判）。

## 并行交集

`src/components/Settings.tsx`、`src/sheets/SettingsSheetSidebar.tsx`、`src/settingsDomains.ts`、`src/workspace-sheets/settingsSheetState.ts`。全程 pathspec 提交，工作树内无他人在途改动。
