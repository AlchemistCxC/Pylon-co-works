import SolidMount from '../../host/SolidMount'
import type { RightRailHostProps } from './rightPanelTypes.ts'

// P52 D4：React 类型图不得触碰 .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序），
// 实体经 eager glob 缝加载，挂载函数接口在本文件声明。
interface RightRailHostSolidModule {
  renderRightRailHost(container: HTMLElement, latest: () => RightRailHostProps): () => void
}

const modules = import.meta.glob<RightRailHostSolidModule>('./RightRailHost.solid.tsx', { eager: true })
const solidModule = modules['./RightRailHost.solid.tsx']
if (!solidModule) throw new Error('RightRailHost Solid 实体未进入 Vite module graph')

/**
 * Application-level right rail host. Sheet context is input only; the rail
 * itself stays mounted while navigating between Sheets.
 *
 * #515：实体在 RightRailHost.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 */
export default function RightRailHost(props: RightRailHostProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderRightRailHost(container, latest)} />
}
