# Dev Record — #85 webview2-mcp 深化：WS 采集 / 心跳 / 自动重订阅 / 无障碍快照

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> 本次无 spec：仓库主在原优化完成后追加要求「剩下那六项也写了」。

## 元信息

- issue：[#85](https://github.com/AlchemistCxC/Pylon-co-works/issues/85)（后续跟进，不新开 issue）
- 分支：`Ru5t/issue-106-test-harness`（共享工作树）
- 提交范围：`567acecf..HEAD`（`5d1562b4` / `c64d0a75` / `4d4992a3`）
- 日期：2026-09-17
- 署名：Brahe

## 目标与范围

**要达成什么**：把上一条记录里「评估后列为后续」的六项全部做掉：

1. `Network.webSocket*` 帧采集
2. `*ExtraInfo` 事件（CORS 真实状态）
3. WebSocket 心跳探测半开连接
4. reload 后订阅自动重建
5. 无障碍快照 + ref 定位（六项里最大的一件）
6. 多实例端口扫描

**不做什么**：

- 不碰 `src-tauri/`、`src/`、门禁脚本。
- 不加监听端口；`scan_ports` 默认关（调试端口是「连上即可控制」的能力，
  主动去连别的端口不该是默认行为）。
- 快照只做**简化角色表**（常见标签 + 显式 `role=`），不实现完整 ARIA 隐含角色推导，
  也不接 `Accessibility.getFullAXTree`（那会把 DOM 域与 backendNodeId 的脆弱性引进来）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `tools/webview2-mcp/src/cdp/events.rs` | `Kind::WebSocket`（独立容量 2000）+ 7 类 WS 事件归一化 + `ws_urls` 记忆表；`*ExtraInfo` 两个事件并入 network 记录；`network_replace` 带回 `CARRIED_ON_REPLACE`；`capacity_of`/`opcode_name` | 修改 |
| `tools/webview2-mcp/src/cdp/session.rs` | 心跳 task（15s ping / 10s pong 时限）+ `keepalive_verdict` 纯函数 + pong 记账；`reload_subscription` 记账字段与访问器 | 修改 |
| `tools/webview2-mcp/src/jsscript.rs` | `events_subscribe_body` 抽出共用；`events_subscribe_on_new_document`（等 `__TAURI_INTERNALS__` 再订阅）；`aria_snapshot`；`dom_click`；`resolve_pointer_target` / `focus_for_typing` / `select_options` 支持 ref | 修改 |
| `tools/webview2-mcp/src/tools/page.rs` | 新 handler：`websocket`、`snapshot`、`scan_sibling_ports`；click/hover/type/key/select 的 ref 与互斥校验 | 修改 |
| `tools/webview2-mcp/src/tools/host.rs` | `ensure_reload_subscription`（注册/更新/撤销新文档注入）+ `reloadSubscription` 返回字段 | 修改 |
| `tools/webview2-mcp/src/tools/mod.rs` | 工具表 +2（22→24）；`ref` 参数进 click/hover/type/key/select；`scan_ports`；`READ_ONLY_TOOLS` 12→13；数量断言 | 修改 |
| `tools/webview2-mcp/src/mcp.rs` | `INSTRUCTIONS` 排障顺序补 snapshot / websocket，重排名次 | 修改 |
| `tools/webview2-mcp/scripts/stdio-smoke.py` | `EXPECTED_TOOLS` +2、数量 22→24 | 修改 |
| `tools/webview2-mcp/README.md` | 工具表 +2 行与 5 行改写；设计选择增「用 ref 定位」；已知限制 5 改写；故障排查 +2 行；验证清单 +1 步 | 修改 |
| `.agents/records/85-webview2-mcp-deepening.md` | 本记录 | 新增 |

## 方案要点

1. **WS 帧是流水，不能压成一条。** `webview_network` 按 requestId 合并（看握手足够），
   帧则**一条一记录**并保持次序；帧事件本身不带 url，用 `requestId → url` 记忆表补上，
   让每条帧自解释（连接关闭时从表里移除；表有容量上限，超出整体清空）。
   opcode 归一成名字（text/binary/close/…），载荷截断 512 字符但**保留原文长度**。
2. **ExtraInfo 另存而非覆盖。** `requestWillBeSentExtraInfo` / `responseReceivedExtraInfo`
   是「线上实际发生」的那一份（Cookie、网络栈补的头部、被 CORS/私有网络策略拦下时
   `responseReceived` 根本不触发、只有它有真实状态码）。存成 `rawRequestHeaders` /
   `rawResponseHeaders` / `extraStatus` 等，让「页面看到的」与「线上发生的」可对照。
   实测顺序不保证，所以 `requestWillBeSent` 的整体替换要带回这些字段
   （`CARRIED_ON_REPLACE`），否则 CORS 现场会被后到的事件抹掉。
3. **心跳必须自适应退让。** 先做实验确认 Chromium DevTools WS 会回 pong（本机
   Edg/153 实测：11 字节 pong）——但**不能**据此假定所有版本都回。因此会话记账
   「是否至少收到过一次 pong」：没见过 pong 时缺 pong 只能判「该端点不支持心跳」
   （停用并说明），只有证明过会回 pong 才允许判「连接已死」。把好会话误杀比不做心跳更糟。
4. **reload 自动重订阅靠新文档注入。** 订阅脚本额外注册成
   `Page.addScriptToEvaluateOnNewDocument`，且注入版**先等 `__TAURI_INTERNALS__`**
   （新文档注入与 Tauri init 的先后没有明文保证，抢跑会静默订阅失败）。
   会话内记账 `(scriptId, 事件名)`：名字集合变化时先撤旧的再注册，避免同一事件被投递两次；
   不支持该方法时如实报 `installed: false`，行为退回原样。两个注入点共用同一份
   `events_subscribe_body`，避免逻辑漂移。
5. **快照给的是文本树，不是 JSON。** 消费者是 agent，`- button "发送" [ref=e3]`
   比嵌套 JSON 省 token 也更好读。名字按 aria-label → aria-labelledby → 关联 label →
   placeholder/alt → 文本取；带 `disabled` / `checked` / `level` / `expanded` / `selected`
   与输入框当前值。ref 存 `window.__PYLON_MCP_REFS__`。
6. **ref 失效要吵，不要猜。** 定位时检查映射命中与 `isConnected`，不命中就带
   「ref 可能来自更早的快照，或页面已重载——请重新 webview_snapshot」返回，
   **不**退化成选择器或就近元素。`selector` 与 `ref` 互斥（select 是「恰好一个」），
   在碰 CDP 之前就报 `bad_args`。
7. **scan_ports 默认关。** 只在显式要求时扫相邻 9 个端口；端点不可达时扫描依然可用
   （那正是最需要它的场景：忘了第二个实例配了哪个端口）。

## 验收标准与结果

| 验收项 | 结果 |
| --- | --- |
| `cargo test` | 通过：156 例（本批新增 4） |
| `cargo clippy --all-targets -- -D warnings` | 通过（零告警） |
| `cargo fmt --check` | 通过 |
| `scripts/stdio-smoke.py` | 全部通过（工具数 24） |
| 六项功能实机可用 | 通过（下方证据） |

## 测试处置

新增 4 例：`events.rs` 4 例（WS 流水/游标/载荷截断、ExtraInfo 并存、晚到的
`requestWillBeSent` 不抹掉 extra 字段）、`session.rs` 1 例（心跳判定四态）、
`jsscript.rs` 3 例（新文档注入变体、快照脚本、ref 查找与 stale 提示、dom_click/select 的 ref）、
`page.rs` 3 例（WS 过滤与参数校验、定位参数互斥）。既有测试按新签名调整调用点，
未删除任何测试。

## 证据

- commit：`5d1562b4`（WS + ExtraInfo）、`c64d0a75`（心跳 + 自动重订阅）、
  `4d4992a3`（快照 + ref + scan_ports）
- 测试：`cargo test` → `156 passed; 0 failed`；clippy / fmt -D warnings 均干净；
  `python scripts/stdio-smoke.py target/debug/pylon-webview2-mcp` → 全部通过
- 手工验证（对本机正在运行的 Pylon，Edg/153.0.4234.32；一次性脚本，未入库）：
  - `webview_targets {scan_ports: true}` → `reachable: true`、`siblingPorts: []`（无第二实例）；
  - `webview_snapshot` → 29 个节点，角色/中文可访问名/状态齐全，例如
    `- button "收起左栏" [ref=e2]`、`- tab "Hermes\Riccati" selected=true [ref=e5]`、
    `- button "显示所有 Sheet" expanded=false [ref=e6]`；
  - `webview_hover {ref: "e2"}` → `resolution.resolvedVia: "ref"`、`found: true`、
    `hitIsSelfOrDescendant: true`（ref 定位链路端到端可用；只发 mouseMoved，未点击、未输入）；
  - `webview_hover {ref: "e9999"}` → `isError: false` + 「ref 可能来自更早的一次快照，
    或页面已重载——请重新调用 webview_snapshot」；
  - `webview_hover {selector, ref}` 与 `webview_select {value}` → `bad_args`；
  - 连接心跳：同一服务器进程内空闲 30 秒（两个心跳周期）后再次调用，
    `reconnected: false`，stderr 无异常 —— 心跳没有误判连接已死；
  - 实验记录：裸 WebSocket 客户端对本机 DevTools 端点发 ping，收到 pong（opcode 0xA）。

## 与 spec 的偏差

无 spec。六项全部落地，无删减项。

## 未解问题

1. **写路径（click / type / key）仍未在运行中的 app 上实测**——本批只做了 hover
   （不发点击事件）。原因同上：该实例可能正被其他贡献者用于调试，不宜替他触发操作。
   ref 定位链路与参数校验已覆盖，剩下的风险集中在「事件派发到真实组件」这一步。
2. **WS 采集未在实机上看到流量**：本会话期间页面没有 WS 活动（`buffer: 0`）。
   归一化逻辑由单测覆盖，真实帧的字段形状（opcode/payloadData）按 CDP 规范实现，
   但与真机 WS 的首次碰面仍待确认。
3. 快照的角色表是简化版：不处理 `aria-owns`、`aria-describedby`、`role=presentation`
   的传递语义，也不计算 `aria-labelledby` 的可见性过滤。

## 并行交集

- `tools/webview2-mcp/**`（本次施工域，已提交；后续请勿改写、勿连带提交）。
- `.agents/L.md`：两次施工域声明（第二条含 stash 恢复报备）。
- 邻接流程：`#106` 的 main 合并曾把本目录的未提交改动 stash；恢复方式与
  `stash@{0}` 的处置见上一条记录与本文件所在批次的 L.md 留言。
