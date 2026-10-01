/**
 * A04：唯一 Workbench projector（**TS 活实现**）。
 *
 * 2026-09-21：投影折叠自 Rust/WASM **回退**到本文件（判决与依据见 ADR-0018 的 scope
 * 收窄）。回退理由是基准数据，不是口味：
 * - 速度：wasm 投影在现实入口（mixed flow）只有 1.12×、页级 2.08→1.92×，而合成 delta
 *   形 6.75× 的根因是 Rust 折叠本体比 TS 整条管线慢数倍/事件（数据模型问题，非边界问题）；
 * - 内存：文档必须在计算核里与 JS 里**各存一份**，同 workload 持有成本实测 4.4–6.1×，
 *   且任何微优化都碰不到它（结构成本）。
 * 合计是负收益，故回退。回退后：**文档只有一份**，没有「核就绪」这回事，也没有跨语言
 * 编组/线性内存高水位。
 *
 * 保留 wasm 的只有 markdown 解析与流式切分/揭示——那两块在同形状对照里是赢的
 * （markdown 流式形 12–25×、切分大输入 2–3×）。高亮直到 #241 也在 wasm，后因语法资产
 * 的不可归还内存而整体迁到前端 Lezer，故不在此列。
 *
 * 本文件是**读层 + 折叠层**：输入已归一化、带 sequence 的 semantic envelope，输出可丢弃的
 * WorkbenchDocument；不读时钟、store、registry 或 IO——live、restart、recovery 只要喂同一组
 * envelopes 就得到同一份 document。文档内的键序契约（`appliedRanges` 的逐字节 JSON 比较、
 * 渲染层浅比较依赖的引用稳定）在本实现下天然成立。
 *
 * #486 项2 四分布局（本文件降级为公开面门面，显式再导出，公开 API 一字不变；
 * 状态词汇常量与 ProjectionContext 等内部件不在此列）：
 * - workbenchProjectorTypes.ts——文档/节点/信封类型 + 状态词汇 + 冻结工具；
 * - workbenchProjectorReducer.ts——reduceWorkbenchEvent / projectWorkbench 双入口
 *   与全部 slice 归约器（含 #205/#234/#409 性能机械）；
 * - workbenchProjectorSelectors.ts——select* 与 toolInvocationSnapshot（C04/08/09/11/13）；
 * - workbenchProjectorDiagnostics.ts——#446 诊断预算 + #375-a timeline 载荷收窄。
 */
export type {
  ProjectionResult,
  WorkbenchActivityNode,
  WorkbenchDocument,
  WorkbenchExtensionNode,
  WorkbenchInteraction,
  WorkbenchMessage,
  WorkbenchProjectionDiagnostic,
  WorkbenchSessionSurface,
  WorkbenchTimelineEntry,
  WorkbenchTimelineKind,
} from './workbenchProjectorTypes.ts'
export { createWorkbenchDocument, freezeDeepSnapshot } from './workbenchProjectorTypes.ts'
export { projectWorkbench, reduceWorkbenchEvent } from './workbenchProjectorReducer.ts'
export type { ToolInvocationSnapshot } from './workbenchProjectorSelectors.ts'
export {
  selectActivities,
  selectActivityDisplayOrder,
  selectAssist,
  selectExtensions,
  selectGoal,
  selectInteractions,
  selectLifecycle,
  selectPendingInteractions,
  selectPlan,
  selectSessionSurface,
  selectSystemErrors,
  selectTimeline,
  toolInvocationSnapshot,
} from './workbenchProjectorSelectors.ts'
export type { WorkbenchReduceOptions } from './workbenchProjectorDiagnostics.ts'
export { setTimelinePayloadNarrowing } from './workbenchProjectorDiagnostics.ts'
