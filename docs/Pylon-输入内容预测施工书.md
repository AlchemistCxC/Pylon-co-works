# 输入内容预测施工书

## 现状盘点

- Workbench 已能接收 `assist.prediction` 事件并在消息流中显示预测卡；这不是输入框内的 ghost text，也不具备接受后写入草稿的状态机。
- 输入台草稿、历史、队列和附件均按 `sessionId` 隔离在 `sessionUiStore`；发送/编辑/组合输入已有明确门控。
- 当前没有独立的预测请求 command；运行时已经能从 SQLite canonical 事件投影出用户消息，输入台可直接复用该权威历史。

## 目标

在输入台增加低打扰预测提示：预测只作为草稿候选，不进入发送历史；接受、拒绝、编辑或切换会话后失效。来源可标注但不以隐私开关阻塞体验，重点保证低频、可取消和不误发。

## Slice A（已完成）

输入台已建立纯函数预测 seam，并接入 Solid Workbench：

- `idle → pending → shown → accepted|dismissed|invalidated`；
- 草稿变更、附件变更、输入法 composition、发送、取消和 session 切换都使当前预测失效；
- `Tab`/右箭头接受，`Escape`/任意编辑拒绝；接受只更新 draft，不直接发送；
- 预测文本不得写入 `input-history` 或持久化 workspace/session 配置。
- 历史补全来源按顺序合并：当前 `runtime.document.messages` 中的 SQLite 权威用户消息，再加当前会话最近发送缓存；去重后取最新且以草稿为前缀的整句。
- 非空草稿显示后缀 ghost text（不改写 textarea value）；`Tab`/右箭头接受，`Escape` 忽略，任意编辑重新计算。
- 空草稿优先显示运行时 `assist.prediction.placeholder`；空 Enter 接受并发送，附件、生成中和 slash 命令建议出现时隐藏。

## 频率与可观察性

- LLM 预测沿用运行时 `assist.prediction` 事件；未来 provider 必须通过 `createPredictionRateLimiter(15_000)`，同一窗口最多一次请求，避免按击键滥用（频率与 Claude Code 的低频策略相当）。
- 用户已明确优先体验；不以隐私开关阻塞本地历史补全，但日志仍只记录耗时、来源和结果码，不记录正文。
- 预测请求带 session generation 与 AbortSignal，迟到结果丢弃；日志只记录耗时、来源和结果码，不记录正文。
- 预测 UI 使用 `aria-live="polite"`，不抢焦点；屏幕阅读器可读取来源和接受键。

## 后续

Slice B 再接入本地/远端 provider，Slice C 做真实模型和性能验证；不得复用消息流 `assist.prediction` 事件冒充输入框预测。
