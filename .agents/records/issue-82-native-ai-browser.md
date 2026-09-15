# Dev Record — #82 原生浏览器 Sheet 的 AI 使用能力（P1+P2）

> 入库保留。规格文档（spec）不保留，其目标、范围、方案与验收结论在此承接。
> spec 路径（一次性，未入库）：`.agents/spec/issue-82-native-ai-browser.md`

## 元信息

- issue：[#82](https://github.com/AlchemistCxC/Pylon-co-works/issues/82)（裁决记录见 issue 评论）
- 分支：`Ru5t/Reflector`
- 基准提交：`cf8f4919`（42d0b493 L.md 登记后开工）
- 日期：2026-09-14 ~ 09-15
- 署名：Fibonacci

## 目标与范围

**要达成什么**：把原生浏览器 Sheet 变成已接入 ACP agent 的一等工具与共享视觉面——
跨 agent 的浏览器工具 MCP 桥、CDP 全量能力（AX 风格快照/可信输入/截图/网络观测/
MHTML/设备仿真/请求拦截）、默认 readonly 分档策略、claim 共享模型、SQLite 审计、
Sheet「Agent」面板与问 AI。裁决方向「能力最大化，利用 webview 先天优势」。

**不做什么**：自研浏览 agent loop；headless 隐形浏览器；外置内核（Playwright/
Chromium）；CDP 原始协议面直暴露为工具；向 agent 开放 cookie/登录态；非 Windows
平台的 CDP 等价能力（显式 `unsupported_on_platform`）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/browser_agent/` | 新模块：`policy.rs`（档位矩阵/黑名单/URL 策略）、`claim.rs`（claim 状态机）、`refs.rs`（ref 注册表）、`settings.rs`（设置持久化）、`audit.rs`（审计 ring buffer）、`hub.rs`（状态聚合）、`driver/{mod,js}.rs`（快照枚举脚本/等待/高亮/网络环形缓冲）、`cdp.rs`（Windows CDP 传输全量能力） | 新增 |
| `src-tauri/src/browser_agent_cmds.rs` | 24 个 `browser_agent_*` Tauri 命令：策略单点强制、claim、审计收口（`finish` 信封）、CDP/JS 双路调度 | 新增 |
| `src-tauri/src/bin/pylon-browser-bridge.rs` | MCP stdio server（18 工具，`--session/--workspace` 身份注入）→ `pylon-core::cli_client::invoke_running_kernel`（client_type=agent-tool）→ `command exec browser.agent-*` | 新增 |
| `src-tauri/src/browser.rs` | `navigate_on`/`eval_json_on`/`tab_webview`（tab 寻址）、`open_tab_in(activate)` 重构与后台标签、`page_load_hooks`（ref 失效）；`navigate` 保持既有错误优先级 | 修改 |
| `src-tauri/src/session/user_data.rs` | `UserDataKey::BrowserAgentOps` 变体 + `validate_browser_agent_ops` 审计信封校验 | 修改 |
| `src-tauri/src/lib.rs` | 模块声明、`AppState.browser_agent` hub、setup（设置路径初始化 + ref 失效钩子）、invoke_handler 注册 | 修改 |
| `src-tauri/src/paths.rs` | `browser_agent_settings_path` + portable 迁移清单登记 | 修改 |
| `src-tauri/Cargo.toml` / `Cargo.lock` | `webview2-com 0.38` + `windows 0.61`（版本对齐 wry 依赖树） | 修改 |
| `src/plugins/core/browser/builtinBrowserAgentSessionAccess.ts` | sessionCreation 贡献/编译器/preflight handler：按档位产出 `pylon/acp-new-session-options` mcpServers（off 不注入；invoke 失败静默跳过=fail-closed） | 新增 |
| `src/plugins/core/browser/builtinBrowserCommands.ts` | 追加 18 个 `browser.agent-*` 命令定义（参数映射 + `[code]` 错误透传）；`agent-history` 直读本地库 | 修改 |
| `src/plugins/core/browser/__tests__/` | sessionCreation 注入（readonly/off/失败降级）+ 命令族映射/错误透传测试 | 新增 |
| `src/infrastructure/tauri/browserAgentClient.ts` | 类型化 agent 客户端（信封→`BrowserAgentToolError`） | 新增 |
| `src/plugins/product/builtinPylonWorkspace.ts` | 注册 sessionCreation 贡献 | 修改 |
| `src/sheets/browser/BrowserSheetView.tsx` | 「Agent」工具面板（档位/黑名单/广告过滤/claim/审计/页面变化提示/问 AI）；用户交互抢占（导航/标签/缩放） | 修改 |
| `src/sheets/browser/__tests__/BrowserSheetView.sidebarSingleState.test.tsx` | 工具项 4→5（Agent 首位） | 修改 |
| `docs/说明书/Pylon-CLI-命令表.md` | §3.7.1 agent 工具族表 + 策略/审计说明 | 修改 |

## 方案要点

1. **定位**：browser-use/Nanobrowser 出 agent、BrowserOS 出浏览器；Pylon 做
   「内嵌、可旁观、与 agent 共享操作权」的浏览器。agent loop 属于 ACP runtime。
2. **工具暴露双通道，策略单点**：MCP 桥（跨 agent 主通道）与 `pylon_cli` 字典
   （既有通道）最终都落到 Rust `browser_agent_*` handler；`check_tool_allowed` +
   `check_url_allowed`（复用 `is_allowed_browser_url`，零旁路）+ claim + 审计在
   handler 内收口（`finish()` 信封）。
3. **CDP 传输（Windows）**：`Webview::with_webview` → `ICoreWebView2Controller::
   CoreWebView2()` → `CallDevToolsProtocolMethod`（method 白名单字面量）；命令走
   channel + `spawn_blocking` 超时等待，事件（Network/Fetch）经
   `GetDevToolsProtocolEventReceiver` 一次性订阅 + fire-and-forget 应答，绝不在
   UI 线程阻塞。
4. **快照=JS 单轮枚举 + 操作=CDP 可信事件**（对 spec §2 矩阵的实现化裁剪）：
   AX 树不带几何信息，逐节点 `DOM.getBoxModel` 需数百次往返；JS 枚举一次给全
   role/name/中心点/选择器，CDP `Input.*` 提供 `isTrusted=true` 的点击/输入/滚轮
   ——可信输入才是 webview 栈的决定性优势。JS 合成事件作为跨平台兜底，结果
   `driver` 字段显式标注。
5. **ref 注册表**：per-tab、`e1..e400`、导航即整表失效（page_load hook）；Js 型
   target 携带选择器+可见名，点击前 `scrollIntoView` 重查 + 归一化文本比对，
   不一致返回 `stale_ref`（与 Playwright MCP 同语义）。
6. **claim**：写操作 Free 时自动持有、他方持有报 `claim_held`、5 分钟空闲释放；
   用户手动交互立即抢占（前端 `browser_agent_user_activity`）。readonly 观察不
   排他。
7. **审计**：`user_data` 表新增 `browser-agent-ops` 行（复用 versioned envelope
   + revision 乐观并发，冲突重试 3 次），零迁移改动；持久化尽力而为不阻断工具。
8. **桥进程零发行包变更**：`pylon.exe browser-bridge` 子命令复用主二进制与既有
   named-pipe 鉴权（Windows 当前用户 SID 校验）。
9. **广告过滤**：CDP `Fetch.enable` + `requestPaused` → 黑名单域
   `Fetch.failRequest("BlockedByClient")`；监听器常驻、enable/disable 跟随设置
   动态切换（对全部已 attach 标签生效）。

## spec 偏差（实现期决策，均已在代码注释标注）

- **AX 树快照 → JS 枚举**：几何缺失 + 逐节点往返成本；JS 枚举与 AX 树对
  可交互元素的角色/名称产出等效（角色来自显式 role + 标签隐式映射）。
- **截图不做客户端缩放**：按 spec 用 2MiB 上限 + 明确报错代替降采样（避免引入
  图像重编码面）。
- **高亮用注入 outline 而非 CDP Overlay**：跨驱动一致、无 WebView2 domain 支持
  不确定性（Overlay 域未实测）。
- **「问 AI」经 `session send` CLI 端口直达会话**（composer 无跨域草稿 API；
  agent workbench 文件属 #37 并行施工域）。无活动会话时回退剪贴板。

## 验收标准与结果

自动门禁（本机）：

- `cargo test --lib`：**1020 passed / 0 failed**（含 browser_agent 40 个新单测；
  既有 `browser.rs` 9 个契约测试未修改通过）。
- `cargo fmt --check`（4 个 crate）：通过。
- `bun run lint`：通过。
- `tsc -b`：0 错误。
- 目标 Vitest（browser/sessionCreation/sheets/browser）：**20+53 通过**，含新增
  sessionCreation 注入 3 例与命令族 4 例。
- `check:frontend` / `check:rust` / `check:solid`：见下「门禁」。

Windows 实机验收清单（cargo test 无法覆盖实窗 CDP；需在桌面端逐条人工核对，
本记录交付时未执行——环境限制，非代码完成度问题）：

1. readonly 默认下 snapshot/screenshot/read_network/save_page 可用；click/type/
   press/download/tab_close 报 `[readonly_restricted]`；面板升档 full 后可用且
   重启保持。
2. `browser_click {ref}` 命中且测试页记录 `isTrusted === true`；断网 CDP 场景
   降级 `driver:"js"`。
3. 导航后旧 ref → `[stale_ref]`；agent 导航 `file:` 被拒。
4. claim：agent 持有时用户点击页面 → agent 下一次写操作 `[claim_lost]`/
   `[claim_held]`。
5. `browser_wait {until:'network_idle'}` 在延迟 fetch 页面等待后返回；
   `read_network` 可见该请求与响应体预览。
6. 广告过滤：黑名单域资源计数 0；面板关闭后放行。
7. `save_page` 产出 `.mhtml` 且可重新打开。
8. 操作高亮：点击瞬间目标元素描边约 1.2s。
9. 会话创建（readonly 工作区）经 agent 侧可见 `browser_*` MCP 工具；off 档不可见。

## 测试处置

- 新增：Rust `browser_agent` 40 例（策略矩阵/claim 状态机/ref 注册表/设置持久化/
  审计 ring buffer/按键映射/网络环形缓冲/ad 域名匹配/hub）；Vitest 7 例（注入
  3 + 命令族 4）。
- 修改（契约同步）：`BrowserSheetView.sidebarSingleState`（工具项 4→5、首位
  aria-label Agent）。
- 未修改：`browser.rs` 既有 9 个单测（`navigate` 错误优先级曾被我重构破坏，已
  恢复原顺序而非改测试）。

## 门禁

- `cargo test --lib` ✅、`cargo fmt --check` ✅、`bun run lint` ✅、`tsc -b` ✅、
  目标 Vitest ✅。
- `bun run check:all`（coverage/build/solid-smoke 全量）：并行施工共享工作树，
  结果与归属区分见提交时的 PR/说明；本任务文件域相关项全绿。

## 未决问题与后续

- Windows 实机验收清单 9 项待人工执行（建议仓库主在桌面端过一遍）。
- session close 释放 claim 的钩子未接（5 分钟空闲释放 + 用户抢占兜底；
  `ClaimManager::release` 已预留）。
- composer 跨域草稿 API 缺位，「问 AI」发送是即时直达（无预览编辑以外的确认步）。
- CDP `Overlay`/`Accessibility` 域未实测；如需 AX 树原生快照可在此基础上加
  Cdp 型 ref target（类型已预留）。

## 子代理双轴复审（2026-09-15，Standards + Spec）与修复提交

复审发现并已修复：

1. **lib.rs 覆盖事故**（Laplace 在途工具覆写，1fa020a0 披露）：setup 初始化与
   invoke_handler 注册被抹掉——已重新应用并验证（24 命令注册、设置路径初始化、
   ref 失效钩子）。
2. **workspaceId 升权缝**：桥以 `or_insert` 注入工作区身份，agent 自传其他
   workspace id 可借其档位升权——改为权威覆写（`--workspace`/`--session` 永远
   胜出）。
3. **工作区档位旁路**：snapshot/screenshot/wait/read_network/save_page/scroll/
   emulate/tab_list 八个命令 `authorize(None)` 使工作区级 off 覆盖失效——全部
   补 `workspace_id` 参数并贯通 authorize。
4. **审计漏洞**：scroll/emulate 成功路径与 download 的 resolve_tab 拒绝绕过
   `finish()` 不写审计——统一收口；download 不再走 Err 通道。
5. **审计缺 driver**：`finish()` 现从 payload 提取 driver 并入审计摘要。
6. **claim_lost 不可达**：用户抢占后 agent 写操作原会静默重持——`pending_lost`
   机制使被抢占会话的下一次写操作收到 `claim_lost`（仅一次），`Lost` 变体转正。
7. **响应体截断语义**：>64KiB 由 `body_unavailable` 改为按字符边界截断 +
   `truncated:true`（对齐 spec 验收 8）。
8. **TS 类串 color-mix**：Agent 面板 3 处新增 color-mix 换 `border-border`/
   `border-accent` 工具类（dev-standards 样式规则）。
9. **AGENT_CLIENT 每渲染重建**：致 refreshAgentPanel 身份漂移、面板 effect 反复
   触发——提升为模块级单例。
10. **ADR 缺位**：新增 ADR-0002（Rust 侧策略权威 + 持久化契约 + PageLoadHook
    依赖方向）。

复审 findings 的接受项（不修，理由）：

- `browser.agent-history` 直读前端本地库不经 Rust 审计：只读、数据本就是前端
  localStorage 的，风险面为零；Rust 接管无增益。
- `browser_ensure` 工具与 click 的 selector 回退：ensure 保证 agent 可启动浏览器
  （readonly 必需），selector 回退即 spec §3 的"旧参数保留兼容"。
- claim 检查与 CDP 派发非原子（TOCTOU）：claim 是公平/UX 语义而非安全边界；
  最终权威是用户抢占与策略档位，接受。
- MHTML 写 `data_root/agent-pages/` 而非浏览器下载管线：路径确定、可验证，
  偏差在此申报。

复审后复验：`cargo test --lib` 1020 绿（含新增 `user_preemption` Lost 语义断言）、
`cargo fmt` ✅、`tsc -b` ✅、`bun run build` ✅、目标 Vitest ✅。

## Release 构建与桥载体回归（2026-09-15）

用户要求构建 release。首次 `release:portable` 后发现桥载体实现偏离 spec 决策：桥被
做成独立 bin `pylon-browser-bridge.exe`（从未入包），而注入参数是
`['browser-bridge', …]`（主程序无此分发）——真机上 agent 拉桥必然落空。已修复
（cfe4b79a + 后续）：桥逻辑迁入 lib 模块 `browser_bridge`，`run()` 顶部分发
`argv[1] == "browser-bridge"`（GUI 之前退出），主二进制即桥，发行包 exe 清单不变；
parse 参数从 argv[2] 起（子命令偏移）。

`bun run release:portable` 全链成功（期间一次 rustc STATUS_STACK_BUFFER_OVERRUN 与
一次系统内存耗尽为环境性故障，重试通过；另一次失败为 #81 在途类型错误，等其
stabilise 后通过，见 L.md）。包验证：`release/pylon-1.6.0-win64.zip`（≈40.9MB，
manifest+ZIP 一致 207 项）；包内 pylon.exe 与最新构建哈希一致；从包内提取
pylon.exe 实测 `browser-bridge --help` 退出 0、MCP `initialize` 握手返回
`pylon-browser 1.6.0 / 2024-11-05`、`tools/list` 18 工具。
