# Dev Record — #310 FileSheet 发令回传后实时无正文（canonical feed 缺 `pylon:update` 广播兜底）

## 元信息

- issue：[#310](https://github.com/AlchemistCxC/Pylon-co-works/issues/310)（bug）
- 分支：`kumo/filesheet-stage0`（施工时共享工作树所在分支；提交随后随分支 PR 进入 main）
- 日期：2026-09-24/25
- 署名：Kumo
- spec：无（用户实机验收报告驱动）

## 目标与范围

修掉用户报告的第 2 条：**在 FileSheet 里下发指令回传文件内容后，AgentSheet 只显示「处理耗时」页脚、没有助手正文；退出重启后正文才出现**。

**不做什么**：不改发令入口（`DispatchBar` 继续用 `send_message`）；不改投影器/渲染层的边界语义；不动 `src/sheets/file/**`（该域当时有他人在途改动）。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `src/infrastructure/events/canonicalEventFeed.ts` | 新增 `pylon:update` 窗口广播兜底监听（与既有 `pylon:user` 兜底同形） | 修改 |
| `src/__tests__/replay/canonicalEventFeed.test.ts` | 新增回归用例：广播帧经兜底进 plugin bus | 修改 |

## 方案要点

**根因（现场取证，非推断）**：实时行有两条第 1 层入口——

1. **per-source IPC Channel**（主轨）：由 `sendMessageWithStream`（`src/components/chat/streamingSend.ts`）在发送前注册，帧回调里逐帧 `feed().acceptFrame(frame)`。
2. **窗口广播**（兜底轨）：后端在**未注册 Channel** 时整回合改走 `emit_event_all`（dispatcher 里 `send_update_frame` 与 `emit_event_all` 是互斥分叉）。

FileSheet 的发令栏走 `chatClient.sendMessage`（**不是** `sendMessageWithStream`），因此**从不注册 Channel** → 整回合走广播。而 `canonicalEventFeed` 只给 `pylon:user` / `pylon:done` / `pylon:error` 注册了广播兜底，**`pylon:update` 没有**：

- 助手正文/思考帧（`assistant.thinking.delta.batch` / `assistant.text.delta.batch` 等）进不了 feed → 不 `publishPluginEvent` → 工作台（插件总线订阅者）收不到 → 实时投影里整回合的助手输出不存在；
- 而 `pylon:done` 有兜底轨 → 回合终态照常收敛 → **页脚「处理耗时」出现**、正文缺失；
- 重启冷装载走 `cursor`（读 journal）→ 帧齐全 → 正文出现。

实机证据（真实 Hermes 会话，用户授权的真实 agent 回合）：

| 观测 | 修复前 | 修复后 |
| --- | --- | --- |
| 回合内 DOM 聊天行数 | 4（+1 用户行，**无助手行**），页脚「处理耗时 7s」 | 9 → **12**（+用户行 +思考行 +正文行） |
| 重载（冷装载）后行数 | 6（正文与思考行**这才出现**） | —（无需重载） |
| 临时探针（live 订阅入口 + `applyDocument` 拒绝点） | 14s 内工作台监听器只收到 4 帧：`session.model-updated`、`user.message`；`assistant.*` 一条都不到，`applyDocument` 无拒绝记录 | — |
| 原始 `pylon:update` 帧（MCP 直订） | 帧**确实到达页面**（含 `assistant.text.delta.batch`、`payload.canonicalEvent` 齐备） | 同 |

即：丢在「原始帧 → plugin bus」这一段，而不是后端、不是投影器、不是渲染层。

**修法**：在 `createCanonicalEventFeed` 里补一条与 `pylon:user` 同形的广播兜底：

```ts
void listen('pylon:update', event => {
  void feed.acceptFrame({ event: 'pylon:update', payload: event.payload })
})
```

- 与主轨不重复：Channel 存在时后端不发广播（互斥分叉），不存在时广播是唯一来源；真出现重复时由 `cursor` 的 sequence 去重与投影器幂等（eventId / coverage 跨度）吸收。
- 不重复落盘：`acceptFrame` 只做 cursor/publish/forward/terminal，**不**调 `sink.offer`（本地乐观落盘走 `feed.offer`）。
- 顺带覆盖同类路径：平台 ingest 与 `pylon_cli session send` 同样不注册 Channel，此前有一样的实时缺失。

## 验收标准与结果

- 现场（真实 agent、真实会话、真实发令报文格式）：
  - 修复前：回合内 4 行 + 页脚「处理耗时 7s」；重载后 6 行（正文回来）——复现用户现象。
  - 修复后：回合内 9 → 12 行，助手正文行 `⎘这是 Pylon（Prism Desktop）前端 src/sheets/browser/ 子模块——浏览器 Sheet 的类型定义。` 实时出现，未重载。
- 回归用例：`src/__tests__/replay/canonicalEventFeed.test.ts` 新增 `#310：pylon:update 广播兜底把助手正文帧送进 plugin bus（未注册 Channel 的发送路径）`；**变异核验**：去掉兜底 → 该用例必红（1 failed / 8 passed），恢复 → 9 passed。
- 受影响面测试：`bunx vitest run src/__tests__/replay src/sheets/agent-workbench src/domains/workbench src/infrastructure/events src/components/chat` → **120 文件 / 1239 passed / 1 todo / 0 failed**。

## 测试处置

- 新增：1 条（见上），断言「广播帧 → plugin bus」这一契约（不是实现细节）。
- 修改既有测试：无。

## 证据

- 现场取证用的临时探针（`[probe2]`）已**全部回退**，工作树无残留（`grep probe2 src` 空）。
- 事件侧原始帧、DOM 行数、探针日志三段证据互相印证；取证脚本与命令见 issue #310 评论。
- 本轮消费真实 agent 回合 3 次（用户明确授权「准许你用真实例子测试」）：1 次复现 + 1 次探针定位 + 1 次修复验证。

## 与 spec 的偏差

无 spec。实现上刻意选择「feed 层补兜底」而不是「发令入口改用 streaming 发送」：后者只能治 DispatchBar，治不了平台 ingest / CLI 发令，且把「实时可见」变成发送方必须遵守的隐式契约。

## 未解问题

1. **本改动无实机以外的自动覆盖**：兜底监听的注册只在真实 Tauri 环境生效（测试里 mock 了 `listen`），故只锁了「帧 → bus」的契约；真实环境的行为判据取现场 DOM 行数。
2. 前端全量门禁 `bun run build`（含 `tsc -b`）本轮**未能跑通**：失败点是他人正在编辑的 `src/sheets/file/__tests__/*`（TypeScript 报错属其未完成改动），不是本改动；出包本身用 `bunx vite build` 完成（产物等价，Rust 侧 `cargo build` 通过）。合入前应在对方收工后补跑一次完整 `check:frontend`。
3. 同一族路径值得复核：`pylon:user` 兜底已有、`pylon:update` 本轮补上，若将来新增事件族（如 extension/hook 帧）走广播，需同步考虑是否需要兜底。

## 并行交集

- `.agents/L.md` 已按 §2.3-4 声明施工范围并单独提交；本轮实际落点 `src/infrastructure/events/canonicalEventFeed.ts` 已在声明中补记。
- 共享工作树当时有他人在途改动（`src/sheets/file/{DispatchBar,FileCodeEditor,FileTabView,FileViewHost}.tsx`、`src/application/hooks/canonicalTouchedFileProjection.ts`）：按 §2.1 **未 abort、未 stage、未 commit、未改动其文件**，本记录与提交一律 pathspec。
