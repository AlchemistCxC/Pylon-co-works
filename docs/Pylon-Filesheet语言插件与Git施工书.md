# Filesheet 语言插件与 Git 施工书

## 现状盘点

- `FileCodeEditor` 通过 `@codemirror/language-data` 按文件名异步选择内置语言；未知扩展名回退纯文本。当前没有语言包注册接口，插件无法贡献高亮、补全或格式化能力。
- `FileWorkbenchRegistry` 已提供 `file-provider`、`git-provider`、`renderer` 和 activity 四类贡献；`resolveFileProvider`/`resolveGitProvider` 按 priority + `canHandle` 选择 provider。
- `GitPanel` 已覆盖 status/history、diff、stage/unstage、commit、branch、pull、push；`sourceRequestGuard` 丢弃切换工作区后的迟到响应，写操作通过 `busyAction` 串行化。
- Git wire DTO 在 `gitContracts.ts` 统一归一化并分类 not-repo/unavailable/timeout/failed；当前未发现应删除的过时 Git 测试。

## 目标

开放受控的语言能力贡献 seam（语言识别、高亮，后续可选补全/格式化），不让插件直接持有 EditorView；保持内置语言为 fallback。继续保留现有 Git provider 边界，并针对大仓扫描、取消和迟到响应做性能验证。

## Slice A：language-provider seam（首片完成）

已新增 `language-provider` 类型的 File Workbench contribution：以稳定语言 id、文件名/扩展名匹配和异步 `load` 返回 CodeMirror `LanguageSupport`；宿主按 priority 选择并在 editor compartment 中安装，加载失败回退内置/纯文本。插件不得注入任意 DOM 或替换 Git provider。tab 销毁时通过 `AbortController` 取消未完成加载，迟到结果被丢弃。

## 兼容性、性能预算与可观察性

- 现有 `file-provider`/`git-provider` API、legacy adapter 和文件 tab 持久化不变。
- 语言包只在打开文件后加载；首屏不得引入插件语言包。单次加载应可取消或在 tab 销毁后丢弃结果。
- provider id、匹配语言、加载失败和回退路径进入诊断日志；Git 继续沿用 source generation guard。

## 证据

- `src/plugin-runtime/file-workbench/fileWorkbenchTypes.ts`：`FileLanguageProvider` 契约。
- `src/plugin-runtime/file-workbench/fileWorkbenchResolver.ts`：按匹配与 priority 选择 provider。
- `src/sheets/file/FileCodeEditor.tsx`：provider 加载、abort 与内置 fallback。
- `src/plugin-runtime/file-workbench/__tests__/fileWorkbenchRegistry.test.ts`、`src/sheets/file/__tests__/gitPanelAcceptance.test.tsx`、`gitPanelMutations.test.tsx`、`FileCodeEditor.test.tsx`：注册生命周期、语言加载边界、Git 操作和编辑器回归共 19 项通过；`npm.cmd run check:solid`。
- 本轮未发现过时测试；Git 的 source generation、冲突保存和 mutation busy guard 仍对应真实行为，保留现有断言。

## 验收边界

首片已验 language-provider seam + 内置 fallback 和取消/迟到响应；Git 功能保持现有测试矩阵，不因语言插件工作重写 Git facade。后续可在真实插件包中补充补全/格式化实现。
