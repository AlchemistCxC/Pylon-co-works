# Pylon Repository Map

## 根目录

- `src/`：React 前端生产源码。
- `src-tauri/`：Rust/Tauri 后端生产源码。
- `scripts/`：前端 pure/contract regression；`scripts/agent-workflow/` 是双 Agent 调度器。
- `docs/`：产品设计与前后端持续交接手册。
- `.agents/`：版本化工作流规则、任务定义和契约。
- `agents.yaml`：Agent subprocess registry，可能包含敏感运行配置，不向前端透出 env/args。

## 工作区

- 主集成：`G:\Project\prism-desktop`，分支 `main`。
- Backend：`G:\Project\prism-desktop-backend`，分支 `agent/backend`。
- Frontend：`G:\Project\prism-desktop-frontend`，分支 `agent/frontend`。
- 共享状态：`G:\Project\prism-desktop-agent-state`，不进入产品 Git。

## 前端地图

- `src/App.tsx`：App 壳、SheetHost、overlay、右栏和全局事件。较大，只按任务范围读取。
- `src/store.ts`：Theme/Profile/Session/Agent/runtime/Sheet 状态 owner。较大，只有任务涉及状态 owner 时读取相关段落。
- `src/workspace-sheets/`：Sheet 类型、registry、reducer、persistence、titlebar、launcher。
- `src/components/chat/ChatView.tsx`：ACP events、replay、消息状态和渲染；大文件，按 symbol 读取。
- `src/components/RightPanel.tsx` 与 `src/components/right-panel/`：Workspace/Logs 右栏。
- `src/components/PrismSheet.tsx`：当前仍有静态演示数据，真实接入属于 F2。
- `src/components/Settings.tsx`：Agent 切换、主题和设置入口。
- `scripts/run-frontend-tests.mts`：前端集中测试入口，当前 allowed failures 为空。

## 后端地图

- `src-tauri/src/lib.rs`：AppState、Tauri commands、dispatcher、Session/Agent 生命周期、Prism 注册、export。当前过大，默认按 symbol 读取。
- `src-tauri/src/acp.rs`：JSON-RPC child、pending、reader、EOF、cancel、load replay。
- `src-tauri/src/agent_runtime.rs`：generation/source/periId 路由和状态纯逻辑。
- `src-tauri/src/agent_config.rs`：Agent registry parse/load/default。
- `src-tauri/src/prism.rs`：固定 loopback Prism HTTP client。
- `src-tauri/src/workspace.rs`：Workspace containment、目录和文本预览。
- `src-tauri/src/runtime_log.rs`：脱敏日志 ring buffer。
- `src-tauri/src/mcp.rs`：MCP 配置校验与 ACP serialization。
- `src-tauri/src/error.rs`：PylonError；当前序列化仍偏字符串。

## 身份模型

- `sheetId`：前端 Workspace Sheet。
- `agentId`：Agent registry key。
- `Session.id`：前端本地 Session 实体。
- `source`：Tauri Session 路由 key。
- `periId`：ACP 远端 sessionId。
- `sessionGeneration`：Session 映射代际。
- `clientGeneration`：ACP client 代际。

这些 ID 不得混用。Workspace root 必须由 `source → SessionInfo.cwd` 解析。

## 当前架构边界

后端仍是单 active runtime：一个 ACP client、一个 active Agent、一个 dispatcher 和一份 runtime Session mapping。前端可保存多个 Agent Sheet 工作现场，但 B7 前不能宣传后台多 Agent 并行。

## 外部真值

- Peri ACP：`F:\A-I\Agent\Peri`，只读核对。
- Prism HTTP：`G:\Project\prism`，只读核对。
- `G:\Prism` 是生产数据目录，不是开发 fixture。

## 验证入口

前端最小：

```bash
node --experimental-strip-types scripts/<targeted>.mts
npm run build
```

前端 checkpoint：

```bash
npm run test:frontend
npm run build
```

后端最小：

```bash
cd src-tauri
unset RUSTFLAGS
cargo check
cargo test --lib <filter> -- --nocapture
```

后端 checkpoint 按任务范围增加 `cargo test --lib --no-run`、focused fake ACP 和真实运行验收。
