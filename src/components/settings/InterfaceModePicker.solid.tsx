/** @jsxImportSource solid-js */
import { createMemo, For } from 'solid-js'

import type { IconNode } from 'lucide'
import { Layers3, PanelsTopLeft, Terminal } from 'lucide'
import { activateInterfaceMode, interfaceModeIsUsable } from '../../application/transactions/activateInterfaceMode.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { getInterfaceModeRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { createZustandSignal } from '../../host/solidStoreBridge.ts'

export interface InterfaceModePickerProps {}

/** lucide-react 同源路径数据的本地图标渲染（svg 形态与 lucide-react 输出一致：
 *  `.lucide lucide-{kebab}` 类名 + stroke 属性；#515 Solid 实体不进 react 图）。 */
function LucideSvg(props: { node: IconNode; name: string; size: number }) {
  // Invariance 豁免（显式）：props.name 挂载后不变——调用点均随 For 行重挂，name 变化即换
  // 实例；kebab 顶层捕获（非响应式读）是有意为之，不按响应式访问器改写。
  const kebab = props.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
  const build = (host: SVGSVGElement) => {
    const svgNamespace = 'http://www.w3.org/2000/svg'
    host.setAttribute('xmlns', svgNamespace)
    host.setAttribute('viewBox', '0 0 24 24')
    host.setAttribute('fill', 'none')
    host.setAttribute('stroke', 'currentColor')
    host.setAttribute('stroke-width', '2')
    host.setAttribute('stroke-linecap', 'round')
    host.setAttribute('stroke-linejoin', 'round')
    for (const [tag, attributes] of props.node) {
      const child = document.createElementNS(svgNamespace, tag)
      for (const [name, value] of Object.entries(attributes)) {
        if (name === 'key') continue
        child.setAttribute(name, String(value))
      }
      host.appendChild(child)
    }
  }
  return <svg ref={build} class={`lucide lucide-${kebab}`} width={props.size} height={props.size} />
}

/** #515：InterfaceModePicker 的 Solid 实体（原 .tsx 为 React 薄桥）。 */
export default function InterfaceModePicker() {
  const activeMode = createZustandSignal(useInterfaceModeStore, s => s.interfaceMode)
  const registry = getInterfaceModeRegistry()
  const snapshot = createZustandSignal(
    { getState: () => registry.getSnapshot(), subscribe: listener => registry.subscribe(() => listener(registry.getSnapshot())) },
    // registry 的 subscribe 回调不传快照，selector 自取（zustand 形态的 subscribe 才带 state）。
    () => registry.getSnapshot(),
  )
  const modes = createMemo(() => snapshot().entries)
  const iconFor = (icon?: string): { node: IconNode; name: string } =>
    icon === 'panels' ? { node: PanelsTopLeft, name: 'PanelsTopLeft' }
      : icon === 'terminal' ? { node: Terminal, name: 'Terminal' }
        : { node: Layers3, name: 'Layers3' }

  return (
    <div class="interface-mode-grid" role="radiogroup" aria-label="界面模式">
      <For each={modes()}>{entry => {
        const { id, label, description, icon } = entry.value
        const usable = interfaceModeIsUsable(entry.value)
        const glyph = iconFor(icon)
        return (
          <button type="button" role="radio" aria-checked={activeMode() === id}
            disabled={!usable}
            data-interface-mode-owner={entry.ownerPluginId}
            class={`interface-mode-card${activeMode() === id ? ' active' : ''}`}
            onClick={() => activateInterfaceMode(id)}>
            <span class="interface-mode-icon" aria-hidden="true"><LucideSvg node={glyph.node} name={glyph.name} size={20} /></span>
            <span><strong>{label}</strong><small>{usable ? description : `${description ?? ''} · 依赖的 Surface 未激活`}</small></span>
          </button>
        )
      }}</For>
    </div>
  )
}
