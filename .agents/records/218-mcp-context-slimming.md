# Dev Record — #218 webview2-mcp 上下文瘦身

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。

## 元信息

- issue：[#218](https://github.com/AlchemistCxC/Pylon-co-works/issues/218)
- 分支：`Ru5t/Reflector`
- 提交范围：`7713b2bd..HEAD`（L.md 声明之后）
- 日期：2026-09-21

## 目标与范围

**要达成什么**：降低 `tools/webview2-mcp` 的每会话固定上下文成本——`tools/list`
目录体积与 `initialize` instructions（用户在四选一裁决中选定「上下文/Token 瘦身」方向）；
顺带修正大结果 pretty-print 的 token 放大。

**不做什么**：

- 不增删工具、不改工具名/参数名/参数语义/默认值/错误码——只动「文字」与「编码」。
- 不碰 `cdp/`、`jsscript.rs`、`args.rs`、`error.rs`、`main.rs`、`src/`、`src-tauri/`、门禁。

## 历史决策的处理（重要）

#85 落地时「描述刻意详细、文本跨工具保持一致」是有意决策，并有测试下限
（工具描述 ≥60 字节、参数说明 ≥5 字节）。本次经用户裁决**瘦身优先**：
下限测试**不放松**（原样保留），verbose 风格让位于体积；被裁掉的「为什么」
与长例子保留在 README 与 #85 开发记录里，不在 wire 上重复。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `tools/webview2-mcp/src/tools/mod.rs` | 24 个工具描述与参数说明瘦身；共享常量（TARGET/TIMEOUT/SINCE/LIMIT/SCAN/RESET_DOC）精简并新增 POINTER_SELECTOR/POINTER_REF 常量；`ToolSpec::build` 空 `required` 不再输出；`pretty()` 阈值化（>4,000 紧凑字符改单行紧凑 JSON）；新增 3 例测试 | 修改 |
| `tools/webview2-mcp/src/mcp.rs` | `INSTRUCTIONS` 收紧（12 步排障骨架保留） | 修改 |
| `tools/webview2-mcp/README.md` | 「通用约定」增「返回体编码随大小切换」一条 | 修改 |
| `.agents/records/218-mcp-context-slimming.md` | 本记录 | 新增 |

## 方案要点

1. **取舍口径**：每条说明只留三类信息——怎么填（类型/格式/默认值）、互斥与边界
   （三选一、上限钳制）、结果怎么判读（错误码、`hitIsSelfOrDescendant`、`reason`）。
   「为什么这样设计」一律不上 wire。
2. **枚举参数不重复 schema**：`phase` / `direction` / `to` 等参数的值列表已在
   `inputSchema.enum` 里，描述只说语义（如「只看某个阶段的记录」），不再抄一遍值。
3. **重复即杠杆**：TARGET_DOC ×22、TIMEOUT_DOC ×14、SINCE/SCAN/RESET/LIMIT ×4，
   共享常量每减 1 字符按出现次数放大；指针三件套（click/hover）与 ref 类说明提为常量。
4. **大结果紧凑编码**：`pretty()` 先紧凑序列化测长，≤4,000 字符 pretty（小结果
   逐行可读），超限输出单行紧凑。原注释「体积代价可以忽略」对 50 条日志级别的
   结果不成立（缩进放大约 1.5-2 倍 token）。错误体走 `ToolResult::error` →
   `error.to_wire()`，天然小于阈值，保持 pretty。
5. **体积回归闸**：新测试断言 `tools/list` JSON ≤16,500 字符，防止后续加工具/
   加长描述无声回胖；超限时先砍描述再考虑放宽闸门。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `tools/list` ≤16,500 字符 | ✅ 21,165 → **16,494**（-22.1%） |
| 描述下限断言不放松 | ✅ `tool_descriptions_explain_rather_than_restate_the_name`（≥60 字节）与 `every_property_gets_both_a_type_and_a_description`（≥5 字节）原样保留并通过 |
| 24 工具名/参数名/required 与基线一致 | ✅ 程序化比对（旧 release exe vs 新构建），逐项全等 |
| 阈值两侧编码行为有单测 | ✅ `small_results_stay_pretty_printed` / `large_results_switch_to_compact_json` |
| `cargo test` 全绿 | ✅ 159 passed / 0 failed（基线 156 + 新增 3） |
| smoke 脚本口径不变 | ✅ `stdio-smoke.py` 全部通过（24 工具名集合一致、描述仍有实质内容） |

## 实测数字（同机同法：stdio 驱动 `initialize`+`tools/list`，紧凑分隔符计字符）

| 指标 | 改动前（Sep 19 release exe） | 改动后 | 降幅 |
| --- | --- | --- | --- |
| `tools/list` 返回体 | 21,165 字符 | 16,494 | **-22.1%** |
| 工具描述合计 | 3,984 | 2,217 | -44.4% |
| 参数描述合计 | 6,693 | 4,023 | -39.9% |
| `instructions` | 1,198 | 888 | -25.9% |
| 会话固定成本（前两项之和） | 22,363 | 17,382 | **-22.3%** |

> 首次测量（python 默认分隔符，含 `", "` 空格）口径为 22,258 字符；两种口径都只用于
> 自比，横向对比统一用紧凑分隔符口径。schema 结构开销（约 10K 字符）未动——那是
> JSON Schema 的固定形状，进一步压缩只能靠删字段或删工具，超出本次裁决范围。

## 测试处置

- 新增：`tools_list_payload_stays_under_the_slimming_budget`（体积闸）、
  `small_results_stay_pretty_printed`、`large_results_switch_to_compact_json`。
- 修改/删除既有测试：**无**（含 `webview_key_declares_the_modifiers_argument`
  在内的内容断言均未触发，新文案保留了被断言的关键词 `ctrl`）。

## 证据

- commit：见本记录所在提交（`git log --oneline` 检索 `#218`）。
- 测试：`cargo test` → `test result: ok. 159 passed; 0 failed`（退出码 0）。
- smoke：`python scripts/stdio-smoke.py target/debug/pylon-webview2-mcp.exe` → 「全部通过」。
- 手工验证：新旧两个 exe 各自 stdio 驱动，名称集合/required 全等断言通过；体积对比表如上。

## 与 spec 的偏差

- spec 目标「≤16,500」最终 16,494，压线达成；为过线多做了 spec 未点名的小修
  （`type`/`condition`/`resource_type`/`props`/`buffer_size` 等十余处 ≤10 字符的微调），
  属同一刀的收尾，无语义变化。
- 实机运行验收（webview2-acceptance skill）未走：本次改动仅涉及静态文字与输出编码，
  单测 + smoke 已覆盖行为面；描述文本对真实 CDP 链路无影响。

## 未解问题

- schema 结构开销（~10K 字符）与 13 个 readOnlyHint 标注（~440 字符）是剩余的固定成本，
  进一步压缩需要删字段/合并工具/改协议用法，属新裁决。
- L.md 的 #218 条目待本 issue 合入后由我移除。

## 并行交集

`tools/webview2-mcp/**`（src 两文件 + README + smoke 脚本域内未动他人文件）、
`.agents/records/218-*.md`。他人文件域零接触。
