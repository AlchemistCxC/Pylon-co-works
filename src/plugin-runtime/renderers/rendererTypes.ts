import type { MessageRenderer } from '../../contracts/messageRenderer.ts'
import type {
  AnsiProvider,
  ContentPartProvider,
  FooterProvider,
  PlanProvider,
  SpinnerProvider,
} from '../../contracts/rendererContentPoints.ts'
import type { ToolKind } from '../../domains/tool/toolKinds.ts'
import type { RendererSettingsPlacement, RendererSettingsSchema } from './rendererSettingsTypes.ts'

export type RendererFailureDecision = 'fallback' | 'rethrow'

/** 开放语义 kind：kind 是内容契约，不等同于 Renderer Suite/Slot 实现。 */
export interface RenderKindDefinition {
  readonly id: string
  readonly aliases?: readonly string[]
  readonly category: string
  readonly fallbackKind?: string
  readonly priority: number
  readonly fixture: unknown
  readonly defaultTokens: unknown
  readonly settingsSchemaVersion: number
  readonly settings?: RendererSettingsSchema
  readonly settingsPlacement?: RendererSettingsPlacement
  readonly validateInput: (input: unknown) => boolean
  readonly compatibility?: Readonly<Record<string, string>>
}

export interface RenderNode {
  readonly kind?: string
  readonly rendererId?: string
  readonly payload?: unknown
}

export interface RenderResolveContext {
  readonly rendererId?: string
  readonly category?: string
  readonly diagnostic?: (diagnostic: { code: string; message: string; kind?: string; rendererId?: string }) => void
}

export interface RendererDefinitionBase<TInput> {
  readonly id: string
  readonly label?: string
  readonly description?: string
  readonly experimental?: boolean
  readonly priority: number
  readonly fallback: boolean
  /** Optional implementation-owned settings schema; values remain host-owned. */
  readonly settings?: RendererSettingsSchema
  canRender(input: TInput): boolean
  onError?(error: unknown, input: TInput): RendererFailureDecision
}

export interface MessageRendererInput {
  readonly role?: string
  readonly rendererId?: string
  readonly payload?: unknown
  readonly context?: MessageRenderContext
}

export interface MessageRenderContext {
  readonly workspaceKind: string
  readonly workspaceMode?: 'work' | 'chat'
  readonly agentId: string
  readonly sessionId: string
}

export interface MessageRendererDefinition extends RendererDefinitionBase<MessageRendererInput> {
  readonly renderer: MessageRenderer
}

/** 内置 kind 仍有约定，但第三方可通过 namespaced id 扩展。 */
export type ContentRendererKind = string
export type ContentRendererProvider =
  | AnsiProvider
  | SpinnerProvider
  | ContentPartProvider
  | PlanProvider
  | FooterProvider

export interface ContentRendererInput {
  readonly kind: ContentRendererKind
  readonly payload?: unknown
}

export interface ContentRendererDefinition extends RendererDefinitionBase<ContentRendererInput> {
  readonly kind: ContentRendererKind
  readonly provider: ContentRendererProvider
}

export interface ToolRenderer {
  getSummary(input: unknown): string
  getSearchText?(output: unknown): string
  outputLabel?(outputLines: number, output: string): string
  isDiffCandidate?(output: string): boolean
}

export interface ToolRendererInput {
  readonly kind: ToolKind
  readonly name: string
  readonly input?: unknown
  readonly output?: string
}

export interface ToolRendererDefinition extends RendererDefinitionBase<ToolRendererInput> {
  readonly kind: ToolKind | '*'
  readonly renderer: ToolRenderer
}

export interface CodeHighlighterInput {
  readonly language: string
  readonly code: string
}

export interface CodeHighlighterDefinition extends RendererDefinitionBase<CodeHighlighterInput> {
  highlight(language: string, code: string): Promise<string | null>
}
