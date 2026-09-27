# Dev Record — #308 浏览器 Sheet 原生空壳窗口（子 WebView 环境参数 + 命令窗口参数收敛）

## 元信息

- issue：[#308](https://github.com/AlchemistCxC/Pylon-co-works/issues/308)（bug）
- 分支：`kumo/prometheus`
- 日期：2026-09-24
- 署名：Kumo
- spec：无（用户实机验收报告驱动，无一次性 spec；证据见文末）

## 目标与范围

修掉用户实机验收报告的第 1 条：**进入 Browser Sheet 后除左栏/标题栏外整块主区失去鼠标与滚轮**，切回 Agent Sheet 也不恢复；Sheet 启动器大部分条目点不动、只能 Esc 退出。

**不做什么**：不重做浏览器 Sheet 的原生层架构（子 WebView 仍挂在主窗口上）；不改 `tauri.conf.json` 的 `additionalBrowserArgs`（调试端口是验收工具链的既有前提）；不动 `tools/webview2-mcp/**`；不动他人文件域（见「并行交集」）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src-tauri/src/browser/mod.rs` | 新增 `host_additional_browser_args`；`open_tab_in` 建子 WebView 时带上宿主窗口的 `additionalBrowserArgs`；注释记录失败模式 | 修改 |
| `src-tauri/src/{lib.rs,lifecycle/mod.rs,session/mod.rs,session/fork.rs,dispatcher/mod.rs}` | 命令与内部函数参数 `tauri::WebviewWindow<R>` → `tauri::Window<R>`（`switch_agent` / `reconnect_agent` / `restart_agent_runtime` / `session_fork` 等），调用点改用 `webview.as_ref().window()` | 修改 |
| `src-tauri/src/{acp/p1_wire_regression_tests.rs,test_harness.rs}` | 契约变更连带：测试侧调用点 `window.as_ref().window()` / mock 窗口助手返回 `Window` | 修改 |

## 方案要点

根因是**两层叠加**，缺一不可：

1. **子 WebView 创建失败（用户可见症状的直接原因）**。`tauri.conf.json` 的 `app.windows[].additionalBrowserArgs`（含 `--remote-debugging-port=9222`）只作用于主窗口的 WebView（`WebviewWindowBuilder::additional_browser_args`）；`window.add_child(...)` 用裸 `WebviewBuilder` 建子 WebView，退回 wry 默认参数。WebView2 只允许**参数完全一致**的环境共享同一个 user data folder，第二环境创建因此失败。而 Tauri 在 `Message::CreateWebview` 里对失败只 `log::error!`（本仓没有 `log`→tracing 桥，等于无声），**仍然返回一个 `Webview` 句柄**；失败前 wry 已建好的 `WRY_WEBVIEW` 宿主窗口就此成为孤儿——它不受 `set_bounds`/`set_visible`/`close` 控制（那些消息因句柄未登记而被静默丢弃），却盖在原生窗口栈顶层吃掉主区输入。
   - 修法：子 WebView 建时带上与宿主主 WebView 相同的 `additionalBrowserArgs`，两条环境参数一致 → WebView2 共享同一环境，创建成功。
   - 为什么不用更「正统」的 `WebviewBuilder::with_environment(host.environment())`：`ICoreWebView2Environment`（windows-core 0.61 `IUnknown(NonNull<c_void>)`）不是 `Send`，而 `WebviewBuilder` 必须 `Send` 才能交给 `Window::add_child` 的主线程闭包——实测 `cargo check` 直接报 `NonNull<c_void> cannot be sent between threads safely`。参数一致是本仓可达的等价手段。

2. **`WebviewWindow` 参数被污染（修好第 1 层后立刻暴露的第二层）**。`tauri::Window::is_webview_window()` 的实现是 `webviews().all(|w| w.label() == self.label())`——主窗口上只要挂着一个 label 不同的子 WebView（我们的 `pylon-browser-*`），它就为假；而 `impl CommandArg for WebviewWindow` 正以这个判据决定成败，于是**所有以 `tauri::WebviewWindow` 为参数的 tauri 命令**都返回 `current webview is not a WebviewWindow`。实机复现：切 Agent 时控制台 `切换 Agent失败 current webview is not a WebviewWindow`（`lifecycle::switch_agent`）。
   - 修法：这些命令/函数参数收敛为 `tauri::Window<R>`。`Emitter::emit` 两个类型实现的是同一默认方法（都走 `manager().emit`），故事件语义等价；窗口/WebView label 相同，监听目标也不变。
   - 也就是说：**#82/#228 引入的子 WebView 浏览器与这些命令签名在设计上互斥**，此前被「子 WebView 从未真正创建成功」掩盖。只修第 1 层会让会话/Agent 切换失败，比修前更糟。

## 验收标准与结果

实机环境：`bun run build` → `cargo build`（debug）→ `target/debug/pylon.exe`，`PYLON_AGENTS_CONFIG=F:\A-I\Platform\Pylon\agents.yaml`，`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 带调试端口；WebView2 153.0.4234.48；窗口客户区 1128x864。取证脚本（Win32 `EnumChildWindows`/`GetWindowRect`/`ChildWindowFromPointEx`）在 `%TEMP%\pylon-*.ps1`。

| 验收项 | 修复前（0.2.9-PAC，PID 22740） | 修复后（本轮构建，PID 10156） |
| --- | --- | --- |
| 子 WebView 是否有 WebView2 控制器子树 | ❌ 宿主 `WRY_WEBVIEW` 下**零子窗口**（主 WebView 有 `Chrome_WidgetWin_0/1` + `RenderWidgetHost`） | ✅ `WRY_WEBVIEW > Chrome_WidgetWin_0 > Chrome_WidgetWin_1 > RenderWidgetHost` 完整 |
| CDP 页面目标数 | 1（只有应用自身） | 2（多出浏览器页 `about:blank`） |
| `browser_navigate` + `browser_snapshot`（eval） | ❌ 5s 超时「页面脚本响应超时」 | ✅ 返回真实页面：`url=https://example.com/`、`title=Example Domain`、正文含 `Learn more` |
| `browser_set_bounds {240,124,888,600}` | ❌ 窗口纹丝不动 | ✅ 宿主窗口 888x740 → 888x600 |
| `browser_set_visible false/true` | ❌ `IsWindowVisible` 恒为 True | ✅ `vis=False` / `vis=True`（样式 0x42000000 ↔ 0x52000000） |
| 子 WebView 矩形 vs DOM `.browser-viewport` | ❌ (240,88) 888x776 vs (240,124) 888x740，**y 偏高 36px＝浏览器标签条高度**，压住工具条 | ✅ 逐像素一致：(240,124) 888x740 |
| 窗口内命中测试（工具条/地址栏） | ❌ 落在子 WebView 宿主上 | ✅ 落在**主** WebView 上（`0x321210`），页面区才落到子 WebView（`0x6910B0`） |
| 切 Sheet（Browser → Agent） | ❌ 子窗口不隐藏；主区继续被吃 | ✅ 子窗口 `vis=False`；再切回 `vis=True` |
| 切 Agent（控制台） | ❌ `切换 Agent失败 current webview is not a WebviewWindow` | ✅ 无该错误，Agent Sheet 正常接管（`Claude Code\Riccati` selected=true） |

命令与门禁：`cargo check` 0 error；`cargo build` 成功；`cargo check --profile test` 0 error；`cargo test --workspace --lib` → **1360 passed / 0 failed**（分 crate：814 / 141 / 9 / 36 / 118 / 69 / 22 / 0 / 151，`ignored` 4）。前端未改动，跑受影响的浏览器 Sheet 用例作回归烟测：`bunx vitest run src/sheets/browser src/workspace-sheets/__tests__/browserKeepAlive.integration.test.tsx` → **7 文件 14 用例全绿**。

**未覆盖/限制（必须知道）**：
- 本改动**没有 Rust 单测**：`host_additional_browser_args` 依赖 `Window::app_handle().config()`（需真实/`tauri::test` 宿主），且失败模式只在真实 WebView2 上显形。判据全部来自上表的实机数值。
- 活动 Browser Sheet 上的 DOM 覆盖层仍被原生页面盖住（Sheet 启动器约 89% 面积点不动）——原生子窗口天然在 DOM 之上，#308 之前是「整块主区」级别、现在收敛为「覆盖层」级别。已另开 #309。

## 测试处置

- 新增：无（理由见上）。
- 修改既有测试：`src-tauri/src/acp/p1_wire_regression_tests.rs`（6 处 `start_notification_dispatcher(..., window.as_ref().window())`）、`src/test_harness.rs`（2 处：dispatcher 调用点与 `do_connect_and_replace` 调用点）、`src/dispatcher/mod.rs` 测试内 1 处、`src/lifecycle/mod.rs` 的 `mock_window()` 助手（返回类型随契约变为 `Window`，body 末尾 `.as_ref().window()`）。**均为参数契约变更的连带修正，无断言/期望值改动**——`cargo test --workspace --lib` 1360 passed / 0 failed 可证。
- 前端未改动：跑浏览器 Sheet 相关 7 个文件 14 个用例作为回归烟测（全绿）。
- `docs/说明书/` 无需同步：`grep` 全量说明书未发现描述「子 WebView 如何嵌入」「命令窗口参数类型」的段落（`add_child` / 子 WebView / WebView2 环境 均无命中）。

## 证据

- issue #308（复盘含完整取证链）、#309（覆盖层残留限制）、#310（用户报告第 2 条的登记与已排除项）。
- 实机复现与验收：见上表；关键中间证据——
  - 修复前失败面：`WRY_WEBVIEW 0x5B0EC8 rect=608,205 888x776 vis=True` 且无子窗口；`browser_set_bounds {10,10,300,200}` 返回 ok 但不移动；`browser_close` 报 `tabs: []` 而窗口仍在（→ 句柄幽灵）。
  - 前端确证已发出隐藏命令：CDP 网络日志 `POST http://ipc.localhost/browser_set_visible {"visible":false}` 200 OK（说明问题不在前端）。
  - 修复后：`WRY_WEBVIEW 0x6910B0 rect=608,241 888x740`（＝客户区 240,124）+ 完整控制器子树；`ChildWindowFromPointEx` 在工具条点位解析到主 WebView `0x321210`。
- 提交：本轮 pathspec 提交（`src-tauri/src/browser/mod.rs` 与五个窗口参数文件 + 本记录）。

## 与 spec 的偏差

无 spec。与「最小改动」的偏差：命令参数由 `WebviewWindow` 收敛为 `Window` 属**必需连带改动**（见方案要点第 2 层），共 6 个文件、12 处签名，非风格偏好。

## 未解问题

1. **活动 Browser Sheet 上 DOM 覆盖层被页面盖住**（#309）：Sheet 启动器等覆盖层需要「打开时临时隐藏原生视图」的机制，涉及「哪些覆盖层算遮挡主区」的产品决策，本轮不裁断。
2. **用户报告第 2 条（FileSheet 发令后无正文）未修复**（#310）：已核实 journal 完好、投影器工具边界用例通过、运行时去重不背锅；剩余怀疑集中在实时投递 owner 匹配与渲染层挂载窗口，需真实 agent 回合现场取证。**本轮不做推测性修复**（AGENTS §4「不猜」）。
3. 修好子 WebView 后，浏览器 Sheet 的**原生层可见性只在「切 Sheet」时同步**：活动态截图/录屏类工具（如 WebView2 的页面捕获）会同时看到两条页面目标，工具链需知道「第二个 page 是浏览器 Sheet」。
4. 本轮为让 `cargo build` 通过腾过一次磁盘：`G:` 曾 100% 满（构建报 `磁盘空间不足 (os error 112)`），已删除可再生的 `src-tauri/target/debug/incremental`（15G）。**磁盘水位仍是本仓构建的隐患**，建议后续纳入例行清理。

## 并行交集

- 本文件与 `.agents/L.md` 声明（`[2026-09-24 23] [Kumo] [#308]`）已按 §2.3-4 单独提交。
- 本轮中段发现共享工作树里有**他人在途改动**：`src-tauri/pylon-foundations/src/workspace.rs`（#287 `is_safe_segment`，23:19 起编辑，期间 `cargo build` 因 `expected String, found &str` 失败约两轮）。按 §2.1 **未 abort、未 stage、未 commit、未改动该文件**；等对方修好后重试构建即通过。本轮所有提交均用 pathspec，未连带该文件。
- 未触碰 `src-tauri/src/browser/agent/**`（#82 域）、`tools/webview2-mcp/**`（#85 域）、`src/renderers/**`。
