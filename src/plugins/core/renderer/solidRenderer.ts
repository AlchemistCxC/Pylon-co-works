/**
 * core.renderer.solid —— 内置 Solid 渲染器 facade。
 *
 * 与 reactRenderer 同理：组合根导入期不加载 solid-js/web，
 * mount 时动态 import 并建立单个 Solid root；update 只推进 semantic signals。
 */
import {
  type MessageRenderProps,
  type MessageRenderer,
  type ReasoningRenderProps,
  type RenderAppearanceSnapshot,
  type RenderNodeSnapshot,
  type RenderSurface,
  type ToolRenderProps,
} from '../../../contracts/messageRenderer.ts'
import type { BuiltinPluginDefinition } from '../../../plugin-runtime/pluginRuntime.ts'
import { loadSolidMessageRendererComponent } from '../../../renderers/solid-workbench/loadSolidMessageRenderer.ts'

export const CORE_SOLID_RENDERER_PLUGIN_ID = 'core.renderer.solid'

interface SolidRenderHandle {
  container: HTMLElement
  destroyed: boolean
  ready: Promise<void>
  readyToRender?: boolean
  pendingSnapshot?: RenderNodeSnapshot
  pendingAppearance?: RenderAppearanceSnapshot
  setState?: (value: { snapshot: RenderNodeSnapshot; appearance: RenderAppearanceSnapshot }) => void
  dispose?: () => void
}

export function createSolidSurface(): RenderSurface {
  const errorListeners = new Set<(payload: unknown) => void>()
  let destroyed = false
  const emitError = (error: unknown) => {
    if (destroyed) return
    for (const listener of [...errorListeners]) listener(error)
  }
  return {
    rendererId: CORE_SOLID_RENDERER_PLUGIN_ID,
    kind: 'solid',
    mount(container, snapshot, appearance) {
      const handle: SolidRenderHandle = {
        container,
        destroyed: false,
        ready: Promise.resolve(),
        pendingSnapshot: snapshot,
        pendingAppearance: appearance,
      }
      handle.ready = (async () => {
        const [{ createSignal }, { createComponent, render: renderSolid }, SolidMessageRendererRow] = await Promise.all([
          import('solid-js'),
          import('solid-js/web'),
          loadSolidMessageRendererComponent(),
        ])
        if (handle.destroyed) return
        const [state, setState] = createSignal({
          snapshot: handle.pendingSnapshot!,
          appearance: handle.pendingAppearance!,
        })
        handle.setState = setState
        const messageProps = () => state().snapshot.payload as MessageRenderProps & { rowRef?: (node: HTMLDivElement | null) => void }
        if (!messageProps().renderMessage || !state().appearance) {
            throw new Error('Solid message renderer 需要语义 messageProps 与 appearance')
        }
        handle.dispose = renderSolid(
          () => (createComponent as (component: unknown, props: unknown) => unknown)(SolidMessageRendererRow, {
            get renderMessage() { return messageProps().renderMessage },
            get highlighted() { return messageProps().highlighted },
            get toolVisualState() { return messageProps().toolVisualState },
            get rowRef() { return messageProps().rowRef },
            get appearance() { return state().appearance as never },
          }) as never,
          container,
        )
        handle.readyToRender = true
      })().catch(emitError)
      return handle
    },
    update(handle, snapshot, appearance) {
      const value = handle as SolidRenderHandle
      value.pendingSnapshot = snapshot
      value.pendingAppearance = appearance
      if (!value.destroyed && value.readyToRender) {
        try {
          value.setState?.({ snapshot, appearance })
        } catch (error) {
          emitError(error)
        }
      }
    },
    destroy(handle) {
      const value = handle as SolidRenderHandle
      value.destroyed = true
      destroyed = true
      errorListeners.clear()
      void value.ready.then(() => {
        value.dispose?.()
        value.dispose = undefined
      })
    },
    on(event, listener) {
      if (event !== 'error') return () => {}
      errorListeners.add(listener)
      return () => errorListeners.delete(listener)
    },
  }
}

export const coreSolidMessageRenderer: MessageRenderer = {
  rendererId: CORE_SOLID_RENDERER_PLUGIN_ID,
  kind: 'solid',
  renderMessage: (_props: MessageRenderProps) => createSolidSurface(),
  renderTool: (_props: ToolRenderProps) => createSolidSurface(),
  renderReasoning: (_props: ReasoningRenderProps) => createSolidSurface(),
}

export function createCoreSolidRendererPluginDefinition(): BuiltinPluginDefinition {
  return {
    id: CORE_SOLID_RENDERER_PLUGIN_ID,
    activate: ({ renderer }) => {
      renderer.registerMessageRenderer({
        id: `${CORE_SOLID_RENDERER_PLUGIN_ID}.renderer`,
        label: 'SolidJS（实验）',
        description: '保留的候选消息渲染引擎；完整 Workbench 尚未切入生产。',
        experimental: true,
        priority: 2000,
        fallback: true,
        canRender: input => !input.rendererId || input.rendererId === CORE_SOLID_RENDERER_PLUGIN_ID,
        onError: () => 'fallback',
        renderer: coreSolidMessageRenderer,
      })
    },
  }
}
