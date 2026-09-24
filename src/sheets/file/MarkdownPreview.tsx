import SolidMount from '../SolidMount'

/**
 * FileTabView markdown 文件预览（#279 第 2 梯队 Solid 化）。
 *
 * 本文件是 React 树内消费点与 Solid 实体之间的**薄桥 + 加载缝**：实体在
 * `MarkdownPreview.solid.tsx`（React 类型图不触碰 .solid 文件，P52 D4 同构，模块接口
 * 在此声明）。text 经 SolidMount 响应式通道透传——磁盘重拉/保存回执带来的内容变化
 * 即时生效。
 */

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface MarkdownPreviewSolidModule {
  renderMarkdownPreview(container: HTMLElement, latest: () => { text: string }): () => void
}

const modules = import.meta.glob<MarkdownPreviewSolidModule>('./MarkdownPreview.solid.tsx', { eager: true })
const solidModule = modules['./MarkdownPreview.solid.tsx']
if (!solidModule) throw new Error('MarkdownPreview Solid 实体未进入 Vite module graph')

export default function MarkdownPreview({ text }: { text: string }) {
  return <SolidMount initial={{ text }} mount={(container, latest) => solidModule.renderMarkdownPreview(container, latest)} />
}
