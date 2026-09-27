# ADR-0023 前端 shell 逐梯队 Solid 化(第 0~3 梯队)

> 入库保留。编号顺延,按编号命名。
> 产出路径:`.agents/decisions/0023-frontend-shell-staged-solidification.md`

- **日期**:2026-09-24
- **状态**:已采用(用户裁决「做到第三梯队」,经 #278/#279 前置讨论:高性能轴已见底、表现力轴维持克制美学、插件契约框架中立)
- **议题**:issue #279

## 问题与约束

React 宿主 + Solid 渲染器套件的双框架过渡态产生持续性边界税(R1/边界门禁/solid-smoke 排除/双测试环境)。React VDOM 模型在本仓有 #71 级失败记录;性能敏感面已由 Solid 承担。约束:行为契约(DOM 形状/几何契约/sheet kind/keep-alive/插件 mount)不变;编排留 JS(ADR-0018);插件契约框架中立不钉死宿主框架。

## 备选方案

| 方案 | 结论 |
| --- | --- |
| 收敛 Solid(本决策) | 迁移组件壳,逻辑层已框架中立;删整类边界机械;细粒度响应匹配长列表+流式+keep-alive 形态 |
| 维持 React 双框架 | 零迁移成本,但把 73 文件渲染器套件回迁 React 不可行(流式/虚拟化正打 VDOM 短板),税永久化 |
| 第三框架(Svelte/Vue/Leptos/Preact) | 三框架严格劣化;Leptos 另有 wasm↔DOM 边界税与 ADR-0018 修订 1 判据不符 |

## 决定

窒息式迁移,叶→根,每梯队一个可回滚提交单元;React 薄桥(SolidMount)+ `.solid.tsx` 实体,sheet 注册表与插件契约零改动:

- 第 0:删 chat 孤儿 React 组件(零消费者,勿迁死码)
- 第 1:solid 编译模式扩展至 sheets + SolidMount 桥 + SearchSheetView/HistorySheetView 迁移
- 第 2:文件工作台内容面(FileTabView 等)Solid 化
- 第 3:shell chrome(Titlebar/TabStrip/ResizeHandle/WorkspaceMenu/SheetLauncher)Solid 化

第 4(设置页 radix 区)/第 5(宿主根+删 react 依赖)梯队显式留待后续,不在本轮。

## 后果与状态

- **当前事实**:门禁税在 React 归零前不减,本轮收益是势能+bundle+死代码出清;梯队间以提交为回滚边界。
- **待实施**:radix/cmdk/motion 的 Solid 等价(Kobalte/Ark UI/motionone)在第 4 梯队选型;react 依赖删除在第 5 梯队。
- **已验证**:验收以「被迁移组件的 DOM 断言在 solid-dom 项目等价存在(改写逐条登记)」+ 全量门禁绿为准。
