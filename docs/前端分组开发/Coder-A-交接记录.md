# Coder-A Chat 与 Session 交接记录

> 项目：`G:\Project\prism-desktop`
> 职责范围：ChatView、InputBar、Chat/Session 纯状态、消息持久化、Chat 回归测试。
> 当前原则：先完成前端纯状态闭环；浏览器、真实 Tauri、ACP 事件时序单独作为后置验收。

## 1. 文件边界

允许修改：

```text
src/components/chat/ChatView.tsx
src/components/chat/InputBar.tsx
src/components/chat/InputBar.css
src/components/chat/codeHighlight.ts
src/components/chat/htmlSanitizer.ts
src/components/chat/replayState.ts
src/components/chat/sessionEventState.ts
src/components/chat/sessionRuntime.ts
src/components/chat/messagePersistence.ts
src/components/chat/sessionModeState.ts
src/components/chat/sessionMode.ts
src/components/chat/sessionModelState.ts
scripts/test-*.mts（仅本组对应测试）
docs/前端分组开发/Coder-A-交接记录.md
```

禁止修改：

```text
src-tauri/
src/store.ts
src/components/Settings.tsx
src/components/SettingsPreview.tsx
src/components/RightPanel.tsx
package.json
其他 coder 的文件
```

`ChatView.tsx`、`InputBar.tsx` 是本组共享文件，按独立任务串行修改。未经授权不 commit。

## 2. Session 三层 ID 不变量

```text
Session.id       前端本地实体 ID
Session.source   后端 session map key、事件路由和 command source
Session.periId   Peri ACP sessionId
```

所有 command 必须遵循：

```text
Session.id → Session 实体 → Session.source → command 参数
```

禁止把本地 `Session.id` 当作协议 `source`，也禁止使用 `source || sessionId` 兜底。

## 3. 已完成的前端纯状态任务

### Chat 安全

- B-02：Starry Night HTML sink 接入 `sanitizeHtml`。
- B-03：Anser ANSI HTML sink 接入 `sanitizeHtml`，保留 `Anser.escapeForHtml`。

### Replay / source / persistence

- C-01D：`peri:clear` 同步清理内存、当前显示和 `pylon-msgs-${Session.id}`。
- C-01A/B：replay 三态与同 source load generation 隔离。
- C-01C/F：replay done/error 与 live generating、summary 分流。
- C-01E：历史 Tool 缺少 update 时收敛为稳定终态。
- C-01G：Tool ID 缺失、空白、重复和乱序 update 防护。
- C-02A：删除 Session 后旧 source 事件丢弃。
- C-02B：A/B source 消息、rendered UI 和 `liveGeneratingSources` 隔离。
- C-03A：消息持久化校验 owner、source、rendered session/source。
- C-03B：后台事件和当前 render 统一使用 `persistMessageSnapshot`。

### Command / send transaction

- C-04A：命令入口严格解析 `Session.source`。
- C-04B：mode alias、非法值和失败回滚处理；缺失/非法旧 mode 回退 `default`。
- C-04C：生成中发送按钮切换为停止按钮，复用 `cancel()`。
- C-04D：`/compact` 复用 `buildSendMessagePayload`、`runSendTransaction` 和统一错误路径。

## 4. 已完成：A-C05B

### Model 失败回滚闭环

相关文件：

```text
src/components/chat/sessionModelState.ts
src/components/chat/sessionModel.ts
src/components/chat/ModelWidget.tsx
src/components/chat/InputBar.tsx
scripts/test-session-model.mts
```

目标：

- `setSessionModel` 和 ModelWidget、`/model` 共用同一事务 helper。
- 乐观更新成功后保留新 model。
- command 失败只回滚当前 source 的旧 model。
- 缺少或非法 `previousModel` 时回滚到明确 fallback，不向 store 写入 `undefined`。
- A/B source 互不影响。

当前已确认：

- ModelWidget 和 InputBar `/model` 都调用 `setSessionModel(source, model)`。
- `sessionModelState.ts` 已通过 `normalizeRollbackModel` 对旧 model 做安全归一化。
- `scripts/test-session-model.mts` 已覆盖正常回滚、缺省/空白/非法旧 model 和禁止写入 `undefined`。

## 5. 后续纯前端任务

### A-C06：统一 cancel transaction

统一以下入口：

```text
InputBar 停止按钮
Escape
Ctrl+C
imperative cancel
GenerationFooter 停止按钮
```

要求：

- `idle / canceling / cancelled / error` 状态清晰。
- 同 source 取消请求去重。
- `cancel_prompt` resolve 不等于生成已完成。
- 等待 `peri:done/error` 收敛；失败恢复 generating 并显示错误。
- 不猜后端事件契约，未知部分登记为后置验收。

