import * as lucide from 'lucide'

/**
 * LucideIcon — Solid 版 lucide 图标（#279 第 3 梯队）。
 *
 * 为什么不用 lucide-solid：其 solid 条件导出（dist/source 的 JSX 源码）在 vitest/jsdom
 * 下不渲染（实测 svg 为空），且默认类名是 `lucide-icon` 而非 lucide-react 的
 * `lucide lucide-{name}`。这里直接取 **lucide 核心包的 IconNode 数据**自绘——类名与
 * lucide-react 逐类一致（`.lucide-{kebab}` 是测试与样式的消费契约），路径数据同源。
 *
 * SVG 线框属性与 lucide 官方一致：viewBox 24、fill none、currentColor 描边、圆头圆角。
 */
export function LucideIcon(props: { name: string; size?: number; strokeWidth?: number; class?: string }) {
  const kebab = props.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
  const iconNode = (lucide as unknown as Record<string, unknown>)[props.name] as
    | readonly (readonly [string, Record<string, unknown>])[]
    | undefined
  let svgElement: SVGSVGElement | undefined

  const build = (host: SVGSVGElement) => {
    const svgNamespace = 'http://www.w3.org/2000/svg'
    host.setAttribute('xmlns', svgNamespace)
    host.setAttribute('viewBox', '0 0 24 24')
    host.setAttribute('fill', 'none')
    host.setAttribute('stroke', 'currentColor')
    host.setAttribute('stroke-width', String(props.strokeWidth ?? 2))
    host.setAttribute('stroke-linecap', 'round')
    host.setAttribute('stroke-linejoin', 'round')
    if (!iconNode) return
    for (const [tag, attributes] of iconNode) {
      const child = document.createElementNS(svgNamespace, tag)
      for (const [name, value] of Object.entries(attributes)) {
        if (name === 'key') continue
        child.setAttribute(name, String(value))
      }
      host.appendChild(child)
    }
  }

  return (
    <svg
      ref={element => {
        svgElement = element
        build(element)
        void svgElement
      }}
      class={`lucide lucide-${kebab} ${props.class ?? ''}`}
      width={props.size ?? 24}
      height={props.size ?? 24}
      aria-hidden="true"
    />
  )
}
