# Dev Record — #85 webview2-mcp 热路径优化与行为修复

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 本次无 spec：仓库主直接要求「对自带的 MCP 工具直接动手修复」，并要求不新开 issue。

## 元信息

- issue：[#85](https://github.com/AlchemistCxC/Pylon-co-works/issues/85)（后续跟进，不新开 issue）
- 分支：`Ru5t/issue-106-test-harness`（共享工作树）
- 提交范围：`70ee586a..d2f68996`
- 日期：2026-09-16
- 署名：Brahe

## 目标与范围

**要达成什么**：对 `tools/webview2-mcp`（Pylon 自带调试 MCP）做一轮优化——热路径上的
重复开销、给 LLM 的输出体积失控、以及审查中发现的若干行为缺陷。

**不做什么**：

- 不碰 `src-tauri/`、`src/`、门禁脚本（`tools/` 是否纳入 CI 仍归仓库主裁决，维持上一条记录）。
- 不加监听端口、不引入新的外部依赖。
- 契约只增不删：新增 `modifiers` 参数、`truncated` 字段、`__truncated` 信封、`annotations`；
  唯一的行为删减见方案要点 6（无法派发的按键名从「照发 + 提示」改为报错）。
- 评估后**列为后续、本次不做**：`Network.webSocket*` 帧采集、`*ExtraInfo` 事件、
  reload 后用 `Page.addScriptToEvaluateOnNewDocument` 自动重订阅、accessibility 快照
  （role+name+ref）、WebSocket 心跳探测半开连接、多实例端口段自动发现。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `tools/webview2-mcp/src/cdp/http.rs` | 每请求新建 `reqwest::Client` → `OnceLock` 共享单例；超时从 client 级下移到 `RequestBuilder::timeout` | 修改 |
| `tools/webview2-mcp/src/cdp/mod.rs` | 目标列表 `CachedTargets` + `TARGETS_TTL`（1s）、`targets_cached`/`targets_fresh` 分离；`resolve` 抽出纯函数 `pick_target`，缓存解析失败时强制刷新复核；`session()` 加 `keep_session` 回收死会话；`invalidate` 一并作废目标缓存；测试模块：假 DevTools 加 `/json` 命中计数 + 10 例新测试 | 修改 |
| `tools/webview2-mcp/src/cdp/events.rs` | `read` 不再整缓冲深拷贝：索引排序 + 只 clone 命中条目（`seq_of` 辅助） | 修改 |
| `tools/webview2-mcp/src/tools/page.rs` | `evaluate` 结果 64KB 上限 + `cap_evaluate_output`；`click` 事件序列抽 `click_events`（press/release 对，clickCount 递增）+ 上限 3；console 过滤 `console_type_matches`（比对 `kind`）；`parse_modifiers`/`apply_shift`/`key_down_params`/`key_up_params`，`key_spec` 返回 `Result`；7 例新测试 | 修改 |
| `tools/webview2-mcp/src/tools/host.rs` | `event_catalog` 拆出同步核心 `scan_roots` 并走 `spawn_blocking`；`ScanBudget` 增总字节预算 `MAX_TOTAL_BYTES`（128MB）；结果加 `truncated` 字段与 limitation 行；1 例新测试 | 修改 |
| `tools/webview2-mcp/src/tools/mod.rs` | `webview_key` 增 `modifiers`；`webview_click`/`webview_evaluate` 描述同步；`READ_ONLY_TOOLS` + `annotations.readOnlyHint`；`tauri_event_catalog` 分发改 `await`；2 例新测试 | 修改 |
| `tools/webview2-mcp/README.md` | 工具表 3 行更新；「几条设计上的关键选择」增目标缓存一节；已知限制 2 补扫描预算 | 修改 |
| `.agents/L.md` | 施工域声明 + stash 恢复报备（单独提交 `bc1be9b8`） | 修改 |
| `.agents/records/85-webview2-mcp-perf-and-fixes.md` | 本记录 | 新增 |

## 方案要点

1. **目标发现加 1s TTL 缓存 + 共享 client。** 一次 CDP 调用 = 一次目标解析 = 一趟
   `GET /json`；放大器是「一次工具调用内部连续多次解析」：点击（命中测试 + 三连
   `Input.*`）4 趟、`webview_type` 的 keys 模式每字符 2 趟、`webview_wait` 每轮询 1 趟。
   两道保险保证缓存不骗人：`webview_targets` 走 `targets_fresh()` 永远直读；
   `resolve` 在**缓存命中**且解析失败时强制刷新复核一次（`a_failed_cached_resolve_is_rechecked_against_a_fresh_list`）。
   目标 id 跨导航稳定，只有窗口销毁/重建才会变；那种情况下会话调用会先报 `TargetGone`，
   `invalidate` 顺带作废目标缓存，下一轮解析重新拉取。
2. **读增量只 clone 命中条目。** 原实现对最多 3000 条 `Value` 做深拷贝 + 排序，且发生在
   会话 events 的 Mutex 内（会顶住 reader task 的事件入缓冲）。改为索引排序、按引用过滤、
   命中才 clone（默认 limit 50）。语义不变，原有 15 例 events 测试全绿。
3. **`webview_evaluate` 加 64KB 上限。** 它是唯一没有天然边界的返回值
   （console 有 `FIELD_CLIP`、network_body 有 `max_chars`、dom 有 `max_nodes`），
   而消费者是 LLM 上下文。超限换成 `{__truncated, bytes, limitBytes, preview, note}` 信封；
   需要完整原始结果时用 `webview_raw_cdp`（它保持 raw 语义，不设限）。
4. **双击是真的双击。** Chromium 判定 `dblclick` 靠第二对事件的 `clickCount=2`；
   原实现只发一对（把 clickCount 写成 2），产生不了 dblclick。改为每击一对
   press/release，clickCount 递增，上限 3（更高次数没有浏览器语义）。
5. **`type=exception` 过滤修好。** 文档承诺该取值，但异常记录的 `type` 固定是 `"error"`
   （CDP 语义），按 `type` 比恒为空。改为 `console_type_matches`：先比 `type`，
   再对 `exception` 单独比 `kind`。
6. **按键 modifiers + 拒绝无效按键名。** 新增 `modifiers`（ctrl/alt/shift/meta 别名），
   按住 ctrl/alt/meta 时省略 `text`（否则 Ctrl+A 会先插入一个 a）；Shift+字母改写
   key/text 为大写。无法派发的按键名（`MetaLeft`、`F13`、`中`）从「带 VK=0 照发 + 提示」
   改为 `bad_args`——发一颗无效按键只会让 agent 把「页面没反应」当成应用缺陷。
7. **`tauri_event_catalog` 挪出 reactor。** 同步递归 IO 直接跑在 async 分发里会占住
   reactor 线程（上限 2 万文件）；改 `spawn_blocking`，并补总字节预算（只有文件数上限时，
   2MB × 20000 的最坏情况仍会读 40GB）。用尽时结果里 `truncated: true` 明说清单不完整。
8. **`annotations.readOnlyHint`。** 11 个只读工具标注；界线按「是否改变被调试应用的状态」：
   `tauri_events`（会注册页内订阅）与输入类工具都不标。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `cargo test` | 通过：143 例（新增 17） |
| `cargo clippy --all-targets -- -D warnings` | 通过（零告警） |
| `cargo fmt --check` | 通过 |
| `python scripts/stdio-smoke.py` 端到端 stdio 冒烟 | 全部通过（工具数仍 22） |
| 单次工具调用内的重复 `GET /json` 被消除 | 通过（假 DevTools 命中计数断言：TTL 内 3 次解析 = 1 次 HTTP） |
| 真实 CDP 链路（只读探针） | 通过，见证据 |

## 测试处置

新增 17 例：

- `cdp/mod.rs`：缓存命中/绕过（`repeated_target_lookups_use_the_cache_and_fresh_reads_bypass_it`）、
  TTL 过期重取（`an_expired_cache_entry_is_refetched`）、失败复核
  （`a_failed_cached_resolve_is_rechecked_against_a_fresh_list`）、`pick_target` 4 例、
  `keep_session` 1 例；`FakeDevtools` 增 `/json` 命中计数（`json_hits`）。
- `tools/page.rs`：`click_events`、`console_type_matches`、`cap_evaluate_output` 2 例、
  `parse_modifiers`、Ctrl 抑制 text、Shift 改写字母、无法派发按键名 7 例。
- `tools/host.rs`：`scan_budget` 字节预算 1 例。
- `tools/mod.rs`：`annotations` 1 例、`webview_key` 的 `modifiers` schema 1 例。

修改：`key_spec` 相关 5 例随 `Result` 化调整；`unknown_multi_char_key_is_reported_as_unreliable`、
`non_ascii_single_char_is_...` 合并为 `undispatchable_key_names_are_rejected_instead_of_sent_with_vk_zero`。
未删除任何测试。

## 证据

- commit：`d2f68996`（工具本体）、`bc1be9b8`（L.md 声明）
- 测试：
  - `cargo test` → `143 passed; 0 failed`
  - `cargo clippy --all-targets -- -D warnings` → `Finished`（无告警）
  - `cargo fmt --check` → 无输出
  - `python scripts/stdio-smoke.py target/debug/pylon-webview2-mcp` → 全部通过
- 手工验证（只读探针，脚本为一次性、未入库）：对本机 9222 上**正在运行的 Pylon**（Edg/153.0.4234.32）
  执行 `webview_targets` / `webview_evaluate` / `webview_query` / `webview_console` /
  `webview_network` / `tauri_window_state`，均为只读调用，未点击、未输入、未导航：
  - `webview_targets` → `reachable: true`，2 个 page 目标（`about:blank` 与 Pylon）——
    不带 `target` 时按设计报 `ambiguous_target` 并列出两者，`pick_target` 的歧义分支在真实端点上得到验证；
  - `webview_evaluate` `1 + 1` → `2`；
  - `webview_evaluate` `'x'.repeat(100000)` → `{__truncated: true, bytes: 100002, limitBytes: 65536, preview: 2048 字符}`；
  - `webview_query("body")` → `{found: true, tag: "body", display: "block"}`；
  - `webview_console` → 增量读返回 1 条真实记录（`console error '恢复会话失败 Object'`，cursor=1），
    验证改动后的读路径与真实事件入缓冲；
  - `tauri_window_state` → `tauriHostAvailable: true`、`hostErrorCount: 0`、`label: main`。

## 与 spec 的偏差

无 spec。评估清单中「WS 帧采集」「ExtraInfo 事件」「reload 自动重订阅」「a11y 快照」
「半开连接 ping」「端口段自动发现」六项刻意未做，理由见「不做什么」。

## 未解问题

1. **写路径（click / type / key / hover）未做真实 app 上的端到端实测**——只做了单元测试与
   事件序列断言。原因：本机实例可能正被其他贡献者用于调试，不宜替他制造点击与键入。
   首次实际使用时按 README「验证」一节的顺序自检即可。
2. `network_body` 的响应体可用性仍取决于 CDP 侧缓存（长会话可能取不到），本次未改。
3. `tauri_events` 的页内订阅在 reload 后仍需下一次调用才重建（原行为，未改）。

## 并行交集

- `tools/webview2-mcp/**`（本次施工域，已提交；后续请勿改写、勿连带提交）。
- `.agents/L.md`：追加施工域声明与 stash 报备（单独提交）。
- **#106 的 main 合并曾把我的未提交改动 stash 掉**（`stash@{0}: preserve unrelated webview2
  changes before main merge`）。恢复方式：`git stash show -p stash@{0} | git apply`
  （合并中 `stash apply` 会因 index 里有未合并条目失败）。stash 条目仍留在栈上，
  确认无误后可 drop；**不要再 pop**（会重复应用）。
