# Dev Record — assistant markdown fractured wrapping

## 元信息
- issue：用户反馈：工具表格后正文及思考块出现少字符换行
- 分支：当前工作分支
- 日期：2026-09-14

## 目标与范围
保证带助手标记的正文列在终端、气泡、classic、claude 等布局下均保持可用宽度，避免内容塌缩到标记列。

## 改动清单

| 文件 | 大致范围 | 性质 |
| --- | --- | --- |
| `ChatView.css` | `.term-assistant-body` 宽度规则 | 修改 |
| `ChatView.css.test.ts` | 正文宽度契约 | 修改 |

## 方案要点
移除按 `data-message-layout` 设置 `flex-basis:0; width:0` 的脆弱覆盖，统一使用 `flex:1 1 auto; width:auto; max-width:100%`。该规则同时适用于流式和最终 Markdown，思考块继续使用已有 `width:100%; min-width:0` 约束。

## 验收标准与结果
| 验收项 | 结果 |
| --- | --- |
| 助手正文不再存在 classic 零宽覆盖 | 通过 |
| CSS 契约测试 | 29 passed |

## 测试处置
- 更新 `assistant body width contract`，断言统一 auto basis/width，并拒绝 classic 零宽规则。

## 证据
- `cmd /c npm exec vitest run src/renderers/solid-workbench/chat/__tests__/ChatView.css.test.ts`：退出码 0，29 tests passed。
- 历史提交 `8261558c` 的浏览器测量确认零宽规则会产生 91 行碎裂；本次移除该覆盖，扩大修复适用组合。

## 未决问题
未在真实桌面运行 ACP 流式会话；需发布前用用户复现步骤确认工具表格后正文和思考尾部均保持正常行宽。
