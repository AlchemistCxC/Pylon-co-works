# pylon-webview2-mcp

面向 Pylon（Tauri 2 + Windows WebView2）前端的 MCP 调试服务器。

它让 AI 客户端能直接看进正在运行的 Pylon 窗口：控制台报错、网络请求、DOM 与样式、
截图、真实点击与输入，以及 Tauri 宿主侧的命令、事件与后端日志。

## 为什么这样做

Pylon 是 Tauri 2 应用，Windows 上的渲染层是 WebView2（Edge Chromium）。WebView2 提供两种
调试入口：

| 通路 | 做法 | 取舍 |
| --- | --- | --- |
| 进程内 COM | `webview.with_webview()` 取 `ICoreWebView2Controller`，调 `CallDevToolsProtocolMethod` | 无需端口，但必须在 app 里加代码，且只对 dev 构建有意义 |
| **远程调试端口** | 给 WebView2 加 `--remote-debugging-port=<port>`，它自己暴露标准 CDP 端点 | **零侵入**；独立进程即可驱动；release 的 exe 同样能连 |

本服务器走第二条。因此：

- **不需要**在 `src-tauri/` 里加任何调试代码
- **不需要** Pylon 是 dev 构建
- 调试服务器崩了或没起来，都不影响被调试的 app

代价是需要在 `tauri.conf.json` 里加一行启动参数（见下）——WebView2 只在启动时读取它，
运行中无法开启。

## 接线

### 开箱即用（一次性配置）

把下面这段合并进 `src-tauri/tauri.conf.json`，**重新构建并重启 app** 即可：

```json
{
  "app": {
    "windows": [
      {
        "title": "Prism Desktop",
        "decorations": false,
        "transparent": true,
        "center": true,
        "additionalBrowserArgs": "--remote-debugging-port=9222 --remote-allow-origins=* --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"
      }
    ]
  }
}
```

（只贴 `additionalBrowserArgs` 那一行到已有的窗口对象里即可；上面列全其余字段是为了提醒它们不能被覆盖。）

**必须重启**——这个参数在 WebView2 环境创建时读取，改完不重启不会生效。
验证：调 `webview_targets`，应返回 `reachable: true` 与至少一个 page 目标。

### ⚠️ 这一行等于把窗口完全对外开放

这是「开箱即用」的真实代价，必须明说：

| | |
| --- | --- |
| **谁能连** | 同一台机器上的**任何**进程，不需要管理员权限。端口默认只绑 `127.0.0.1`，所以**不会**暴露到局域网 |
| **能做什么** | 执行任意 JS；读页面内的全部数据（会话内容、localStorage、前端持有的任何令牌）；读全部网络流量；伪造鼠标与键盘输入 |
| **更重要的是** | 配上本服务器的 `tauri_invoke`，可以调用**任意已注册的 Tauri 命令**——攻击面不止页面，还包括后端能力。且受 `capabilities/default.json` 约束的范围内本就很宽：它含 `shell:default`、`dialog:default`、`fs:default` |

因此：

- **带这一行的构建不要对外分发。** 拿到该构建的人，其机器上的任意进程都能无授权地完全控制这个 app。
- 它只适合本地开发与排障。
- 如果 Pylon 会被其他人运行（哪怕只是内测），请用下面的 dev-only 方案，别把这行留在正式配置里。

### 只给 dev 开、release 不开

`tauri dev` 支持用 `-c/--config` 叠加一份覆盖配置（CLI 帮助里明说用于 "different build flavors"）。

`src-tauri/tauri.dev.conf.json`：

```json
{
  "app": {
    "windows": [
      {
        "title": "Prism Desktop",
        "width": 1200,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600,
        "decorations": false,
        "transparent": true,
        "center": true,
        "additionalBrowserArgs": "--remote-debugging-port=9222 --remote-allow-origins=* --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"
      }
    ]
  }
}
```

启动：

```bash
bun run tauri dev --config src-tauri/tauri.dev.conf.json
```

正式的 `tauri build` 不带 `--config`，就完全不带调试端口。

> **为什么覆盖文件里要写全窗口字段：** `app.windows` 是数组，而配置合并对数组的处理
> 究竟是「整体替换」还是「按下标深合并」，在 `tauri-cli`（预编译二进制）里，从本仓库
> 可得的源码中查不到。**写全之后两种行为下结果都正确**，所以这是一个不依赖该细节的写法。
> 代价是窗口字段有了两份，改一处要记得改两处——若你确认了实际的合并行为，可以把它瘦身。
>
> 本仓库工作树当前有其它贡献者未提交的改动，故本次**未实跑验证**这条配方。
> 首次使用时请确认窗口的 `decorations` / `transparent` 没有被覆盖掉。

### 三个不能漏的点

