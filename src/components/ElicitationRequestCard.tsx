import SolidMount from '../host/SolidMount'

// P52 D4：React 类型图不得触碰 .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序），
// 实体经 eager glob 缝加载，挂载函数接口在本文件声明。
interface ElicitationRequestCardSolidModule {
  renderElicitationRequestCard(container: HTMLElement, latest: () => ElicitationRequestCardProps): () => void
}

const modules = import.meta.glob<ElicitationRequestCardSolidModule>('./ElicitationRequestCard.solid.tsx', { eager: true })
const solidModule = modules['./ElicitationRequestCard.solid.tsx']
if (!solidModule) throw new Error('ElicitationRequestCard Solid 实体未进入 Vite module graph')

// #515：schema 解析/值收集纯函数抽至 elicitationSchema.ts（框架无关，两侧共用）；
// 此处按原文件导出面等价透传（消费契约不变）。
export { parseElicitationFields, collectElicitationValues } from './elicitationSchema.ts'
export type { ElicitationField, ParsedElicitationSchema, ElicitationValues } from './elicitationSchema.ts'
import type { ElicitationValues } from './elicitationSchema.ts'

/** 与 Solid 实体（ElicitationRequestCard.solid.tsx）内声明的 props 逐字段一致。 */
interface ElicitationRequestCardProps {
  request: {
    elicitMessage?: string
    requestedSchema?: Record<string, unknown>
    elicitUrl?: string
  }
  answering: boolean
  onSubmit: (values: ElicitationValues) => void
  onDecline: () => void
  onCancel: () => void
}

/**
 * ElicitationRequestCard — ACP elicitation/create（form 模式）表单卡（#316）。
 *
 * #515：实体在 ElicitationRequestCard.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 */
export default function ElicitationRequestCard(props: ElicitationRequestCardProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderElicitationRequestCard(container, latest)} />
}
