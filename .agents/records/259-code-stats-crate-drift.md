# Dev Record — #259 code-stats crate 清单漂移与行分类修复

## 元信息

- issue：#259
- 分支：kumo/prometheus
- 提交范围：`6f9011b0..（本轮）`（含 `7412dcd5` L.md 声明单提交）
- 日期：2026-09-23

## 目标与范围

用户用项目自带统计脚本（#231）得到的数据与仓库现状不符，要求更新。达成两件事：crate 区域清单与 Cargo workspace 成员对齐；修复对账过程中暴露的词法器行数/行类缺陷。

**不做**：不改排除面口径；不动 `pylon-cli.rs`/`pylon-detect.rs` 的生产归类（产品诊断工具）；`src/wasm/` 不处理（git 不跟踪，天然扫不到）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `scripts/code-stats.mts` | `CRATES` → `CRATES_FALLBACK`+`parseWorkspaceCrates`+`loadWorkspaceCrates`；`classifyPath` 增 crate 清单注入参；`areaLabel()` 动态标签；块注释/字符串循环换行守卫；内部行 markComment/markCode | 修改 |
| `scripts/code-stats.test.mts` | 新增「crate 清单随 Cargo workspace」「多行字符串/块注释不丢行」两组用例 | 修改 |
| `.agents/skills/code-stats/SKILL.md` | 口径节补 crate 动态解析与行类型内部行规则 | 修改 |
| `.agents/L.md` | #259 施工声明（在途，合入后撤） | 修改 |

## 方案要点

- crate 清单唯一事实源改为 `src-tauri/Cargo.toml` 的 `[workspace] members`（剔除主包 `.`），解析失败退回静态快照——#247 这类拆 crate 不再需要改脚本。
- 词法器统一换行守卫：`stepInner` 消费换行后直接 `continue`，禁止再 `i++`/`j++`（旧代码在块注释与 `skipRustString` 中吞掉 `\n\n` 的第二个换行，两行并一行，全仓少算 107 物理行）。
- 跨行结构内部行按内容归类：块注释内容行 `markComment`、字符串内容行 `markCode`、内部纯空行仍 blank——修复前内部行一律误计空行，注释行被大幅低估。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| 口径回归用例 | `bunx vitest run scripts/code-stats.test.mts` → 20 passed（新增 5 钉子） |
| 总量独立对账 | 脚本三段和 329,660 = 原始 `cat\|wc -l` 329,657 + 无换行尾文件 3（符合 skill 公式） |
| rs/ts 逐文件行数一致 | 修复前 20 文件差 −86 行；修复后 0 差异 |
| 区域表 | 8 个 crate 各自成行；「Tauri 本体」39,273 → 29,578 生产代码行 |

## 测试处置

全部为新增钉住用例，无删除/改写既有断言：

- `parseWorkspaceCrates` 解析 members/无 members 段两例；
- 注入 crate 清单的 `classifyPath` 落位一例；`CRATES_FALLBACK` 8 成员快照存照一例；
- 多行字符串（`\<LF>` 续行 + 字符串内空行）与块注释（内部空行 blank/内容行 comment）不丢行一例。

## 证据

- 修复前（2026-09-23 早）：区域表仅 6 crate，`pylon-acp`/`pylon-session` 无行；对账差 104~107 行；`tools/webview2-mcp/src/main.rs` 扫描 2059 vs 物理 2087 行。
- 修复后关键数字：生产 147,046 代码行 / 972 文件；测试 109,183 代码行；测试/生产 0.74:1；`crate pylon-acp` 5,783（4.1%）、`crate pylon-session` 4,346（3.0%）。
- 注：并行施工期间工作树持续变化（#257/#258 在途），两次运行数字有 ±数十行浮动属正常。

## 遗留

- 无。后续拆 crate 时无需改脚本；若新增 workspace 成员属非产品性质（如 dev-only crate），需回来给 `parseWorkspaceCrates` 加排除语义。
