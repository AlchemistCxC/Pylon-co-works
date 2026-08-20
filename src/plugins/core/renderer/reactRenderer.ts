/**
 * core.renderer.react —— 内置 React 渲染器 facade。
 *
 * 组合根在模块导入期安装本插件，因此本文件不做 React / react-dom 顶层 import：
 * - 保持插件注册路径轻量（legacy Node 脚本会经 commandSetResolver 触达组合根）；
 * - mount/update 时再动态加载 react 与 react-dom/client，渲染宿主传入的组件。
 *
 * 行为零变化：主 shell 仍直接消费现有 React 组件；RenderSurface 仅在 M8
 * 渲染管线落地后被宿主使用。
 */
import {
  resolveRendererMountProps,
  type MessageRenderProps,
  type MessageRenderer,
  type ReasoningRenderProps,
  type RenderSurface,
  type ToolRenderProps,
} from '../../../contracts/messageRenderer.ts'
import type { BuiltinPluginDefinition } from '../../../plugin-runtime/pluginRuntime.ts'

export const CORE_REACT_RENDERER_PLUGIN_ID = 'core.renderer.react'

interface ReactRenderHandle {
  container: HTMLElement
  destroyed: boolean
  ready: Promise<void>
  /** ready 后可用；宿主传入新 props 时重渲染。 */
  renderProps?: (props: unknown) => void
  unmount?: () => void
}

function createReactSurface(): RenderSurface {
  return {
    rendererId: CORE_REACT_RENDERER_PLUGIN_ID,
    kind: 'react',
    mount(container, props) {
      const handle: ReactRenderHandle = {
        container,
        destroyed: false,
        ready: Promise.resolve(),
      }
      handle.ready = (async () => {
        const [{ createElement }, { createRoot }] = await Promise.all([
          import('react'),
          import('react-dom/client'),
        ])
        if (handle.destroyed) return
        const root = createRoot(container)
        handle.renderProps = nextProps => {
          const { component, componentProps } = resolveRendererMountProps(nextProps)
          // 动态桥：组件类型与 props 均来自宿主，运行时由 React 校验；
          // 这里绕过 createElement 的静态 props 推断。
          root.render(createElement(component as never, componentProps as never))
        }
        handle.unmount = () => root.unmount()
        handle.renderProps(props)
      })()
      return handle
    },
    update(handle, props) {
      const value = handle as ReactRenderHandle
      void value.ready.then(() => {
        if (!value.destroyed) value.renderProps?.(props)
      })
    },
    destroy(handle) {
      const value = handle as ReactRenderHandle
      value.destroyed = true
      void value.ready.then(() => {
        value.unmount?.()
      })
    },
    on() {
      return () => {}
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