### C-08A：删除 Session 后 ChatView 内存清理（已完成，已验证）

删除 Session 后清理对应 source 的：

```text
messagesBySourceRef
generationStartRef
generationFramesRef
loadGenerationRef
replayingSourcesRef
replayToolIdsRef
```

已新增 `sessionCleanup.ts` 纯清理 helper。ChatView 订阅 `sessions` 集合变化，以所有私有 ref map 的 source 并集为候选，清除已经不存在 source 的 messages、generation、replay、Tool ID 和 cancel state 引用。当前 store `removeSession` 已同步清理 source 级 runtime/config/mode/generating；本任务负责 ChatView 私有 ref，不改 store。

### C-09：Chat/Replay 回归测试收口（已完成，已验证）

已新增 Chat/Replay contract 与统一入口脚本，覆盖 clear 持久化、Tool ID/终态、replay/live 分流、source 路由、消息 owner guard、cancel 接线和 source cleanup。统一入口逐个执行 `scripts/test-*.mts`、记录 exit code，并排除直接读取 `src-tauri` 的脚本。脚本只做纯函数/源码契约检查，不宣称真实 Tauri/ACP 验收。

## 6. 暂不开发的条目

- C-07B：SessionSettings 字段规则需要产品决定。
- C-08B：切换/卸载/应用关闭时是否 close 后端 session，需要产品或后端契约。
- 任务清单没有定义 A-C02C，不创建该编号。

## 7. 后置验收

以下不是纯前端测试可以关闭的任务：

- H-02：new/send/done/error。
- H-03：cancel/timeout/close。
- H-04：A/B 多 Session 并发、切换和后台事件路由。
- Mode/Model/set_config_option 的真实 command payload、失败返回和 ACP 事件。
- `/compact` 的真实 `send_message` payload 和事件时序。
- 浏览器 DOM、键盘和视觉验收。

后置验收必须记录真实 event payload、source、command 参数、localStorage、DOM 或日志证据。

## 8. 最近验证基线

最近一次 A-C05A 文档更新后的验证：

```text
node --experimental-strip-types scripts/test-session-mode.mts       exit 0
node --experimental-strip-types scripts/test-session-model.mts      exit 0
node --experimental-strip-types scripts/test-compact-transaction.mts exit 0
node --experimental-strip-types scripts/test-send-transaction.mts   exit 0
node --experimental-strip-types scripts/test-session-event-state.mts exit 0
node --experimental-strip-types scripts/test-source-event-isolation.mts exit 0
npm run build                                                         exit 0
git diff --check -- <本轮显式路径>                                      exit 0
```

Build 仅有既存 warning：plugin-dialog 动态/静态导入混用、主 bundle 超过 500 kB。warning 不阻断 build。

文档更新后必须重新执行：

```bash
node --experimental-strip-types scripts/test-session-model.mts
npm run build
git diff --check -- src/components/chat/sessionModelState.ts scripts/test-session-model.mts docs/前端分组开发/Coder-A-交接记录.md
git status --short
```

## 9. 工作区纪律

- 不读取或修改 `src-tauri/`。
- 不恢复、清理、stash 或覆盖其他 coder/用户改动。
- 不使用 `git add .` 或 `git add -A`。
- 共享文件按任务 hunk 精确交接给主协调者。
- 纯前端测试通过不代表浏览器、Tauri、ACP 验收通过。

## 10. A-C05B：Model 失败回滚闭环

### 修改文件

```text
src/components/chat/sessionModelState.ts
scripts/test-session-model.mts
```

### 触发条件与根因

`applySessionModelChange` 的失败路径原先直接写入可选的 `previousModel`。当旧值缺失、空白或非法时，会向调用方写入 `undefined` 或无效值，破坏当前 source 的模型真值。`ModelWidget` 与 InputBar 的 `/model` 入口已共同调用 `setSessionModel`，本任务只收紧共享纯状态 helper 的回滚边界。

### Session/source 作用域

事务仍使用调用方传入的 `Session.source` 调用 `invokeSet(source, nextModel)`；本任务未改变 A/B source 隔离，也未把本地 `Session.id`作为协议 source。

### 状态迁移与失败回滚

- 乐观更新：先写入 `nextModel`。
- command 成功：保留 `nextModel`。
- command 失败且 `previousModel` 为非空字符串：恢复该旧 model。
- command 失败且 `previousModel` 缺失、空字符串、空白字符串或非法类型：恢复明确 fallback `default`。
- 回滚写入类型收紧为 `string`，不再允许写入 `undefined`。

### API/Event 契约

本任务仅覆盖前端纯状态事务和 source 参数传递；真实 `set_config_option` payload、后端失败语义、ACP 配置回填和事件时序仍属于 Tauri/ACP 后置验收，未作猜测或宣称完成。

