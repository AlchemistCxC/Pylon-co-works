import SolidMount from '../host/SolidMount'

// P52 D4：React 类型图不得触碰 .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序），
// 实体经 eager glob 缝加载，挂载函数接口在本文件声明。
interface ErrorCenterSolidModule {
  renderErrorCenter(container: HTMLElement, latest: () => Record<string, never>): () => void
}

const modules = import.meta.glob<ErrorCenterSolidModule>('./ErrorCenter.solid.tsx', { eager: true })
const solidModule = modules['./ErrorCenter.solid.tsx']
if (!solidModule) throw new Error('ErrorCenter Solid 实体未进入 Vite module graph')

/**
 * 全局运行错误中心：普通 runtime/application 错误的唯一展示宿主。
 * 它是非模态 tray，不遮挡工作区；错误事实仍由 canonical/runtime/log 保留。
 *
 * #515：实体在 ErrorCenter.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 */
export default function ErrorCenter() {
  return <SolidMount initial={{}} mount={(container, latest) => solidModule.renderErrorCenter(container, latest)} />
}
