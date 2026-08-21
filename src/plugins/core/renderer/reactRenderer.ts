/**
 * core.renderer.react —— 内置 React 渲染器 facade。
 *
 * 组合根在模块导入期安装本插件，因此本文件不做 React / react-dom 顶层 import：
 * - 保持插件注册路径轻量（legacy Node 脚本会经 commandSetResolver 触达组合根）；
 * - mount 时再动态加载 React fatal fallback adapter；宿主只传 semantic snapshot。
 *
 * legacy component/componentProps 解析仅保留在 deprecated adapter API，核心 surface 不再消费。
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

export const CORE_REACT_RENDERER_PLUGIN_ID = 'core.renderer.react'

interface ReactRenderHandle {
  container: HTMLElement
  destroyed: boolean
  ready: Promise<void>
  readyToRender?: boolean
  pendingSnapshot?: RenderNodeSnapshot
  pendingAppearance?: RenderAppearanceSnapshot
  /** ready 后可用；宿主传入新 props 时重渲染。 */
  renderSnapshot?: (snapshot: RenderNodeSnapshot, appearance: RenderAppearanceSnapshot) => void
  unmount?: () => void
}

function createReactSurface(): RenderSurface {
  const errorListeners = new Set<(payload: unknown) => void>()
  const emitError = (error: unknown) => {
    for (const listener of [...errorListeners]) listener(error)
  }
  return {
    rendererId: CORE_REACT_RENDERER_PLUGIN_ID,
    kind: 'react',
    mount(container, snapshot, appearance) {
      const handle: ReactRenderHandle = {
        container,
        destroyed: false,
        ready: Promise.resolve(),
        pendingSnapshot: snapshot,
        pendingAppearance: appearance,
      }
      handle.ready = (async () => {
        const [{ createElement }, { createRoot }, { MessageRow }] = await Promise.all([
          import('react'),
          import('react-dom/client'),
          import('../../../components/chat/ChatView.tsx'),
        ])
        if (handle.destroyed) return
        const root = createRoot(container)
        handle.renderSnapshot = nextSnapshot => {
          root.render(createElement(MessageRow as never, nextSnapshot.payload as never))
        }
        handle.unmount = () => root.unmount()
        handle.readyToRender = true
        handle.renderSnapshot(handle.pendingSnapshot!, handle.pendingAppearance!)
      })().catch(emitError)
      return handle
    },
    update(handle, snapshot, appearance) {
      const value = handle as ReactRenderHandle
      value.pendingSnapshot = snapshot
      value.pendingAppearance = appearance
      if (!value.destroyed && value.readyToRender) value.renderSnapshot?.(snapshot, appearance)
    },
    destroy(handle) {
      const value = handle as ReactRenderHandle
      value.destroyed = true
      void value.ready.then(() => {
        value.unmount?.()
        errorListeners.clear()
      })
    },
    on(event, listener) {
      if (event !== 'error') return () => {}
      errorListeners.add(listener)
      return () => errorListeners.delete(listener)
    },
  }
}

export const coreReactMessageRenderer: MessageRenderer = {
  rendererId: CORE_REACT_RENDERER_PLUGIN_ID,
  kind: 'react',
  renderMessage: (_props: MessageRenderProps) => createReactSurface(),
  renderTool: (_props: ToolRenderProps) => createReactSurface(),
  renderReasoning: (_props: ReasoningRenderProps) => createReactSurface(),
}

export function createCoreReactRendererPluginDefinition(): BuiltinPluginDefinition {
  return {
    id: CORE_REACT_RENDERER_PLUGIN_ID,
    activate: ({ renderer }) => {
      renderer.registerMessageRenderer({
        id: `${CORE_REACT_RENDERER_PLUGIN_ID}.renderer`,
        label: 'React（默认）',
        description: '当前生产 AgentSheet 渲染引擎。',
        priority: 1000,
        fallback: true,
        canRender: input => !input.rendererId || input.rendererId === CORE_REACT_RENDERER_PLUGIN_ID,
        onError: () => 'fallback',
        renderer: coreReactMessageRenderer,
      })
    },
  }
}
