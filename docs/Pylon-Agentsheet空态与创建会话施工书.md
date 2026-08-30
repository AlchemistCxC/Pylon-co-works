# Agentsheet 空态与创建会话形态施工书

## 结论

P7 的首片已在现有 Solid Workbench 空态中落地，本轮完成命令边界核对与文档登记，不重复改写已稳定的创建流程。真实窗口视觉验收按当前工作约定暂缓。

## 现状与边界

- `WorkbenchEmptyState` 是无活动会话时的唯一创建入口；不新增旁路的会话创建命令。
- 聊天模式直接提交首条请求；工作区模式必须先选已有工作区，或通过文件夹选择事件创建工作区。
- 创建请求继续调用 `context.commands.createSession`，携带 `workspaceId`、可选 `model`、`reasoningLevel`、`mode` 和首条请求附件。
- 创建中冻结输入并暴露 `aria-busy`；失败保留首条请求与工作区选择并恢复输入焦点。

## 视觉契约

- 空态保留品牌标记、横向细线和一条宽输入面；配置选项位于输入面内，不改变主舞台几何。
- terminal-like 预设将创建面、选择器和动作按钮统一为无圆角、无阴影的安静仪器语气。
- 现代 GUI 可保留其窄范围圆角表达；这不是创建命令或数据边界。

## 兼容性、性能与可观察性

- 兼容现有 `pylon:new-session`、`pylon:pick-workspace-folder` 事件和 `createSession` command facade。
- 提交仅发生在用户发送时；没有轮询或额外网络请求。创建中状态由本地信号驱动。
- 错误通过空态 `role=alert` 呈现；命令参数由测试锁定，避免把视觉调整变成协议改动。

## 证据

- `src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx`：单/多工作区预选、无工作区禁用、创建参数、创建中冻结、失败保留草稿与焦点。
- `src/sheets/agent-workbench/AgentRendererSuiteWorkbench.tsx`：host command capability 仅对 `builtin.solid` 开放 `sessionCreate`。
- `src/plugins/product/packages/builtin.pylon-renderers/styles/components/solid-workbench/WorkbenchChrome.css`：terminal-like 空态无圆角/无阴影规则。

## 后续

真实窗口验收时只需核对不同终端预设下输入面宽度、垂直占用和无圆角契约；不得改变创建 command 形状。
