# 开发记录 · #172 结构化拒绝 DTO 不再被 String() 吞成 [object Object]

## 元信息

- issue：AlchemistCxC/Pylon-co-works#172（bug）
- 分支：`Ru5t/Reflector`
- 提交：`eb200bb5`
- 关联：spec 无（issue 正文即完整根因链，方案按其建议执行）

## 根因（复核 issue 结论，代码逐段一致）

后端错误 DTO 是 `{ code, message }` 结构化对象（非 Error）；`createCommandPort` 的 catch 对
非 Error 值走 `String(error)` ⇒ `[object Object]`，真实 `code` 被替换为 `command_failed`、
真实 `message` 永久丢失；下游 `unwrap` 把这条 message 再包成 Error，空态错误条原样展示。

## 修法

1. `src/utils.ts` 提共享助手，收敛既有 5 处归一化惯例为单一来源：
   - `errorMessage(error, fallback?)`：Error → message；带 message 的对象 → 该 message；其余
     String 化；`[object Object]`/空值回退 fallback。
   - `errorCode(error)`：读取结构化 DTO 的 `code`，非该形状返回 null。
2. `workbenchHostPort.ts` catch：`code: errorCode(error) ?? 'command_failed'`、
   `message: errorMessage(error, '命令被运行时拒绝')`——透传后端真实 code
   （NoActiveAgent / AgentRuntimeUnavailable / Acp…）供错误中心分类。
3. `ControlCenter.solid.tsx` 三处 catch（创建工作区 / 首条请求 restore / 创建会话）改走
   `errorMessage`，各带可读中文兜底。
4. `hostPortSolidServices.ts` 的 `unwrap` 无需改动：port 归一后 `result.error.message`
   已是字符串（issue 建议消费点按现状核对后免改，非遗漏）。

## 测试

| 用例 | 文件 |
| --- | --- |
| 端口归一化：DTO 拒绝透传真实 code+message（含 diagnostics 记账） | `workbenchHostPort.test.ts` |
| 端口归一化：普通 Error 保持 `command_failed` + message | 同上 |
| 错误中心保留可分类 code 与后端 message | `workbenchHostPort.errorCenter.test.ts` |
| 空态错误条：DTO 拒绝显示后端 message 而非 [object Object]；意外值回退可读文案 | `issue172.emptyStateError.solid.test.tsx`（新增，2 例） |

- **变异核验**：临时还原两处旧实现后重跑，3 条新用例转红（3 failed / 20 passed），已恢复修复版。
- issue 验收项「createCommandPort 补断言」与「空态报错无覆盖」两项均已落地。

## 实机验证（webview2 MCP，D:\pylon-acceptance-target\debug\pylon.exe，CDP 9222）

本机 dev 实例 agent 未配置（spawn 失败），恰好构成零额度消耗的真实失败场景：

1. 空态中控 + 工作区选「不使用工作区」+ 输入提交 → 会话创建被后端拒绝。
2. 错误条 `.solid-agent-empty-error` 显示**后端原文**：
   `ACP protocol: session_new_before_initialize: ACP 握手未完成，禁止建立会话`
   （修复前该位置是 `[object Object]`）。
3. 错误中心条目：错误码 **`protocol_error`**（后端真实 code，修复前恒为
   `command_failed`）、来源 `workbench.command`、message 为后端原文——issue 备注的
   「修好后应给出可分类 code」达成（实际 code 形态为 protocol_error，非预估的
   NoActiveAgent/AgentRuntimeUnavailable，因该后端在握手前即拒绝）。

## 门禁

`tsc -b` 无输出；eslint 0 error；定向 3 文件 26 用例通过；全量 605 文件 / 4423 用例通过。
