/**
 * 消息渲染契约（施工方案书 v3 §M4）：renderer.message 扩展点。
 *
 * 第一版契约以「类型 + 宿主可查询」为准，不改变 React/Solid 组件内部实现：
 * - MessageRenderer 是渲染器的可查询能力面（facade）；
 * - RenderSurface 是 mount/update/destroy/on 的命令式桥（M8 渲染管线落地后启用）；
 * - 契约层不 import React/Solid，也不 import components/，保证 contracts 纯净。
 *
 * 规则：
 * - core 渲染器插件只做 facade，主 shell 仍直接消费现有组件（旧导出保留）；
 * - 签名插件生态统一 Web Components（M11），届时新增 kind='webcomponent' 实现。
 */

/** renderer.message 扩展点 id。 */
export const MESSAGE_RENDERER_POINT = 'renderer.message'

/** 渲染器实现技术栈。 */
export type MessageRendererKind = 'react' | 'solid' | 'webcomponent' | 'unknown'

/**
 * 命令式渲染面：由 MessageRenderer.render* 返回。
 * mount 的 props 是实现层载荷；core facade 约定 `{ component, componentProps }`，
 * 宿主把现有组件（如 MessageRow / SolidMessageRow）作为 component 传入即可。
 */
export interface RenderSurface {
  readonly rendererId: string
  readonly kind: MessageRendererKind
  /** 挂载到容器；返回不透明句柄（update/destroy 原样消费）。 */
  mount(container: HTMLElement, props?: unknown): unknown
  /** 用新 props 更新已挂载句柄。 */
  update(handle: unknown, props?: unknown): void
  /** 销毁句柄并清理容器。 */
  destroy(handle: unknown): void
  /** 订阅渲染器事件；返回取消订阅函数。 */
  on(event: string, listener: (payload: unknown) => void): () => void
}

/** renderMessage 的语义 props（主壳 RenderMessage 形状见 components/chat/messageTypes.ts）。 */
export interface MessageRenderProps {
  /** 主壳渲染消息；契约层不反向依赖 components。 */
  renderMessage: unknown
  reduceMotion?: boolean
  highlighted?: boolean
  isStatic?: boolean
  toolVisualState?: unknown
}

/** renderTool 的语义 props（React/Solid 的 ToolCard 消费面差异由 facade 桥接）。 */
export interface ToolRenderProps {
  message?: unknown
  model?: unknown
  visualState?: unknown
  appearance?: unknown
}

/** renderReasoning 的语义 props。 */
export interface ReasoningRenderProps {
  text: string
  running: boolean
  startedAt?: number
  durationMs?: number
}

/**
 * 消息渲染器能力面：每个 renderer.message 贡献的 impl 实现本接口。
 * core.renderer.react / core.renderer.solid 为内置 facade；
 * render* 返回绑定到该渲染器的 RenderSurface。
 */
export interface MessageRenderer {
  readonly rendererId: string
  readonly kind: MessageRendererKind
  renderMessage(props: MessageRenderProps): RenderSurface
  renderTool(props: ToolRenderProps): RenderSurface
  renderReasoning(props: ReasoningRenderProps): RenderSurface
}

/** core facade 约定的 mount 载荷形状（实现层，不进 manifest）。 */
export interface RendererMountProps {
  component: unknown
  componentProps?: unknown
}

/** 从 mount 载荷中解析组件与组件 props（core facade 内部工具）。 */
export function resolveRendererMountProps(props: unknown): RendererMountProps {
  const value = (props ?? {}) as RendererMountProps
  if (!value || typeof value !== 'object' || !('component' in value) || !value.component) {
    throw new Error('RenderSurface.mount 需要 { component } 载荷')
  }
  return { component: value.component, componentProps: value.componentProps ?? {} }
}