1. **`additionalBrowserArgs` 是整串替换，不是追加。** wry 的默认值是
   `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`
   （见 `wry-0.55.1/src/webview2/mod.rs:297`，`unwrap_or_else` 只在字段为 `None` 时用默认值）。
   漏写这一项就会静默丢掉「去掉 mini menu / SmartScreen」的行为。上面的配方已把默认值写回。

2. **`--remote-allow-origins=*` 建议保留。** Chromium 111+ 起，带 `Origin` 头的 WebSocket
   连 DevTools 端点会被拒。本服务器的 Rust 客户端不发 `Origin`，理论上不需要它；但一旦
   换成网页版 DevTools 或别的工具去连，没有这一项就会连不上。

3. **一个调试端口同时只能被一个 WebView2 进程占用。** 同时跑两个 Pylon 实例时，第二个会
   报端口冲突。需要并行调试就给不同实例配不同端口，并用 `--port` 指给本服务器。

### 一个流传很广、但在 Tauri 下无效的做法

网上常见的建议是用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量来开调试端口，
好处是不用改配置。**在 Tauri 下这条路不通。**

wry 在 `webview2/mod.rs:294` 用 `unwrap_or_else` **总会算出一串非空**的
`additional_browser_args`（无配置时就是那串默认值），并在 `:327` 通过
`options.set_additional_browser_arguments(...)` 显式写进环境选项。
而 WebView2 只在**该选项字段为空**时才去读那个环境变量。所以环境变量会被静默丢弃，
表现为「设了变量但端口没开」，且没有任何报错提示。

只能改配置。改完记得重启。

## 构建与运行

```bash
cd tools/webview2-mcp
cargo build --release          # 产物：target/release/pylon-webview2-mcp
```

MCP 客户端通常不带参数直接拉起它。本地手动调试时可用的参数：

```text
--host <地址>         调试端点地址（默认 127.0.0.1）
--port <端口>        调试端点端口（默认 9222）
--timeout-ms <毫秒>   单次 CDP 调用默认超时（默认 20000）
--cwd <目录>          tauri_event_catalog 扫描源码的根目录（默认当前目录）
-h, --help / -V, --version
```

`--help` / `--version` 先于一切校验：即使别的参数写错，它们也会正常回答。

## 工具

共 22 个。全部接受可选的 `target`（目标 id / id 前缀 / url 或 title 子串）；
只有一个页面目标时可省略。全部接受 `timeout_ms`。

### 页面级（CDP）

| 工具 | 用途 |
| --- | --- |
| `webview_targets` | 列出可附加目标 + 浏览器版本。**排障第一步**，也是「端口通不通」的探针 |
| `webview_evaluate` | 求值 JS 并返回值。默认包成 async IIFE，所以可以直接写 `await`。序列化后超过 64KB 会换成 `__truncated` 信封（带大小与前缀预览），需要完整原始结果时用 `webview_raw_cdp` |
| `webview_raw_cdp` | 直调任意 CDP 方法，返回原始 result。覆盖本服务器未包装的域 |
| `webview_console` | 控制台消息 + 未捕获异常 + 浏览器日志，**默认只读增量**；返回体带 `reconnected`，连接断开重连后缓冲从零开始会明确告知 |
| `webview_network` | 网络请求日志；同一 requestId 的四个事件合并成一条记录，同样带 `reconnected` |
| `webview_network_body` | 按 requestId 取响应体；base64 会解码后再判断是否为文本 |
| `webview_dom` | DOM 结构轮廓（标签/id/class/属性，可选盒模型与文本） |
| `webview_query` | 单元素详查：盒模型、计算样式、可见性、祖先链、滚动尺寸 |
| `webview_screenshot` | 截图，返回图片内容。支持整页与裁剪 |
| `webview_click` | 真实鼠标事件点击，**附带命中测试结果**（见下）；坐标模式同样先报告该点落在了谁身上。`click_count: 2` 会派发两对 press/release，真的触发 `dblclick`；上限 3 |
| `webview_type` | 输入文本；`insert`（默认）或 `keys` 逐字符真实按键 |
| `webview_key` | 派发命名按键（Enter / Tab / Escape / Arrow\* / F1-F12 / 常用标点等）或单个 ASCII 字符；`modifiers` 组合出 Ctrl+A、Shift+Tab 这类快捷键。无法派发的按键名直接报错，不会发出空键码 |
| `webview_hover` | 悬停元素或坐标（触发 hover 菜单 / tooltip），附带与 click 相同的命中测试 |
| `webview_scroll` | 滚动窗口或容器（滚进视口 / top / bottom / 绝对 / 相对），返回滚动后位置 |
| `webview_select` | 选中 `<select>` 选项（value / label / 下标），派发 input + change 让受控组件同步 |
| `webview_wait` | 动作之间的同步原语：等元素出现/消失、等 JS 条件、等 URL、等文档就绪 |
| `webview_navigate` | goto / reload / back / forward；就绪判定要求「先见到导航证据，再等 readyState=complete」，旧文档的 complete 不会被误当成新页就绪 |

