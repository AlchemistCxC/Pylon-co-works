# Dev Record — #253/#254/#255 实机验收问题三项修复

> 2026-09-23 实机验收（webview2 MCP）发现项的修复轮。#253 根因链、#254/#255 核查结论
> 见各 issue；本条记录修复内容、决策依据与验证证据。

## 元信息

- issue：#253（搜索 sender 元数据泄漏）、#254（Fleet 卡区分维度）、#255（工作区会话数双口径）
- 分支：`kumo/prometheus`（用户裁定更名前缀；含 main 合入 6f9011b0）
- 基准提交：`25cef7bb`（main）+ merge `6f9011b0`
- 决策记录：#253 方案①+②打包、#255 方向 c——均为用户 AskUserQuestion 拍板

## #253 搜索 sender 元数据（方案①+②）

**① 索引层** `src/components/chat/messageSearchIndex.ts`：`getMessageSearchText` 拼接数组移除
`message.sender`。内部 owner 键（`local:{id}`）与角色标签不再进入搜索文本与片段。

**② 投影层** `src/domains/events/messageProjectionRules.ts`：
- user 行 `sender: event.owner.localSessionId` → `'user'`
- assistant/reasoning 行 `sender: 'peri'`（Peri 单 Agent 时代硬编码）→ `'assistant'`

与 `messagePersistence.ts:239` 的快照 sender 约定（`'user'/'assistant'`）对齐；Agent 归属由
消息的 `agentId` 字段承载，不损失信息。消费方核查：`messageTypes.ts:89` 仅认 `'system'`；
`toolPresentationModel` 仅处理 `tool:*`；`chatReplayTrace` 指纹为诊断用（默认关闭）；
`workbenchRuntime.documentFromLegacy` 的 `source.provider` 为运行时派生值——均不受值域变化影响。

**测试**：`messageSearchIndex.test.ts` 新增「sender 不参与搜索匹配」断言（`local:`、
`smu99oxqx`、`assistant` 均不可命中，内容词仍命中）。

## #254 Fleet 卡区分维度

`src/sheets/OverviewSheetView.tsx:329`：卡副标题第一段 `{agent.provider || agent.transport || 'ACP'}`
→ `{agent.id}`。同名 Agent（agents.yaml 的 `hermes`/`hermes-2`）两卡可辨，与「打开 Sheet」
面板 Agent 卡（副标题即 id）口径一致。点击/状态逻辑零改动。

## #255 工作区卡双口径（方向 c）

**真相更正**（修正 #255 issue 正文与验收报告的表述）：左栏树的分组键**不是 cwd**——
`useSidebarContributionProps.ts` 的 `ownSessions` = `workspaceId` 匹配 + **当前 ProfileId +
当前 AgentId + 未归档** 过滤（ADR-0011 的「按 cwd 分组」是历史称谓）。两处数字分歧的
真实成因是**会话 scoping**：Overview 卡计全部 profile/agent（含归档），树只计当前
Profile+Agent 的未归档会话。

实现（方向 c）：工作区卡并列标注两个数字——`N 关联 · M 当前`（tooltip 说明两口径，
「与左栏树一致」指向 M）；两数一致时退回单数字 `N 会话`（对既有「1 会话」断言与单
工作区场景零噪音）。

## 测试处置

- 新增：`messageSearchIndex.test.ts` ×1（sender 排除）；`OverviewSheetView.visual.test.tsx`
  ×2（#254 同名卡 id 区分；#255 双口径分叉标注 + 等值退回单数字由既有「1 会话」断言覆盖）
- 修改既有：`OverviewSheetView.visual.test.tsx` beforeEach 夹具 `profileId: 'profile-a'` →
  `'default'`——双口径下夹具需与 store 默认 activeProfileId 一致，非行为断言变更
- **门禁：全量 vitest 4707 passed / 0 failed（626 文件）**；eslint 改动文件 0 告警

## 影响面与遗留

- 搜索：跨会话搜索与右栏「搜索消息」不再能按 sender 关键词命中（元数据维度，内容匹配
  不变）——这正是修复目的。
- 聊天显示：主题 `appearance.userName` 优先级高于 sender，本实例（自定义主题）用户行
  标签不变；未设 userName 的实例用户行标签由 `local:{id}` 截尾变为 `user`（更准确）。
- 实机复验：本机构建为 9/22 产物，未重构建实机走查；DOM 级断言由 testing-library 承担，
  实机复验随下次构建/CI 进行。
