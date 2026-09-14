# Dev Record — #85 webview2-mcp 审核修复 + 网页界面工具增强

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> spec 路径（一次性）：`.agents/spec/85-webview2-mcp-audit-followup.md`

## 元信息

- issue：[#85](https://github.com/AlchemistCxC/Pylon-co-works/issues/85)（后续跟进，不新开 issue）
- 分支：`Ru5t/Reflector`
- 提交范围：`d47b6e69..HEAD`
- 日期：2026-09-15
- 署名：亥姆霍兹

## 目标与范围

**要达成什么**：用户要求「按照开发规范落实所有可优化项，并且我要求增强该mcp的网页界面」。
拆为两件事：

1. 落实 2026-09-15 对 `tools/webview2-mcp` 的审核发现：P2 死会话复用、
   P3 `wait_for_ready` 竞态、P4 各瑕疵。
2. 「增强网页界面」= 增强该 MCP **驱动网页 UI 的工具集**（服务器本身是 stdio
   进程，没有自己的网页；结合审核语境，页面级交互工具是唯一的「网页界面」面）。

审核反馈与施工计划已按 AGENTS §2.2 补充到 issue #85 评论区。

**不做什么**：

- 不碰 `src-tauri/`、`src/`、`package.json`、`check:*` 门禁脚本——`tools/` 是否纳入
  CI 仍归仓库主裁决（前一条开发记录的未解问题 #4 维持原状）。
- 不给服务器加任何监听端口/HTTP 面板。
- 不改既有工具的 wire 契约字段（只增不删：`reconnected`、`reconnectNote`、
  `pointHit` 均为新增字段）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `tools/webview2-mcp/src/cdp/mod.rs` | `SessionOrigin` 枚举；`session()` 死 entry 原位替换；`call`/`call_with_timeout`/`evaluate` 适配；`read_events`/`reset_events` 带回会话来源；`reconnect` 测试模块（双端口假 DevTools） | 修改 |
| `tools/webview2-mcp/src/cdp/session.rs` | 无功能改动（`evaluate` 的 CDP `timeout` 参数经官方 protocol JSON 核实存在，注释成立） | 未改 |
| `tools/webview2-mcp/src/tools/page.rs` | `console`/`network` 返回体加 `reconnected`+`reconnectNote`；`wait_for_ready` 两阶段判定；`navigate` 返回体加 `settleNote`；`key_spec` 标点表；`dispatch_key` 去掉 `with_events` 死参数；`click` 坐标模式加 `point_hit`；新增 `hover`/`scroll`/`select`/`wait` 四个处理器 | 修改 |
| `tools/webview2-mcp/src/tools/host.rs` | `backend_logs` 提示文案 typo（`#[[tauri::command]]`→`#[tauri::command]`）；`walk()` 不跟符号链接、加深度上限与文件数预算（`ScanBudget`） | 修改 |
| `tools/webview2-mcp/src/jsscript.rs` | `resolve_click_target`→`resolve_pointer_target` 改名（click/hover 共用）；新增 `wait_selector`/`wait_condition`/`wait_href`/`wait_ready`/`point_hit`/`scroll_page`/`select_options` | 修改 |
| `tools/webview2-mcp/src/args.rs` | 新增 `u64_list`（裸数字与数组两可，与 `str_list` 对称） | 修改 |
| `tools/webview2-mcp/src/tools/mod.rs` | 分发表 +4；类型 DSL 增 `integer_or_array`；工具目录 +4（18→22）；数量断言同步 | 修改 |
| `tools/webview2-mcp/src/mcp.rs` | `INSTRUCTIONS` 排障顺序补 hover/select/wait/scroll | 修改 |
| `tools/webview2-mcp/scripts/stdio-smoke.py` | `EXPECTED_TOOLS` +4、数量断言 18→22 | 修改 |
| `tools/webview2-mcp/README.md` | 工具数 22、页面级工具表 +4 行、读增量小节补「断线恢复对读类工具同样生效」、故障排查 target_gone 行更新 | 修改 |
| `.agents/records/85-webview2-mcp-audit-followup.md` | 本记录 | 新增 |

## 方案要点

1. **死会话原位替换（P2 的核心）。** `Cdp::session()` 拿到新连接后检查 entry：
   还活着（并发对手先插的）就沿用对手的；是死的就 `*stored = 新会话` 并返回
   `SessionOrigin::Reconnected`。这样三类调用路径全部闭环：
   - call 系（raw_cdp/screenshot）：原本就有 ATTEMPTS=2 重试，不变；
   - evaluate 系：调用前断开的情形现在在 `session()` 内部就被换新——表达式本来
     就没跑过，直接在新会话上执行，**不需要** agent 手动重试；「执行中途断开不重放」
     的语义原样保留（那才是防重复副作用的边界）；
   - 读系（console/network）：原先根本不碰 socket、永远拿死会话读空增量，现在
     自动重连，返回体 `reconnected: true` + `reconnectNote` 明说「缓冲属于旧会话，
     从新会话零点开始」——缺口不再伪装成「页面很安静」。

2. **`wait_for_ready` 两阶段（P3）。** `Page.navigate` 返回得比导航提交更早，
   旧文档的 complete 会被首轮轮询读到。现在先等「导航证据」（href 变化 /
   readyState 离开 complete / evaluate 报错），再等 complete；同址导航在 250ms
   宽限后放行，避免死等。`navigate` 返回体加 `settleNote` 说明判定依据。

3. **标点键走 OEM 表（P4）。** `.` 的 ASCII 46 恰好是 VK_DELETE——这一段
   （186-192、219-222）必须查表而不是按 ASCII 推导，`code` 也换成标准
   KeyboardEvent.code 名（`Period`/`BracketLeft`/…）。

4. **`walk()` 预算化（P4）。** `DirEntry::file_type` 不跟随符号链接 → junction /
   软链目录直接跳过（防环状递归炸栈）；加 48 层深度上限；`MAX_FILES` 从「roots
   之间才检查」改成遍历内即时扣减（`ScanBudget`），病态目录树不再拖死扫描。

5. **网页界面增强：4 个新工具 + 坐标点击命中报告。** 共同原则沿用既有设计：
   - `webview_wait`：四种条件恰好一种（selector/condition/href_contains/ready），
     轮询 + 预算；探针是同步表达式，单次调用超时取预算与 5s 的较小者；条件写错
     （JsException）立即带回异常，导航造成的瞬时失败继续轮询。
   - `webview_hover`：与 click 共用 `resolve_pointer_target`（改名即是这个意图），
     悬停也做命中测试——被遮挡的 hover 和被遮挡的 click 是同一类「点了没反应」。
   - `webview_select`：页内匹配 + 派发 `input`/`change`（受控组件同步），匹配不到
     时带回现有选项列表，省一个 `webview_query` 往返。
   - `webview_scroll`：selector 模式滚容器内部，否则滚窗口；返回三层位置供回读。
   - `webview_click` 坐标模式：点之前先 `elementFromPoint` 报告该坐标上是谁。

6. **核实过的事实**：CDP 官方 protocol JSON（js_protocol.json）确认
   `Runtime.evaluate` **有** `timeout` 参数——session.rs 里「CDP 侧也设一份」的
   注释成立，审核时的怀疑被证据推翻。

## 验收标准与结果

| # | 验收项 | 结果 |
| --- | --- | --- |
| 1 | `cargo test` 全绿 | ✅ 126 passed; 0 failed（原 111 + 新增 15） |
| 2 | `cargo clippy --all-targets -- -D warnings` 退出码 0 | ✅ 0 |
| 3 | `cargo fmt --check` 无 diff | ✅ 0 |
| 4 | `python scripts/stdio-smoke.py` 退出码 0 | ✅ 27 项断言全过，22 工具 |
| 5 | 生产代码 `.unwrap()` / `.expect()` / `panic!` 计数为 0 | ✅ 0 |
| 6 | README 工具数与 `tools/list` 一致 | ✅ 22 = 22 |
| 7 | 只改 `tools/webview2-mcp/**` 与 `.agents/records/**` | ✅ 显式 pathspec 提交 |

## 测试处置

- **新增（15 个）**：
  - `cdp::reconnect`：双端口假 DevTools 端点（HTTP 发现 + WS 会话）驱动
    `Cdp::session`——死会话被替换而非返回（P2 回归）、活会话复用 `Arc::ptr_eq`、
    首次建连是 New；
  - `page`：标点键 OEM 表（`.`≠VK_DELETE）、wait 四条件恰好一种、hidden 依赖
    selector、select 三种匹配恰好一种、hover 坐标二选一、scroll 的 to 值域；
  - `jsscript`：wait/scroll/select/point_hit 片段构造与花括号配平（balance 守卫
    名单扩到 22 个脚本）、wait_condition 行注释后的闭合；
  - `args`：`u64_list` 裸数字/数组/越界负数。
- **修改（3 个）**：`TOOLS.len()` 断言 18→22；`array_specs_declare_their_item_type`
  加 `integer_or_array`；smoke `EXPECTED_TOOLS`/数量断言。
- **改名牵连（1 个）**：`click_target_selector_is_escaped_not_interpolated` 改用
  `resolve_pointer_target`。
- 删除：无。

## 证据

- commit：见提交范围（本次与记录同 commit）
- 测试：
  - `cargo test` → `test result: ok. 126 passed; 0 failed`，退出码 0
  - `cargo clippy --all-targets -- -D warnings` → 退出码 0
  - `cargo fmt --check` → 无输出
  - `python scripts/stdio-smoke.py` → `全部通过。`，退出码 0
- 手工核查：重连回归测试用进程内假端点真实走完「建连 → 断线（EOF）→ 重连替换」
  全链路；生产代码 panic 计数用脚本按 `#[cfg(test)]` 切分后统计。

## 与 spec 的偏差

无功能性偏差。一处测试方案调整：spec 计划的「死会话替换语义」测试原以为需要
完整 HTTP+WS 同端口复用，实施时改为双端口（`webSocketDebuggerUrl` 指向独立 WS
listener）——`Session::connect` 本就原样信任该 url，且避免手写 SHA-1 握手。

## 未解问题

1. `tools/` 是否纳入 CI 门禁——维持仓库主裁决，未动 `check:*` 脚本。
2. 与真实 WebView2 的端到端验证（新增的四个工具与旧工具同走一条 CDP 通道），
   仍受 README「验证边界」约束，需真机自检。

## 并行交集

本次只改 `tools/webview2-mcp/**` 与 `.agents/records/**`，按 L.md 登记的文件域
提交（显式 pathspec），与其他贡献者（#81/#82/#37 及 interface-mode 在途改动）
无交集。工作区中 `src/**` 的未提交改动属于他人，本记录提交时一律不纳入。
