---
name: webview2-acceptance
description: 对 Pylon 做「实机运行验收」——把改动装进真实 Tauri/WebView2 进程，读控制台、网络与后端日志，验真实布局与交互，并把结论落成数值证据。用在改完 UI／样式／几何／布局／IPC／内核时序后需要真机复验，或单测与浏览器 mock 证明不了行为、用户反馈「实际跑起来不对」、flake 复现不了时。纯逻辑、纯重命名、纯类型改动不必走这一步。工具清单与错误码速查见 tools/webview2-mcp/README.md。
---

# 实机运行验收（Pylon × WebView2）

单测与浏览器 mock 证明不了真实 Agent IPC、真实布局与真实 WebView2 行为。这个 skill 是把「我以为修好了」变成「数值上确证修好了」。

先按 AGENTS.md §2.4 判断必要性：动了 UI、样式、几何、布局、IPC、内核时序，或缺陷只在实际运行中复现，才值得走；纯逻辑／纯重命名／纯类型改动不必。

## 前置

1. **Pylon 必须带调试端口启动。** WebView2 **只在启动时**读这个参数，运行中开不了——换端口或忘了带都得关掉重开：

   ```powershell
   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222 --remote-allow-origins=*"
   .\pylon.exe
   ```

   自 0.2.1（`4ddff6a0`）起，`src-tauri/tauri.conf.json` 的 `additionalBrowserArgs` 已内置调试端口，所以**本仓本地构建默认就带**——这既是便利也是安全代价：开着端口等于把该窗口的任意 JS 执行能力交给同机任何进程，所以只在调试期运行，用完关掉 Pylon。一个端口只能被一个 WebView2 进程占用，多实例并行要给每个实例换端口号。

2. **前端改动必须重编译 Rust 二进制。** `tauri.conf.json` 的 `frontendDist` 是**编译期内嵌**进 Rust 二进制的：只跑 `bunx vite build` 重建 `dist/`，再启动 `src-tauri/target/debug/pylon.exe`，读到的仍是**旧样式**。#154 有人因此误判过一次「修复无效」。正确顺序是构建前端 → `cargo build` → 重启 App。

## 步骤

1. **连上**：`webview_targets` → `reachable: true` 且至少一个 page 目标。端点不可达时它不报错，而是返回 `reachable: false` 与开启步骤。
   多目标时**必须显式给 `target`**，否则 `ambiguous_target`；id 每次启动都变，别抄旧的。
2. **自检链路**（首次接入或怀疑链路时）：按 `tools/webview2-mcp/README.md` §2.3 的七步走一遍，重点是 `typeof window.__TAURI_INTERNALS__.invoke` 返回 `"function"`——它同时说明 CDP 通道通了、且 Tauri 接口语义没被改坏。
3. **取证**：先做动作，再读增量。`webview_console` / `webview_network` / `webview_websocket` / `tauri_backend_logs` 默认只给「上次读过之后」的增量，不要反复全量拉；需要重读同一段时用 `since_seq`。
4. **验交互**：优先用 `webview_snapshot` 取 `ref` 定位（角色＋可访问名，不随 DOM 结构变），比 CSS 选择器稳；页面 reload 或元素重新渲染后 ref 失效，重新快照即可。`webview_click` 返回的 `hitIsSelfOrDescendant` 为 false 即元素被遮挡——这是「点了没反应」最常见的真因。
5. **结论数值化**：把测得的值写进开发记录——几何用 `getBoundingClientRect` 的数值比对、集合用「恰好 N 个」，并附复现命令。**不要以「截图看起来对了」作为验收证据**：本仓已有多次「目视通过、数值不符」的先例。

## 本仓特有的坑

- **`display:none` 会移动 grid 兄弟。** `.workspace-titlebar` 一类是三列 grid，移除一个 grid item 会让后面的兄弟前移一列（实测菜单 957/997/1037 → 4/44/84）。要「不占空间但保留格位」用 `width:0 + padding:0 + border:0 + visibility:hidden`。
- **宽度 0 挡不住键盘焦点。** `width:0` 只裁像素；子元素自己的 `visibility` 规则还能覆盖父级，于是「不可见」的按钮仍 `focusable`。折叠态要同时处理继承与焦点。
- **别顺手点。** 这些工具会真实改动 app 状态。只在验收需要时操作，不拿正在被人使用的实例当试验场；写路径能到单测与事件序列断言为止就不要到真机。
- **别猜 CDP 方法可用性。** 可用性取决于本机 WebView2 版本；报 `cdp_error` 时用 `webview_raw_cdp` 单独试那个方法。

## 收尾

- 关掉带调试端口的 Pylon。
- 数值结论与复现命令写进 `.agents/records/`。
- 工具语义、24 个工具清单、错误码与故障排查表都在 `tools/webview2-mcp/README.md`，此处不重抄。
