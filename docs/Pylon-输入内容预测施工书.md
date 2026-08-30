# 输入内容预测施工书

## 现状盘点

- Workbench 已能接收 `assist.prediction` 事件并在消息流中显示预测卡；这不是输入框内的 ghost text，也不具备接受后写入草稿的状态机。
- 输入台草稿、历史、队列和附件均按 `sessionId` 隔离在 `sessionUiStore`；发送/编辑/组合输入已有明确门控。
- 当前没有预测请求 command、远端缓存或隐私开关；不能把消息正文默认为可上传数据。

## 目标

在输入台增加低打扰预测提示：预测只作为草稿候选，不进入发送历史；接受、拒绝、编辑或切换会话后失效。默认本地优先，远端预测必须显式开启并可见地标注来源。

## Slice A（待施工）

先建立纯状态机与 presenter seam，不接模型：

- `idle → pending → shown → accepted|dismissed|invalidated`；
- 草稿变更、附件变更、输入法 composition、发送、取消和 session 切换都使当前预测失效；
- `Tab`/右箭头接受，`Escape`/任意编辑拒绝；接受只更新 draft，不直接发送；
- 预测文本不得写入 `input-history` 或持久化 workspace/session 配置。

## 隐私与可观察性

- 默认不发送草稿到远端；远端模式需独立设置、请求前显示状态，并提供清除/禁用入口。
- 预测请求带 session generation 与 AbortSignal，迟到结果丢弃；日志只记录耗时、来源和结果码，不记录正文。
- 预测 UI 使用 `aria-live="polite"`，不抢焦点；屏幕阅读器可读取来源和接受键。

## 后续

Slice B 再接入本地/远端 provider，Slice C 做真实模型和性能验证；不得复用消息流 `assist.prediction` 事件冒充输入框预测。
