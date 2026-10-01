import SolidMount from '../host/SolidMount'

// P52 D4：React 类型图不得触碰 .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序），
// 实体经 eager glob 缝加载，挂载函数接口在本文件声明。
interface ColorPopoverSolidModule {
  renderColorPopover(container: HTMLElement, latest: () => ColorPopoverProps): () => void
}

const modules = import.meta.glob<ColorPopoverSolidModule>('./ColorPopover.solid.tsx', { eager: true })
const solidModule = modules['./ColorPopover.solid.tsx']
if (!solidModule) throw new Error('ColorPopover Solid 实体未进入 Vite module graph')

/** 与 Solid 实体（ColorPopover.solid.tsx）内声明的 ColorChoice 逐字段一致。 */
export interface ColorChoice {
  readonly value: string
  readonly label?: string
  readonly disabled?: boolean
}

/** 与 Solid 实体（ColorPopover.solid.tsx）内声明的 Props 逐字段一致。 */
interface ColorPopoverProps {
  value: string
  onChange: (value: string) => void
  /** false = 直接原生取色器，不弹预设板（紧凑场景用） */
  chips?: boolean
  /** 字段级候选色；插件设置选项贡献不修改全局色板。 */
  palette?: readonly ColorChoice[]
  /** 可继承的宿主语义色。仅由确认支持 CSS token 的 owner 传入。 */
  semanticTokens?: readonly ColorChoice[]
  /** 允许编辑 alpha。CSS token 的 alpha 由 token owner 控制。 */
  allowAlpha?: boolean
  /** 字段语义标签（渲染器设置按字段命名触发按钮，供 label 关联与读屏）。 */
  ariaLabel?: string
  /** palette presentation is selection-only; picker/palette+picker may edit. */
  allowCustom?: boolean
}

/**
 * ColorPopover — 颜色选择器（预设板 + 原生取色器 + alpha）。
 *
 * #515：实体在 ColorPopover.solid.tsx，本文件是 React 世界薄桥（批7 拆除）——
 * 原 settings/ 域的本地 Solid 副本已收拢进实体，不再养两份实现。
 */
export default function ColorPopover(props: ColorPopoverProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderColorPopover(container, latest)} />
}