### Tauri 宿主侧

| 工具 | 用途 |
| --- | --- |
| `tauri_invoke` | 调用任意已注册的 Tauri 命令（等价于页面里的 `__TAURI_INTERNALS__.invoke`） |
| `tauri_events` | 订阅并读取事件增量 |
| `tauri_event_catalog` | 静态扫描源码，列出 emit / listen 调用点上的事件名 |
| `tauri_window_state` | 窗口状态：宿主侧（装饰/可见性/最大化/缩放/显示器）+ DOM 侧 |
| `tauri_backend_logs` | 读后端日志（调 Pylon 的 `list_runtime_logs`） |

### 几条设计上的关键选择

**目标发现走 1 秒 TTL 缓存。** 一次工具调用内部会反复解析目标：点击 = 命中测试 +
三连 `Input.dispatchMouseEvent`，`webview_type` 的 keys 模式 = 每字符两次按键，
`webview_wait` = 每个轮询一次——每次解析都是一趟 `GET /json`。TTL 之内直接复用，
省掉这些重复发现。它在两个方向上都不会骗人：`webview_targets` 永远绕过缓存直读
（它是「端口通不通」的探针），而解析失败时 `resolve` 会强制刷新复核一次，
不会把「缓存过时」说成「目标不存在」。

**读增量，不是全量。** `webview_console` / `webview_network` / `tauri_events` 有共同的游标语义：

- 省略 `since_seq` → 从「上次读到的位置」继续，并把游标推进到本次扫描末尾
- 显式传 `since_seq` → 从该处重读，**不推进游标**（无副作用重读）

于是排障主循环是「先做动作，再读增量」，而不是反复全量拉。
`limit` 和 `scan` 是两个独立上限：`limit` 限制**返回**多少条，`scan` 限制**检视**多少条。
分开的理由是「最近 50 条 error」不该因为中间夹了上千条 info 就搜不到；
返回里的 `scanned` 与 `buffer.evicted` 用来判断窗口是否够大、有没有缺口。

**断线恢复对读类工具同样生效。** 连接断开后，`webview_console` / `webview_network`
的下一次调用会自动重连——而不是拿着死会话的空缓冲永远读出空增量。
代价是事件缓冲属于旧会话、无法带回：返回体里的 `reconnected: true` 与
`reconnectNote` 会明确说明这一点，不会让缺口伪装成「页面很安静」。

**点击会做命中测试。** `webview_click` 返回 `hitIsSelfOrDescendant`：
为 `false` 说明该坐标上实际落的是别的元素，即目标被遮挡——这正是「点了没反应」最常见的成因，
而 `element.click()` 永远查不出来。需要绕过时用 `mode: "dom"`。

## 已知限制

这些是设计边界，不是待修的 bug。写在这里是为了避免误判现象。

1. **事件订阅必须显式列出事件名，无法全量旁路捕获。**
   Tauri 用 `Object.defineProperty(window.__TAURI_INTERNALS__, 'invoke', { value: ... })`
   定义 invoke（`tauri-2.11.5/scripts/core.js:81`），描述符没有 `writable` 也没有
   `configurable`，因此**无法包装它**来旁路记录 `plugin:event|emit`。
   所以 `tauri_events` 走「`transformCallback` + `plugin:event|listen` + 页内环形缓冲」，
   事件名由 `tauri_event_catalog` 从源码静态扫出。用变量或模板字符串构造的事件名扫不到，
   该工具返回里的 `dynamicSites` 会给出这类位置的数量。

2. **`tauri_event_catalog` 是静态扫描。** 只扫描传入的 `roots`（默认 `src` 与
   `src-tauri/src`），跳过 `node_modules` / `target` / `dist` 等目录。插件目录或生成代码
   需另外传 `roots`。扫描有预算：最多 2 万个文件、总计 128MB，任一用尽即停——
   返回里的 `truncated: true` 会明说清单不完整，不会假装扫全了。

3. **DOM 走自序列化而不是 `DOM.*` 域。** `DOM.getDocument` 的 nodeId 会被任何 DOM 变更作废，
   拿着旧 id 调用只会收到 "Could not find node"。自序列化一次性拿到全部且无句柄失效问题。
   需要 `DOM.*` / `CSS.*` / `Emulation.*` 时用 `webview_raw_cdp`。

4. **整页截图在部分 WebView2 版本上不支持。** `captureBeyondViewport` 失败时会自动退回视口
   截图，并在返回的说明里写清——不会整次失败，但也不会假装截到了整页。

