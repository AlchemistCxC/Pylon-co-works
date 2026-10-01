import SolidMount from '../../host/SolidMount'
import type { RefObject } from 'react'
import type { BrowserSnapshot } from './browserSheetTypes.ts'

/** 与 Solid 实体（BrowserViewport.solid.tsx）内声明的 BrowserViewportProps 逐字段一致。 */
export interface BrowserViewportProps {
  viewportRef: RefObject<HTMLDivElement | null>
  browserPreview: boolean
  snapshot: BrowserSnapshot
  previewRevision: number
  onStart: () => void
}

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface BrowserViewportSolidModule {
  mountBrowserViewport: (container: HTMLElement, latest: () => BrowserViewportProps) => () => void
}

const modules = import.meta.glob<BrowserViewportSolidModule>('./BrowserViewport.solid.tsx', { eager: true })
const solidModule = modules['./BrowserViewport.solid.tsx']
if (!solidModule) throw new Error('BrowserViewport Solid 实体未进入 Vite module graph')

/** 预览 iframe 与未启动空态共用的 viewport 容器（#228 批次 D 纯搬移）。
 * `viewportRef` 仍归属主组件——bounds 同步、启动定位都读这个节点。
 * #515：实体在 BrowserViewport.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。 */
export function BrowserViewport(props: BrowserViewportProps) {
  return <SolidMount initial={props} mount={solidModule.mountBrowserViewport} />
}
