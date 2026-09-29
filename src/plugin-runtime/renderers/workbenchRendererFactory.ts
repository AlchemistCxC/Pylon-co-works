/**
 * workbenchRendererFactory — 渲染器套件工厂契约（B-2a 自 renderers/solid-workbench/
 * workbenchContracts 上移）。归属 plugin-runtime：`RendererSuiteContribution.factory`
 * 是插件扩展面的一部分，契约不得定义在 Solid 实现文件里（依赖方向倒置，
 * layer 门禁 rendererSuiteTypes 的豁免随之消除）。实现（mountSolidWorkbench 等）
 * 仍在视图侧，经 workbenchContracts re-export 保面。
 */
import type { WorkbenchHostPort } from './workbenchHostPort.ts'
import type { RendererActivationSnapshot } from './rendererSuiteTypes.ts'

/**
 * Provider-neutral option entry used by the control-center selectors.
 *
 * ACP providers do not agree on the shape of a choice (some use `id`, some
 * use `value`, and a few return a nested `valueId`).  Keep the wire value and
 * the human label separate so the UI can be friendly without ever sending a
 * translated label back to an agent.
 */
export interface WorkbenchOptionEntry {
  readonly id: string
  readonly label: string
}

export interface WorkbenchWorkspaceOption {
  readonly id: string
  readonly label: string
  readonly path: string
  readonly lastActiveAt?: number
}

export interface WorkbenchMountInput {
  readonly sheetId: string
  readonly sessionOwnerKey: string | null
  readonly sessionId: string | null
  /**
   * #395：会话的 **provider source**（如 `local:smujxe9cc`）。文档按 source 建键
   * （`WorkbenchDocument.sessionId` 即 source），而 `sessionId` 是身份域的 `Session.id`；
   * 渲染器判「这份文档是不是本会话的」必须拿 source 比，否则判据恒假（ghost 与历史上下文全哑）。
   */
  readonly sessionSource: string | null
  readonly replayReadonly: boolean
  readonly reducedMotion: boolean
  readonly visibility: 'active' | 'background'
  readonly rightInset: number
  readonly preview: boolean
  readonly presentationProfileId?: string
  readonly sessionLabel?: string
  readonly workspaceLabel?: string
  readonly workspacePath?: string
  readonly availableWorkspaces?: readonly WorkbenchWorkspaceOption[]
  /**
   * Empty-state model candidates advertised by the sheet's owning agent
   * (its sessionConfig buckets). Host-derived plain data: the renderer
   * subtree must not import the runtime store itself.
   */
  readonly agentAdvertisedModels?: readonly WorkbenchOptionEntry[]
}

export interface RendererPrepareContext {
  readonly suiteId: string
  readonly host: WorkbenchHostPort
  readonly activation: RendererActivationSnapshot
}

export interface WorkbenchRendererFactory {
  prepare(context: RendererPrepareContext): Promise<PreparedWorkbenchRenderer>
}

export interface PreparedWorkbenchRenderer {
  mount(
    container: HTMLElement,
    input: WorkbenchMountInput,
    host: WorkbenchHostPort,
  ): Promise<WorkbenchRendererInstance> | WorkbenchRendererInstance
}

export interface WorkbenchRendererInstance {
  update(input: WorkbenchMountInput): void
  pause(): void
  resume(): void
  destroy(): void | Promise<void>
  on(event: 'ready' | 'error' | 'request-action', listener: (payload: unknown) => void): () => void
}