5. **`reload` / `goto` 会清空页内注入状态。** 事件订阅与页内缓冲随之消失，游标归零。
   这是预期行为。`tauri_events` 下次调用会自动重新订阅（订阅是幂等的），但 reload
   期间的事件无法补回。

6. **`webview_evaluate` 撞上永不 settle 的 Promise 会超时。** CDP 侧可能仍在执行。
   这类场景请先取句柄再轮询结果，而不是直接 await。

7. **`tauri_window_state` 的宿主侧命令可能被拒。** Pylon 的 `capabilities/default.json`
   含 `core:window:default`，它已覆盖全部只读窗口命令（`is_decorated` / `is_visible` /
   `is_maximized` / `scale_factor` / `available_monitors` 等，见 tauri-2.11.5 的
   `permissions/window/autogenerated/reference.md`）。若仍有个别命令失败，会在
   `tauriHostErrors` 里逐条列出，而不是让整张状态表失败。

8. **不提供宿主侧日志文件读取。** `tauri_backend_logs` 走 Pylon 自己的 `list_runtime_logs`
   命令，读的是 `RuntimeLogHub` 的环形缓冲——好处是它与前端 RuntimeSheet 同源，能把
   「后端报了什么」和「界面显示了什么」对齐；代价是容量有限，历史条目会被覆盖
   （返回里有说明）。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `debug_endpoint_unreachable` | 端点连不上。确认 app 在跑、`additionalBrowserArgs` 已加、**改完重启过**。`webview_targets` 会返回完整的开启步骤 |
| 设了 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 但端口没开 | 该环境变量在 Tauri 下无效（wry 总会显式写死环境选项，WebView2 就不读它了）。只能改配置，见「一个流传很广、但在 Tauri 下无效的做法」 |
| 用 `--config` 覆盖后窗口样式变了 | 配置合并对数组的处理未经验证。确认 `tauri.dev.conf.json` 里写全了 `decorations` / `transparent` 等字段 |
| `no_targets` | 端口通了但没有可附加页面。窗口可能还没创建，稍后重试 |
| `ambiguous_target` | 有多个页面目标。用返回列表里的 id 作为 `target` 参数 |
| 端口冲突 / 连上的是别的 app | 一个调试端口只能被一个 WebView2 进程占用。给不同实例配不同端口并用 `--port` 指定 |
| `webview_console` 一直为空 | 事件域没打开。查看服务器 stderr——`Runtime.enable` 等失败会逐条打印原因 |
| 工具报 `target_gone` | 页面 reload 或 app 重启导致连接断开。`webview_console` / `webview_network` 的下次调用会自动重连（返回体 `reconnected: true` 会标明缓冲从零开始）；其它工具直接重试即可 |
| 点了没反应 | 看 `webview_click` 返回的 `hitIsSelfOrDescendant`；为 false 即被遮挡 |

服务器所有诊断输出都走 **stderr**。stdout 只承载 JSON-RPC 报文——往 stdout 混一个字符，
客户端就会在解析层炸掉，而错误现场看起来跟本服务器毫无关系。

## 验证

```bash
cd tools/webview2-mcp
cargo test                              # 单元测试
cargo clippy --all-targets -- -D warnings
cargo fmt --check
python scripts/stdio-smoke.py           # 端到端 stdio 冒烟（不需要 app 在跑）
```

`scripts/stdio-smoke.py` 拉起真实进程、喂真实 MCP 报文，验证分行帧、id 关联、通知不回包、
错误码、工具目录形状，以及「app 没起来时的可操作错误」这条路径。

### 验证边界（未覆盖的部分）

以上自动化验证**不包含**与真实 WebView2 的 CDP 交互。要覆盖那条链路，需要一台装了
WebView2 的 Windows 机器、带调试端口启动的 Pylon，以及一次实际调用。截至目前，
`webview_*` / `tauri_*` 与真实页面的行为**尚未经过端到端实测**：协议层、参数处理、
事件归一化与游标语义有单元测试，但「CDP 方法在当前 WebView2 版本上是否都可用」只能在
真机上确认。首次接入时建议按下面的顺序自检：

1. `webview_targets` → 应看到 `reachable: true` 与至少一个 page 目标
2. `webview_evaluate`，表达式 `1 + 1` → 应返回 `2`
3. `webview_evaluate`，表达式 `typeof window.__TAURI_INTERNALS__.invoke` → 应是 `"function"`
4. `tauri_window_state` → `tauriHostAvailable` 应为 true，`tauriHostErrors` 应为空
5. `tauri_invoke`，命令 `list_runtime_logs`，参数 `{"query":{"limit":5}}` → 应返回日志数组
6. `webview_screenshot` → 应返回一张能看懂的图

第 3 步是分水岭：它同时证明「CDP 通道可用」与「Tauri 内部桥未改语义」。