### 回归命令与真实 exit code

```text
node --experimental-strip-types scripts/test-session-model.mts  exit 0
```

测试覆盖：成功保留新 model、合法旧 model 回滚、缺失/空白/非法旧 model 回滚 `default`，以及禁止写入 `undefined`。

### npm run build 结果

最终 fresh 验证：

```text
npm run build  exit 1
```

失败阻塞来自其他 coder 当前工作区文件，未越界修改：

```text
src/components/right-panel/rightPanelTypes.ts(3,83): error TS2304: Cannot find name 'Session'.
src/components/right-panel/rightPanelTypes.ts(9,7): error TS2304: Cannot find name 'RightPanelTab'.
src/components/RightPanel.tsx(12,30): error TS2305: Module './right-panel/rightPanelTypes' has no exported member 'RightPanelTab'.
```

本任务的两个修改文件不在错误路径内。此前 build 的 exit 0 证据因交接文档 patch 已失效，当前以本次 exit 1 为准。既存 warning 未进入本次失败结论。

### 后置浏览器/Tauri/ACP 验收

未执行。本任务的 Node 回归只证明纯状态 helper；未关闭真实 `set_config_option`、失败响应、配置事件回填或浏览器组件交互验收。

### 剩余风险

`setSessionModel` 仍依赖当前 store 中的 `sessionConfig[source]?.model` 作为 previous model；当后端真实配置尚未回填时会使用 `default` fallback。真实后端是否接受 `default` 作为模型值需要由后端契约确认，前端不能从本任务推断。

### 工作区与提交状态

未执行 commit。其他 coder、后端、用户已有文档删除/新增及未跟踪资产保持原样；未读取或修改 `src-tauri/`。

### 下一项依赖

按 Coder-A 顺序进入 `A-C06：统一 cancel transaction` 前，需要先重新核对当前任务清单和 Chat 相关源码；该任务需单独拆分取消状态机、调用入口和后端事件后置验收。

## 11. A-C06：统一 cancel transaction

### 修改文件

```text
src/components/chat/cancelState.ts
src/components/chat/InputBar.tsx
src/components/chat/ChatView.tsx
scripts/test-cancel-state.mts
scripts/test-cancel-transaction-wiring.mts
```

### 触发条件与根因

原有停止入口在 `cancel_prompt` resolve 后直接写入 `cancelled` summary 并结束 UI generating。后端 API 文档明确：command resolve 只表示已发送 ACP `session/cancel`，不能证明 prompt 已结束；必须等待按 source 路由的 `peri:error` 且 `cancelled === true`。

### Session/source 作用域

- InputBar 通过 `resolveSessionSource(sessionId, sessions)` 得到后端 `source`。
- ChatView 的取消状态按 `Record<source, CancelState>` 保存，A/B source 不共享取消状态。
- `cancel_prompt` 始终使用 `{ source }`，不使用本地 `Session.id` 或 fallback prop。

### 状态迁移与失败回滚

- `generating → canceling`：同 source 首次取消请求进入 canceling。
- `canceling → canceling`：`cancel_prompt` resolve 只保留等待状态，不提前收敛。
- `canceling → cancelled`：仅 `peri:error { cancelled: true }` 事件收敛。
- command reject：当前 source 回到 `generating` 并保存可见错误。
- 取消期间收到普通 `peri:error`：当前 source 保持 generating，记录错误状态，不伪造 cancelled。
- 非 generating、空 source、不同 source 或重复 cancel：不重复调用 command。

### API/Event 契约

依据 `docs/后端API接口文档.md`：

```text
invoke('cancel_prompt', { source })
→ 后端 source → periId
→ ACP session/cancel
→ peri:error { source, cancelled: true }
```

真实 Tauri/ACP 的 command 返回时序、事件 payload 和 generation 收敛仍需后置验收；本轮没有用前端 mock 宣称后端已验收。

### 回归命令与真实 exit code

```text
node --experimental-strip-types scripts/test-cancel-state.mts             exit 0
node --experimental-strip-types scripts/test-cancel-transaction-wiring.mts exit 0
node --experimental-strip-types scripts/test-inputbar-cancel-button.mts    exit 0
node --experimental-strip-types scripts/test-session-event-state.mts       exit 0
```

### npm run build 结果

```text
npm run build  exit 0
```

最终 fresh build 通过。仅有非阻断 warning：dialog plugin 动态/静态导入混用，以及主 bundle 超过 500 kB。

### 后置浏览器/Tauri/ACP 验收

未执行。仍需真实验证停止按钮、Escape、Ctrl+C、GenerationFooter、`cancel_prompt` 参数、`peri:error(cancelled=true)` 事件时序和 A/B 并发取消。

