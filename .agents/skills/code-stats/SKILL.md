---
name: code-stats
description: 统计 Pylon 代码量的多维数据——生产 vs 测试精准拆分（Rust 内联 #[cfg(test)] 按行切出）、语言/区域/模块分布、最大文件、测试用例计数。用在需要报告代码规模、写开发记录里的体量数据、评估改动面积、对比重构前后规模时。数据只读扫描 git 工作树，不改任何文件。只是想知道某个文件多少行不必用这个。
---

# 代码量统计（Pylon × code-stats）

单文件行数用 `wc -l` 就够；这个 skill 是回答「**这个仓库真实生产代码有多少、测试有多少、都在哪**」——通用工具（cloc/tokei）给不出本仓的两个硬口径：插件开发 SDK 要剔除，Rust 测试大量**内联**在生产文件里要按行拆出。

## 用法

```bash
bun scripts/code-stats.mts          # 人读报表
bun scripts/code-stats.mts --json   # 机器可读（写脚本对账用）
bunx vitest run scripts/code-stats.test.mts   # 口径回归用例
```

只读扫描（`git ls-files` + 读文件），不改任何文件，无新依赖。

## 口径（脚本头注释与实现一致，此处是人话版）

- **计入语言**：TS/TSX/JS/JSX、Rust、CSS、HTML、Python、Shell、C。JSON/TOML/YAML/Markdown 是配置与文档不计入——锁文件因此天然排除（另显式排除 `.d.ts`）。
- **crate 区域清单随 Cargo workspace**：动态解析 `src-tauri/Cargo.toml` 的 `[workspace] members`（剔除主包 `.`），新拆 crate 无需改脚本（#247 拆分曾造成硬编码清单漂移，见 #259）；解析失败退回脚本内 `CRATES_FALLBACK` 静态快照（改 workspace 结构时顺手核对快照）。
- **排除面**（单列存照，不隐瞒）：
  - 插件开发 SDK：`src/sdk/`（SDK 源码，`build-plugin-sdk.mjs` 的输入）与 `src-tauri/resources/`（发行包内嵌 SDK + 数据）；
  - `examples/` 示例插件、`src-tauri/vendor/` 第三方；
  - 工具链：`scripts/`、`tools/`（webview2-mcp）、`pylon-markdown/gen|parity`（模块地图标注「非产品运行时」）、根配置（vite/vitest/eslint）。
- **测试判据**：
  - TS/JS 文件级：`__tests__`/`__fixtures__`/`__mocks__`/`test`/`tests`/`test-utils` 目录、`*.test.*`/`*.spec.*`。注意 `mockBlocks.tsx` 这类 **mock/demo 数据不是测试**，算生产；
  - Rust **行级**：`#[cfg(test)]`（含 any/all/not 组合求值）标注的 item 区域用词法器从生产文件里切出——词法器处理 raw string（可跨行）、嵌套块注释、char 与生命周期歧义；
  - Rust 测试专属文件：父模块 `#[cfg(test)] mod x;` 声明的文件（如 `*_tests.rs`、`test_utils.rs`）、`tests/` 集成测试、`src-tauri/src/bin/pylon-fake-agent.rs`（test-agent 门控）。
- **行类型**：代码行 = 非空非纯注释；注释行 = 整行均为注释；空行 = 纯空白；行内尾注计入代码行。跨行字符串（含 raw string）与块注释的**内部行按内容归类**——有内容算 code/comment，内部纯空行仍是空行（#259 前内部行一律被误计为空行，注释行因此被大幅低估）。

## 解读与坑

1. **数据 = 当前工作树，含他人在途 WIP。** 本仓是共享工作树，`git ls-files --others` 会把别人未提交的文件也扫进来（这是「当前真实状态」；审阅历史某时点请自行 stash/checkout 后重跑）。并行施工期间两次跑出不同数字属正常——先看 HEAD 变没变。
2. **「测试/生产 ≈ 0.7~0.8 : 1」是这个仓库的正常水位**（2026-09 实测 0.73），测试占比骤降才值得警惕。
3. **Rust 内联测试行数只认 `cfg(test)` 门控。** `#[cfg(feature = "test-agent")]` 也按 test-only 处理（本仓该 feature 只用于假 agent）；`cfg_attr(test, …)` 不是门禁，算生产。改了 Cargo features 语义时要回来核对这个求值器。
4. **报表里的「文件」列含该区域的测试文件**；只有「生产代码」语言总览是纯生产文件数。
5. 总量想独立复核：`git ls-files … | xargs cat | wc -l` 与脚本 `--json` 的 production+test+excluded 三段之和应对得上（±末行无换行的文件的 1 行差/文件）。

## 改口径的规矩

任何判据变更（新增排除目录、测试判据、语言）必须：改 `scripts/code-stats.mts` → 在 `scripts/code-stats.test.mts` 补钉住该判据的用例 → 同步更新本文件与脚本头注释。口径漂移比没有数据更糟。
