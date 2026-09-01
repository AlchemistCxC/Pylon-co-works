# Hermes 工具解析与空态创建施工书

## 范围

- P17：Hermes `skill_view` 内容/工具卡不应落入 unknown，工具指示器与浏览器预览沿用同一聊天字号契约。
- P18：Hermes 的 `search`/`search_files` 标题和结果应归一为 search 语义。
- P19：空态首条消息提交后，在会话创建 RPC 返回前显示乐观用户消息；失败时撤销投影并保留草稿。
- P20：工具运行期间，生成指示器次级文案只显示工具类型；流式参数与并行工具顺序变化不得造成文案集合闪动，聊天指示器 glyph 与设置预览保持同字号契约。

## 事实证据

Hermes `acp_adapter.tools` 的真实构造结果：

- `ToolCallStart` 只有 `title`、`kind`、`tool_call_id`，机器工具名不会出现在 ACP start 更新中；例如 `skill view (diagnose/SKILL.md)`、`search: needle`。
- 工具内容块序列化为 `{ type: "content", content: { type: "text", text: "..." } }`。
- 完成更新通常不重复 title/name，只带 `tool_call_id`、`status`、`content`。

## 实施约束

1. 在 Hermes normalizer seam 恢复标题到机器名（不修改 provider 原始 raw）。
2. ACP content wrapper 只解包一次语义层；未知字段仍保留 raw/诊断，不让 renderer 读取 provider wire。
3. 完成更新缺失机器名时不得伪造 `unknown` 覆盖已启动工具；按 `toolCallId` 合并。
4. 搜索结果兼容 Hermes 的 `matches/files + path/line/content`，统一为 `search-result` ContentPart。
5. 乐观空态只在本地 UI 投影，创建失败立即回滚；不写入持久化 transcript。
6. 指示器显式继承聊天 rail 字号/行高，避免 renderer slot 与设置预览出现缩放漂移。
7. 工具活动标题在进入 Footer 前剥离命令/查询参数，并对并行工具类型集合排序去重；主文案状态机不因次级上下文变化重置驻留计时。

## 回归与观察

- `hermesNormalizer.test.ts`：title-only、snake_case、content wrapper、completion identity。
- `searchLinkClassification.test.ts`：Hermes path-based search matches。
- `mountSolidWorkbench.solid.test.tsx`：创建中状态与失败恢复。
- `generationStateMachine.test.ts`、`GenerationFooter.solid.test.tsx`：工具类型集合稳定化与参数变更不闪动。
- `npm.cmd run check:solid`：边界、主题和渲染器架构门禁。

真实 Hermes ACP 窗口验收仍可在后续阶段使用同一组 trace 复核；本片不改变 ACP server 或工具执行逻辑。