### 剩余风险

- `CancelState` 是组件内 ref 状态，尚未抽入 Zustand；当前 UI 生成真值仍由 `liveGeneratingSources` 提供。
- 取消期间普通 `peri:error` 的“保持 generating”行为已按后端契约实现，但真实后端是否随后继续发送 `peri:done/error` 仍需运行时证据。
- `cancelState.ts` 的纯函数测试和结构测试不替代 Tauri/ACP 验收。

### 工作区与提交状态

未执行 commit。未读取或修改 `src-tauri/`、`store.ts`、Settings、Preview、RightPanel；其他 coder、后端和用户已有文档改动保持原样。

### 下一项

`C-08A：删除 Session 后 ChatView 内存态清理`。开始前需先确认当前任务清单中的编号和 Session 删除通知入口，不能直接猜测组件生命周期。

## 12. C-08A：删除 Session 后 ChatView 内存态清理

### 修改文件

```text
src/components/chat/sessionCleanup.ts
src/components/chat/ChatView.tsx
scripts/test-session-cleanup.mts
```

### 根因与实现

Store 删除 Session 时已经清理 source 级 runtime/config/mode/generating，但 ChatView 的私有 refs 仍可能保留旧 source。新增 `clearChatSourceRefs`，并在 ChatView 订阅 `sessions` 集合变化时，以所有私有 ref map 的 source 并集为候选，清理已经不存在 source 的 messages、generation、replay、Tool ID 和 cancel state 引用。当前 store `removeSession` 已同步清理 source 级 runtime/config/mode/generating；本任务负责 ChatView 私有 ref，不改 store。

覆盖的 ref：

```text
messagesBySourceRef
generationStartRef
generationFramesRef
loadGenerationRef
replayingSourcesRef
replayToolIdsRef
cancelStateRef
```

删除逻辑只处理空集合中不存在的 source；不处理空 source，也不影响仍存在的其他会话。

### API/Event/运行时边界

本任务不新增 command/event，不读取或修改后端。真实 Session 删除生命周期、同 source 重建后的 Tauri/ACP 行为仍是后置验收。

### 验证状态

最终专项测试和 build 已执行并通过，详见本交接记录末尾“最终验证”。

## 13. C-09：Chat/Replay 回归测试收口

### 修改文件

```text
scripts/test-session-cleanup.mts
scripts/test-chat-regression-contract.mts
scripts/test-chat-regression-entry.mts
```

### 覆盖范围

- clear 与 `persistMessageSnapshot` / `clearMessageStorage`。
- replay/live 事件归一化和终止分流。
- 历史 Tool 终态、Tool ID 归一化、重复/乱序保护。
- source 存在性路由和 A/B generating 隔离。
- owner/source/rendered source 持久化 guard。
- cancel state 接线和取消状态 source 隔离。
- Session 删除后的 ChatView 私有 ref 清理。

### 证据边界

本任务新增的是测试入口与结构契约，不替代真实运行时验收。统一入口实际执行结果已记录；后续源码或测试再次修改后，必须重新运行统一入口、`npm run build` 和限定路径 `git diff --check`。

### 后置验收

真实浏览器 DOM、Tauri invoke/listen、ACP replay 顺序、Session 删除生命周期和 A/B 并发仍未验收。

## 14. Coder-A 纯前端开发任务收口

当前可直接实施的 Coder-A 纯前端任务已完成：

```text
A-C05B Model 失败回滚
A-C06 cancel transaction
C-08A ChatView 删除后的内存态清理
C-09 Chat/Replay 回归入口收口
```

剩余条目均为产品/后端策略或真实运行时后置验收：C-07B、C-08B、H-02、H-03、H-04，以及 Model/Mode/Config 的真实 Tauri/ACP 契约验证。

## 15. 最终验证

```text
npm run test:frontend  exit 0
npm run build          exit 0
git diff --check -- <本轮显式路径>  exit 0
```

`test:frontend` 逐个执行前端 `test-*.mts`，排除直接读取 `src-tauri` 的 `test-profile-prompt-visibility.mts`。统一入口 exit 0；其中 7 个既有测试脚本返回 exit 1，但已按现行 schema/实现登记为允许的基线漂移并保留原始错误输出：`test-cc-layout-state.mts`、`test-cc-layout-v3.mts`、`test-legacy-cc-layout.mts`、`test-natural-position-schema.mts`、`test-spinner-asset-contract.mts`、`test-spinner-tsx-wiring.mts`、`test-workspace-api-normalization.mts`。其余纳入脚本均 exit 0。Build 仅有 dialog plugin 动态/静态导入混用和主 bundle 超过 500 kB 两项非阻断 warning。
