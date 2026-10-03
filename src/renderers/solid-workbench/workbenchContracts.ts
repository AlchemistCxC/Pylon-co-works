import type { WorkbenchAppearanceStore } from '../../domains/appearance/appearance.ts'
import type { SessionUiStore } from '../../domains/workbench/sessionUiStore.ts'
import type { WorkbenchCommandFacade } from '../../domains/workbench/workbenchCommandFacade.ts'
import type { WorkbenchSessionCreationReader } from '../../domains/workbench/workbenchCommandFacade.ts'
import type { WorkbenchRuntime } from '../../domains/workbench/workbenchRuntime.ts'
import type { WorkbenchHostPort } from '../../plugin-runtime/renderers/workbenchHostPort.ts'
import type { InputPredictionProvider } from '../../infrastructure/prediction/inputPredictionProvider.ts'
import type { WorkbenchOptionEntry, WorkbenchMountInput, WorkbenchWorkspaceOption } from '../../plugin-runtime/renderers/workbenchRendererFactory.ts'

/**
 * B-2a：WorkbenchHostPort 与渲染器工厂契约族（WorkbenchRendererFactory /
 * PreparedWorkbenchRenderer / WorkbenchRendererInstance / RendererPrepareContext /
 * WorkbenchMountInput / WorkbenchWorkspaceOption / WorkbenchOptionEntry）已上移
 * plugin-runtime（契约归扩展面所有，依赖方向单向：视图实现 → plugin-runtime 契约）。
 * 本文件保留视图侧专有形状（SolidWorkbenchServices / 输入归一化 / lifecycle），并
 * re-export 契约维持既有消费面 import 路径零改动。
 */
export type {
  WorkbenchHostPort,
  WorkbenchCommandPort,
  WorkbenchCommandResult,
  WorkbenchCommandError,
  WorkbenchDocumentReader,
  WorkbenchGenerationReader,
  ResolvedAppearanceReader,
  SessionUiPort,
  WorkbenchCapabilityReader,
  RendererDiagnosticPort,
} from '../../plugin-runtime/renderers/workbenchHostPort.ts'
export type {
  RendererPrepareContext,
  WorkbenchRendererFactory,
  PreparedWorkbenchRenderer,
  WorkbenchRendererInstance,
  WorkbenchMountInput,
  WorkbenchWorkspaceOption,
  WorkbenchOptionEntry,
} from '../../plugin-runtime/renderers/workbenchRendererFactory.ts'

export interface SolidWorkbenchServices {
  runtime: WorkbenchRuntime
  appearance: WorkbenchAppearanceStore
  sessionUi: SessionUiStore
  commands: WorkbenchCommandFacade
  /** Optional display-only empty-state creation lifecycle. */
  sessionCreation?: WorkbenchSessionCreationReader
  /** Stable framework-neutral seam consumed by Suite adapters. */
  hostPort?: WorkbenchHostPort
  /** Optional host-owned local/remote provider for low-frequency input prediction. */
  predictionProvider?: InputPredictionProvider
}

export interface SolidWorkbenchInput {
  sheetId: string
  sessionId: string | null
  /** #395：见 `WorkbenchMountInput.sessionSource`。缺省（undefined/null）时不收紧文档判据。 */
  sessionSource?: string | null
  replayReadonly?: boolean
  rightInset?: number
  preview?: boolean
  reducedMotion?: boolean
  sessionOwnerKey?: string | null
  visibility?: 'active' | 'background'
  presentationProfileId?: string
  sessionLabel?: string
  workspaceLabel?: string
  workspacePath?: string
  availableWorkspaces?: readonly WorkbenchWorkspaceOption[]
  agentAdvertisedModels?: readonly WorkbenchOptionEntry[]
  /** 见 `WorkbenchMountInput.bindingHint`（宿主派生纯数据）。 */
  bindingHint?: { readonly text: string; readonly error: boolean }
}

export function normalizeWorkbenchMountInput(input: SolidWorkbenchInput): WorkbenchMountInput {
  return Object.freeze({
    sheetId: input.sheetId,
    sessionOwnerKey: input.sessionOwnerKey ?? null,
    sessionId: input.sessionId,
    sessionSource: input.sessionSource ?? null,
    replayReadonly: input.replayReadonly === true,
    reducedMotion: input.reducedMotion === true,
    visibility: input.visibility ?? 'active',
    rightInset: Math.max(0, input.rightInset ?? 0),
    preview: input.preview === true,
    ...(input.presentationProfileId ? { presentationProfileId: input.presentationProfileId } : {}),
    ...(input.sessionLabel ? { sessionLabel: input.sessionLabel } : {}),
    ...(input.workspaceLabel ? { workspaceLabel: input.workspaceLabel } : {}),
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    ...(input.availableWorkspaces ? { availableWorkspaces: Object.freeze(input.availableWorkspaces.map(item => Object.freeze({ ...item }))) } : {}),
    ...(input.agentAdvertisedModels ? { agentAdvertisedModels: Object.freeze(input.agentAdvertisedModels.map(item => Object.freeze({ ...item }))) } : {}),
    ...(input.bindingHint ? { bindingHint: Object.freeze({ ...input.bindingHint }) } : {}),
  })
}

export interface SolidWorkbenchLifecycle {
  update(input: SolidWorkbenchInput): void
  pause(): void
  resume(): void
  destroy(): void | Promise<void>
  on(event: 'ready' | 'error' | 'request-action', listener: (payload: unknown) => void): () => void
}

export interface SolidWorkbenchMountInput {
  host: HTMLElement
  input: SolidWorkbenchInput
  services: SolidWorkbenchServices
  hostPort?: WorkbenchHostPort
}
