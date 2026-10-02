import SolidMount from '../../host/SolidMount'

// P52 D4：React 类型图不得触碰 .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序），
// 实体经 eager glob 缝加载，挂载函数接口在本文件声明。
interface SelectSolidModule {
  renderSelect(container: HTMLElement, latest: () => SelectProps): () => void
}

const modules = import.meta.glob<SelectSolidModule>('./Select.solid.tsx', { eager: true })
const solidModule = modules['./Select.solid.tsx']
if (!solidModule) throw new Error('Select Solid 实体未进入 Vite module graph')

/** 与 Solid 实体（ui/Select.solid.tsx）内声明的 SelectOption 逐字段一致。 */
export interface SelectOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

/** 与 Solid 实体（ui/Select.solid.tsx）内声明的 SelectProps 逐字段一致。 */
interface SelectProps {
  value: string
  options: readonly SelectOption[]
  onChange(value: string): void
  id?: string
  className?: string
  disabled?: boolean
  ariaLabel?: string
}

/**
 * 无状态值语义的可访问 Select；弹层与滚动容器解耦，业务状态仍由调用方所有。
 *
 * #515：radix 选择器已由手写最小 Solid 等价替代（指南 §3），实体在 ui/Select.solid.tsx，
 * 本文件是 React 世界薄桥（批7 拆除）——原 settings/ 域的本地 Solid 副本已收拢进实体。
 */
export default function Select(props: SelectProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderSelect(container, latest)} />
}
