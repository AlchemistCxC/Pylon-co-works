# Dev Record — #231 代码量多维统计脚本 + code-stats skill

## 元信息

- issue：[#231](https://github.com/AlchemistCxC/Pylon-co-works/issues/231)
- 分支：`Ru5t/Reflector`
- 提交范围：基线 `66a87542..`（本记录提交前）
- 日期：2026-09-22

## 目标与范围

达成：给仓库一个可信的代码量统计入口——生产 vs 测试精准拆分（Rust 内联 `#[cfg(test)]` 按行切出）、按语言/区域/模块多维分布、测试用例计数、`--json` 机器可读；配套 skill 说明口径。

不做：不改任何既有源码；不接入 CI 门禁（纯只读统计工具）；不统计 JSON/TOML/YAML/Markdown（配置与文档，锁文件因此天然排除）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `scripts/code-stats.mts` | 全部：路径分类、四种行扫描器（Rust 词法器 / TS 状态机 / CSS/HTML/Python/Shell/C）、cfg 求值器、聚合与渲染 | 新增 |
| `scripts/code-stats.test.mts` | 15 个用例：cfg 求值、内联区域边界、跨行字符串、外置 mod 声明、测试判据、路径分类、渲染辅助 | 新增 |
| `.agents/skills/code-stats/SKILL.md` | 口径明文 + 用法 + 解读坑 + 改口径规矩 | 新增 |
| `.agents/L.md` | 在途声明（开工时已单独提交） | 追加 |

## 方案要点

1. **Rust 行级测试拆分是本工具的核**：单遍词法器处理 raw string（`r#"…"#`，可跨行）、嵌套块注释、char 与生命周期歧义（`'a` vs `'x'`）、`b"/c"` 串；遇到 `cfg(test)` 门控属性时记下所在行，随后第一个 item 关键字（mod/fn/use/const/…）触发区域，按花括号配对（或 `;`）收口，区域内的物理行标记为测试行。
2. **`cfg()` 按生产构建语义求值**（`attrExcludesFromProduction`）：`test`→不成立；`feature = "…test…"`→不成立（本仓唯一 feature 是 dev 性质的 test-agent）；`not/any/all` 递归组合；`cfg_attr` 与目标平台谓词→成立（留在生产侧，保守）。
3. **Rust 测试专属文件靠父模块声明判定**：对每个 .rs 文件找父声明文件（`mod.rs`/`lib.rs`/`main.rs`/兄弟同名 .rs，2018 与老布局都覆盖），复用同一词法器取 `testModDecls`，单一代码路径。`src-tauri/src/bin/pylon-fake-agent.rs` 按 test-agent 门控显式列测试。
4. **TS/JS 状态机**处理模板字符串（含 `${}` 任意嵌套，brace 栈按上下文计数）、正则字面量（前一显著 token 启发式）、行尾注释；mock/demo 数据（如 `mockBlocks.tsx`）按生产算——mock ≠ 测试。
5. **排除面对齐既有事实**：`src/sdk/` 依 `build-plugin-sdk.mjs` 证实为 SDK 源码；markdown `gen|parity` 依模块地图「非产品运行时」；`vendor/`、`examples/`、`resources/` 单列存照不隐瞒。生产 headline = 前端 src/ + src-tauri 本体 + 六个子 crate。
6. 扫描基础 = `git ls-files --cached --others --exclude-standard`（与 audit-maintenance 同法），**含未跟踪 WIP**，这是「当前真实状态」口径。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 口径回归用例 | `scripts/code-stats.test.mts` 15/15 绿（vitest node-shared，CI 收编） |
| 总量独立对账 | `wc -l` 管线（同文件集）328,238 vs 脚本三段之和 328,136+（差额=4 个 `.d.ts` 有意排除 + 末行无换行计数口径 + 并行会话提交造成的树漂移） |
| 行分类完备性 | 三类（代码/注释/空行）互斥且完备，单测断言 code+comment+blank === 物理行数 |
| 内联拆分正确性 | 门控属性行计入测试区域、区域收在 mod 的 `}`、raw string/嵌套注释不干扰、跨行字符串不丢行——均有专有用例 |
| 实跑输出 | 见下「证据」 |

## 测试处置

无修改/删除既有测试；新增 `scripts/code-stats.test.mts`（vitest 自动收编 `scripts/*.test.mts`，node-shared 组）。

## 证据

- commit：脚本与 skill（本记录提交前的独立提交）、记录（本提交）。
- 测试：`bunx vitest run scripts/code-stats.test.mts` → **15 passed (15)**，exit 0。
- 实跑（`Ru5t/Reflector@c1542c29` 工作树；并行施工中，数字随后续提交自然漂移）：
  - 生产 933 文件 / **177,832 物理行**（代码 147,413）：TS 75,276 · TSX 29,974 · Rust 63,063 · CSS 9,498；
  - 测试 **125,988 物理行**（代码 108,049）：TS 测试文件 622 个 · Rust 内联 122 文件/189 区域 · Rust 测试专属文件 21 · 集成测试 8；测试/生产代码行比 **0.73 : 1**；
  - 测试用例计数：Rust `#[test]`/`#[tokio::test]` 1,466 · TS `it()/test()` 3,918；
  - 排除面存照：tools 10,100 · scripts 8,606 · vendor 2,290 · SDK 1,574 · examples 663 · 根配置 535 · markdown 工具 306 · 根散置 266。

## 与 spec 的偏差

本轮未落独立 spec（`.agents/spec/` 为一次性不入库文档，issue 正文即规格）；实现与 issue 验收建议逐条对应，无偏差。

## 未解问题

- `debug_assertions` 谓词按「生产侧成立」处理（DEV 触发器如 `src/obs04` 计入生产）——这是口径选择而非疏漏，skill 已写明；若未来想区分 dev/release 双口径，需扩展求值器为双值。
- 正则字面量判定用「前一显著 token」启发式，极端写法（如 `if (x) /re/.test(y)`）可能误判，只影响注释/代码分类的个位数行，不影响生产/测试拆分。

## 并行交集

仅新增文件（两个 scripts、一个 skill 目录、本记录）+ `.agents/L.md` 追加；未触碰任何他人在途文件域。统计为只读扫描。
