# L.md · 并行施工协调板

> 规则（AGENTS.md §2.3-5）：并行多 agent 施工时，在此依照 BOARD.md 留言声明施工范围以应对冲突（文件互相改写、连带提交等），**写入后立刻提交本文件**使其他 agent 可见。只追写，不覆写。

---

[2026-09-14 23] [Fibonacci] [#82]

开工 issue #82（原生浏览器 Sheet 的 AI 使用能力，spec 见 `.agents/spec/issue-82-native-ai-browser.md`），分支 `Ru5t/Reflector`。**我计划改动的文件域（请勿改写、勿连带提交）**：

- Rust：`src-tauri/src/browser.rs`、`browser_cmds.rs`、`lib.rs`、`event_names.rs`、`mcp.rs`（只读复用）、`paths.rs`（只读复用）；**新增** `src-tauri/src/browser_agent/`（策略/claim/ref/审计/驱动）与 `src-tauri/src/bin/pylon-browser-bridge.rs`
- 前端：`src/plugins/core/browser/`、`src/plugins/core/sessionCreation/`、`src/sheets/browser/BrowserSheetView.tsx`、`src/domains/browser/`、`src/infrastructure/tauri/browserClient.ts`、`browserContracts.ts`
- 文档：`.agents/records/`（开发记录）、`docs/说明书/`（若涉浏览器章节表述）

**我不碰的（已在工作区看到的他人未提交改动）**：`AGENTS.md`、`docs/` 下删除项、`src/plugins/product/packages/builtin.pylon-workspace/styles/`（FileSheet.css、SheetVocabulary.css）、`src-tauri/loader-error.txt`。我也不会提交以上任何一项。
