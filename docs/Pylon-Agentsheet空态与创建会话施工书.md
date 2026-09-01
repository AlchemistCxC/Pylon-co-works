# Agentsheet 空态与创建会话形态施工书

## 结论

P7 的首片已在现有 Solid Workbench 空态中落地；本轮将空态与正常中控区收敛为同一输入宿主，并补齐创建后的位移动效。真实窗口视觉验收按当前工作约定暂缓。

## 现状与边界

- `SolidInputBar` 是空态与正常会话共用的唯一输入宿主；无活动会话时仅由中控壳切换为空态配置，不再创建第二个 textarea。
- `WorkbenchEmptyState` 只负责品牌和邀请文案；工作区、附件、模型等附加内容挂载在共享 Composer 的空态层。
- 聊天模式直接提交首条请求；工作区模式必须先选已有工作区，或通过文件夹选择事件创建工作区。
- 创建请求继续调用 `context.commands.createSession`，携带 `workspaceId`、可选 `model`、`reasoningLevel`、`mode` 和首条请求附件。
- 创建中冻结输入并暴露 `aria-busy`；失败保留首条请求与工作区选择并恢复输入焦点。

## 视觉契约

- 空态保留品牌标记、横向细线，并直接复用正常中控区的 Composer 外观、形状和 widget 排布；输入面与正常中控区使用同一 DOM/草稿状态，创建成功后随中控壳向下归位。
- 空态只额外挂载工作区选择、附件和乐观创建提示；模型/权限模式沿用中控区已有 widget。思考强度按 Hermes ACP 支持的 `none|minimal|low|medium|high|xhigh|max|ultra` 挂在模型名后的全角括号中（如 `deepseek-v4-flash（xhigh）`）。
- 空态不复用中控区背景材质；只隐藏会话运行态指标，保留模型、模式和操作 widget，因此不会出现第二套输入面。
- terminal-like 预设将创建面、选择器和动作按钮统一为无圆角、无阴影的安静仪器语气。
- 现代 GUI 可保留其窄范围圆角表达；这不是创建命令或数据边界。

## 兼容性、性能与可观察性

- 兼容现有 `pylon:new-session`、`pylon:pick-workspace-folder` 事件和 `createSession` command facade；空态文件选择在无 session 时使用浏览器文件选择器，入会话后继续走 ACP attach。
- 提交仅发生在用户发送时；没有轮询或额外网络请求。创建中状态由本地信号驱动。
- 错误通过空态 `role=alert` 呈现；命令参数由测试锁定，避免把视觉调整变成协议改动。

## 证据

- `src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx`：单/多工作区预选、无工作区禁用、创建参数、创建中冻结、失败保留草稿与焦点。
- `src/sheets/agent-workbench/AgentRendererSuiteWorkbench.tsx`：host command capability 仅对 `builtin.solid` 开放 `sessionCreate`。
- `src/plugins/product/packages/builtin.pylon-renderers/styles/components/solid-workbench/WorkbenchChrome.css`：共享 Composer 的空态定位、独立 surface 和 reduced-motion 回退。

## 后续

真实窗口验收时只需核对不同终端预设下输入面宽度、垂直占用和无圆角契约；不得改变创建 command 形状。
