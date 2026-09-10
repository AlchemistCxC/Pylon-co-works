# 质量与插件接入评估（2026-09-11）

审查基线：`b6a85696769a61764cfbc5d61d0d33c8c19c93ac`。维护分支：`refactor/quality-plugin-maintenance`。本次提交不合并 main，不改变界面布局、默认模式或协议业务。

## 当前最值得做的工作

最新主线已完成大量 ACP SDK、会话恢复能力注册和工作台事件迁移；相对之前的 `3127ee4` 增加 218 个提交。因此优先收敛稳定模块中的重复实现，避免再建一套协议或事件框架。

|优先级|发现与证据|本轮处理 / 后续验收|
|---|---|---|
|高|PluginScope 在关闭后先创建事件监听器/定时器，随后 `add()` 抛错，资源无法登记和回收|本轮修复，见下方确定性复现|
|高|Rust 的 beforeSend 双轨测试在异步任务内同步阻塞接收，主线 CI 持续到接近六小时取消|本轮改用异步接收、显式超时和任务结果检查；见下方日志证据|
|中|字体、界面模式、显示配置三个注册表复制相同的注册、影子事务、订阅、快照、查找逻辑|本轮收敛到一个内部实现，保留三个业务校验器|
|高|[main CI 34440281962](https://github.com/AlchemistCxC/Pylon-co-works/actions/runs/34440281962)：前端 34 失败文件、16 失败测试，Rust 任务取消|已有 [#38](https://github.com/AlchemistCxC/Pylon-co-works/issues/38)。先修复测试 bootstrap 授权配置和迁移后的契约断言，再恢复可靠的整仓门禁|
|高|CLI 权限应答仍发送 `permission`，见 `src/cli/pylonCliService.ts`|沿用 [#36](https://github.com/AlchemistCxC/Pylon-co-works/issues/36)，与服务端 `approval` 契约一起验收，不靠字符串替换后只测编译|
|中|最新 CI 的 Markdown 用例仍查找字面量 `**passed**`、`**argument**`、`**通过**`、`找到 **2** 项`|结合实际渲染结果检查语义和内容是否保留，再修正断言；不能为了绿灯删除用例或退回不渲染 Markdown|

CI 失败不等同于应用启动失败；整仓失败也不证明本次变更引入了这些缺陷。当前 UI 已由远端另一提交纳入 main，原 UI PR #35 仍是草稿，这一事实不构成本维护分支的合并授权。

## 已实现的维护改动

[ValidatedContributionRegistry](../src/plugin-runtime/registry/validatedContributionRegistry.ts) 统一注册与影子事务的包装。字体、界面模式和显示配置注册表通过构造函数传入原有校验器，公开调用方式不变。通用实现只适用于由校验后值的 `id/order` 决定身份和排序的贡献。

保留的行为包括：注册前校验、冻结与规范化；影子事务继承调用方的 layer/before/after，但使用贡献自身的 id/order；提交前不发布；旧实例的 disposable 不删除替换实例；revert 恢复原贡献对象；其他插件的贡献保持独立。

不把 context-panel/settings 等依赖 owner 的 valueAdapter 强行并入此抽象，它们的校验契约不同。也不把所有插件 API 的资源登记统一为一个同步工具函数：进程释放是异步的，不能吞掉清理失败。

[贡献注册表契约测试](../src/plugin-runtime/registry/__tests__/contributionRegistryContract.test.ts) 的同一组 12 项测试，分别在原始三份实现及共享实现下运行通过。覆盖失败不发布、排序约束、实例所有权、取消登记、提交/回退和注销订阅。原来的业务校验测试继续保留。

## PluginScope 缺陷与复现

触发条件是插件已开始 `dispose()`，包括异步清理尚未完成的阶段。这时插件残留回调再次调用 `scope.listen()`、`scope.setTimeout()` 或 `scope.setInterval()`。

原实现先调用原生资源创建 API，再在 `scope.add()` 检查 `closing`。调用者确实收到“已释放”的错误，但监听器和定时器已经存在；定时器句柄也因抛错无法返回。不是 GC 优化问题，而是卸载后仍可能执行回调的生命周期缺陷。

确定性复现使用真实 EventTarget 与 Vitest 假时钟，在关闭中、已关闭两种状态各运行一次：创建调用都抛错，随后发送一个事件并前进 20ms。旧代码实际得到：

```json
{"listenerCalls":1,"timerCalls":3,"pendingTimers":1}
```

预期及修复后结果：

```json
{"listenerCalls":0,"timerCalls":0,"pendingTimers":0}
```

修复将关闭检查提到资源创建之前，并与 `add()` 共用 `assertOpen()`；AbortController 工厂也遵守同一规则。保留原错误消息、正常资源回收、失败资源重试和逆序释放行为。外部调用者先创建资源再传给 `add()` 的释放责任没有改变。

可复现命令：

```powershell
npx vitest run src/plugin-runtime/__tests__/pluginScope.test.ts
npx vitest run src/plugin-runtime
npm run build
npx eslint src/plugin-runtime/
```

新增回归位于 [pluginScope.test.ts](../src/plugin-runtime/__tests__/pluginScope.test.ts)。原实现 2 失败 / 6 通过；修复后整个 plugin-runtime 59 文件、311 测试通过。生产 TypeScript/Vite 构建和该目录 ESLint 通过。生产源码净减少 52 行（注册表收敛减少 60 行，生命周期修复增加 8 行；测试和文档另计）。

完整前端门禁执行至 coverage 测试后失败：34 失败文件 / 446 通过，16 失败测试 / 2946 通过 / 96 跳过。与上述 main CI 的 40 条唯一 FAIL 摘要逐条比较，去除实际或 gh 转义的 ANSI 后差异为零；新增 14 项回归均通过。此比较仅覆盖已报告失败，不能证明所有路径无缺陷。

额外门禁：`check:solid` 的 TypeScript 与前序架构检查通过，最终运行时边界检查在 `hookBridgeDispatcher.ts` 的未登记 direct invoke 处失败；`check:docs` 因依赖仓库外 `../Docs/Archive/渲染引擎施工/00-唯一入口台账.md` 而失败。这两个被检查文件和门禁脚本相对基线未修改。文档门禁应改为仓库内可复现的文档依赖，不能要求每个全新 clone 都有维护者的旁置目录。新报告自身的本地链接另作检查。

本次不更改 Rust 生产逻辑；Rust 修改仅限下面的测试夹具。本地未重跑原生构建或真实模型端到端验证，远端 Rust 验证以本 PR 的检查结果为准；全仓发布状态仍受既有前端门禁阻塞。

## Rust CI 长时间阻塞的测试夹具

同一基线的 [主线 Rust job](https://github.com/AlchemistCxC/Pylon-co-works/actions/runs/34440281962/job/102753700251) 日志在 2026-09-10 05:23:18 UTC 报告 `session::prompt::tests::before_send_hook_transform_rewrites_wire_but_journal_keeps_original has been running for over 60 seconds`，直到 11:14:42 UTC 才被取消。[本分支首轮 Rust job](https://github.com/AlchemistCxC/Pylon-co-works/actions/runs/34501636818/job/102953587180) 也在 16:31:23 UTC 出现相同提示。确认主线已有相同阻塞且本分支当时没有 Rust 差异后，主动取消了首轮任务以取得完整日志；取消不算通过。

[测试源码](../src-tauri/src/session/prompt.rs) 原先在 `tokio::spawn(async move { ... })` 中调用 `std::sync::mpsc::Receiver::recv()`。`#[tokio::test]` 默认使用 [Tokio 单线程运行时](https://docs.rs/tokio/latest/tokio/attr.test.html)，同步等待会阻塞执行器，使同一运行时中的发送流程无法推进。问题发生在测试夹具，不据此推断生产 Hook 同样死锁。

修复改用 Tokio 异步通道；等待 Hook 请求限定 5 秒，发送流程限定 15 秒，并检查 responder 的 JoinHandle 结果。保留原来对真实 fake-ACP wire 和 journal 的双轨断言：出站是改写后的文本，日志保留用户原文。没有跳过测试、改成多线程掩盖同步阻塞或放宽内容断言。

复核该用例可执行 `cargo test --manifest-path src-tauri/Cargo.toml --lib before_send_hook_transform_rewrites_wire_but_journal_keeps_original -- --exact` 时需要完整模块名；更直接的筛选命令为：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib before_send_hook_transform_rewrites_wire_but_journal_keeps_original
```

CI 保持现有 Rust 测试命令和跳过组不变：`b11_inject_integration_tests`、`obs03_evidence_tests`、`p1_wire_regression_tests`。因此即使 CI 通过，也不能代表这些本地集成组已验证。

## 哪些开放协议适合成为插件

这里同时区分“通信协议”和“开源许可证”：可移植的是协议 SDK 或功能组件，许可证决定如何使用和分发代码。以下是基于当前接口的接入评估，未安装这些 SDK，也未声称插件已经完成。开发时应锁定具体版本与源码提交，保存对应 LICENSE/NOTICE 和依赖许可证。

### 1. MCP 配置包与连接管理插件：优先

项目已有 [MCP 后端校验和 ACP 序列化](../src-tauri/src/mcp.rs)，支持 stdio、HTTP、SSE 配置。插件可以通过 [会话创建 API](../src/plugin-runtime/session-creation/pluginSessionCreationApi.ts) 登记贡献、编译器与 artifact handler，再在 `pylon/session-preflight` 产生 `pylon/acp-new-session-options` effect，其 payload 含 `mcpServers`。现有 [sessionPreflight](../src/plugins/core/sessionCreation/sessionPreflight.ts)、CLI 和工作台入口已经消费这一结果。

最小可交付插件是工作区 MCP 配置包：设置页编辑配置，贡献冻结本次新会话需要的配置，handler 输出已校验的服务器参数，保留用户选择。旧会话不应因配置包更新而悄悄改变服务器集合。注意 `workspaceMcpServerIds` 当前内置贡献只是提示文本，不能把列出 ID 当作服务器已经连接。

如果只是向 Agent 传递配置，无需再引入一套 MCP 客户端。只有插件自己需要枚举工具/资源或检测连通性时才使用 [官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。当前 [SDK LICENSE](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/LICENSE) 正处于 MIT 向 Apache-2.0 过渡，部分未获重许可同意的贡献仍为 MIT，普通文档为 CC-BY-4.0；不能把整个最新 SDK 简写为“MIT”。

接入验收：禁用项、重复身份、空命令/非法 URL 必须被拒绝或过滤；新会话实际收到预期服务器；恢复会话保持原配置；取消和卸载清理检测进程。OAuth 配置在当前 Rust schema 中只做表单校验、不进入 ACP wire，不能把填写 OAuth 字段当作已实现授权流程。

### 2. LSP 代码诊断与跳转插件：中等工作量

复用 [vscode-languageserver-node](https://github.com/microsoft/vscode-languageserver-node) 的 `vscode-jsonrpc` / `vscode-languageserver-protocol`，其 [代码许可证是 MIT](https://raw.githubusercontent.com/microsoft/vscode-languageserver-node/main/License.txt)。这些库可用于协议桥接；不建议为了它们移植整个 VS Code 扩展宿主。

Pylon 的 [process API](../src/infrastructure/plugins/pluginProcessClient.ts) 已提供 raw 字节读写、请求超时、AbortSignal 和进程生命周期。[Rust JSON-RPC 实现](../src-tauri/src/plugin_process/mod.rs) 按换行拆帧，而 [LSP 基础协议](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/specification.md) 使用 `Content-Length` 字节头。相同的 JSON-RPC 名称不意味着可以直接连接。

推荐由受管 sidecar 使用官方库与语言服务器通信，再向插件暴露少量类型化诊断/跳转操作；或在 raw 通道实现适配。第一版提供独立诊断面板和文件跳转，编辑器内联诊断需先核对 CodeMirror 的扩展贡献接口。需补文档版本跟踪、增量同步、服务端通知、工作区目录和服务器退出处理。

接入验收：UTF-8 多字节内容的字节长度、分包/粘包、旧文档版本诊断丢弃、取消请求、服务器异常退出，以及插件卸载后子进程与监听器归零。所选语言服务器本身的许可证需单独核对，MIT 客户端库不覆盖它。

### 3. A2A 远程 Agent 任务面板：探索性

[官方 JS SDK](https://github.com/a2aproject/a2a-js) 提供 Agent Card 发现、消息、任务查询、流式结果和取消；[package.json](https://raw.githubusercontent.com/a2aproject/a2a-js/main/package.json) 标识包名 `@a2a-js/sdk`、Apache-2.0 和 Node >=20。其 [README](https://raw.githubusercontent.com/a2aproject/a2a-js/main/README.md) 给出 ClientFactory、sendMessageStream 和 cancelTask 接口。

可用 Pylon 的受管进程、服务、命令与 UI 贡献构建独立远程任务面板。先实现发现→提交→流式结果→取消→按远端 taskId 恢复查询，保留 endpoint、远端 taskId 与本地 owner 的映射。请求中止不等于远端任务取消，必须确认服务器终态。

当前 Pylon 的主要 Agent 会话路径围绕 ACP；完整替代聊天 Agent 需要额外的协议适配接口和状态映射。不能仅包装 HTTP 请求就宣称已有 ACP 等价的权限审批、会话恢复和工具语义。验收需覆盖认证失败、网络断开、重复事件、远端任务终态和卸载，不默认开启 webhook 服务。

### 4. ACP：复用已有能力

[ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) 的 [LICENSE](https://raw.githubusercontent.com/agentclientprotocol/typescript-sdk/main/LICENSE) 为 Apache-2.0。Pylon 已经有 Rust ACP SDK、会话能力注册和 provider-private bridge；新增供应商适配可以利用这些边界，但目前 [provider_adapter](../src-tauri/src/provider_adapter/mod.rs) 仍含封闭的 bridge 枚举，不能描述成任意第三方插件可动态登记协议桥。

因此本阶段优先 MCP 配置插件，其次 LSP 工具插件，A2A 单独实验。Apache-2.0 组件的许可和适用 NOTICE、修改标记应随分发保留；MIT 组件保留版权和许可文本。Pylon 的 MIT 根许可证不能覆盖依赖各自的许可要求。
