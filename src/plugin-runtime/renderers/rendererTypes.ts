import type { MessageRenderer } from '../../contracts/messageRenderer.ts'
import type {
  AnsiProvider,
  ContentPartProvider,
  FooterProvider,
  PlanProvider,
  SpinnerProvider,
} from '../../contracts/rendererContentPoints.ts'
import type { ToolKind } from '../../domains/tool/toolKinds.ts'

export type RendererFailureDecision = 'fallback' | 'rethrow'

export interface RendererDefinitionBase<TInput> {
  readonly id: string
  readonly label?: string
  readonly description?: string
  readonly experimental?: boolean
  readonly priority: number
  readonly fallback: boolean
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

export type ContentRendererKind = 'ansi' | 'spinner' | 'content-part' | 'plan' | 'footer'
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
