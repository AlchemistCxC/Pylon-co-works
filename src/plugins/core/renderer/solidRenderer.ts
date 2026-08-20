/**
 * core.renderer.solid —— 内置 Solid 渲染器 facade。
 *
 * 与 reactRenderer 同理：组合根导入期不加载 solid-js/web，
 * mount/update 时动态 import，渲染宿主传入的 Solid 组件。
 * 主 shell（SolidWorkbenchApp）仍直接消费现有 Solid 组件，行为零变化。
 */
import {
  type MessageRenderProps,
  type MessageRenderer,
  type ReasoningRenderProps,
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
  pendingProps?: unknown
  /** ready 后可用；宿主传入新 props 时重渲染。 */
  renderProps?: (props: unknown) => void
  dispose?: () => void
}

interface SolidMessageMountPayload {
  messageProps?: MessageRenderProps & { rowRef?: (node: HTMLDivElement | null) => void }
  appearance?: unknown
}

function createSolidSurface(): RenderSurface {
  const errorListeners = new Set<(payload: unknown) => void>()
  const emitError = (error: unknown) => {
    for (const listener of [...errorListeners]) listener(error)
  }
  return {
    rendererId: CORE_SOLID_RENDERER_PLUGIN_ID,
    kind: 'solid',
    mount(container, props) {
      const handle: SolidRenderHandle = {
        container,
        destroyed: false,
        ready: Promise.resolve(),
        pendingProps: props,
      }
      handle.ready = (async () => {
        const [{ createComponent, render: renderSolid }, SolidMessageRendererRow] = await Promise.all([
          import('solid-js/web'),
          loadSolidMessageRendererComponent(),
        ])
        if (handle.destroyed) return
        handle.renderProps = nextProps => {
          const { messageProps, appearance } = (nextProps ?? {}) as SolidMessageMountPayload
          if (!messageProps?.renderMessage || !appearance) {
            throw new Error('Solid message renderer 需要语义 messageProps 与 appearance')
          }
          handle.dispose?.()
          handle.dispose = renderSolid(
            () => (createComponent as (component: unknown, props: unknown) => unknown)(SolidMessageRendererRow, {
              ...messageProps,
              appearance: appearance as never,
            }) as never,
            container,
          )
        }
        handle.readyToRender = true
        handle.renderProps(handle.pendingProps)
      })().catch(emitError)
      return handle
    },
    update(handle, props) {
      const value = handle as SolidRenderHandle
      value.pendingProps = props
      if (!value.destroyed && value.readyToRender) {
        try {
          value.renderProps?.(props)
        } catch (error) {
          emitError(error)
        }
      }
    },
    destroy(handle) {
      const value = handle as SolidRenderHandle
      value.destroyed = true
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
