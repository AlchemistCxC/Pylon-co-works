import { createPluginIdentity, type PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistryEntry } from '../registry/types.ts'
import type {
  CodeHighlighterDefinition,
  CodeHighlighterInput,
  ContentRendererDefinition,
  ContentRendererInput,
  MessageRendererDefinition,
  MessageRendererInput,
  RendererDefinitionBase,
  ToolRendererDefinition,
  ToolRendererInput,
  RenderKindDefinition,
  RenderNode,
  RenderResolveContext,
} from './rendererTypes.ts'
import { notifyRegistryListener } from '../registry/registryBatch.ts'

export interface RendererRegistryTransaction {
  registerRenderKind(definition: RenderKindDefinition): AsyncDisposable
  registerSolidRenderer(definition: MessageRendererDefinition): AsyncDisposable
  registerMessageRenderer(definition: MessageRendererDefinition): AsyncDisposable
  registerContentRenderer(definition: ContentRendererDefinition): AsyncDisposable
  registerToolRenderer(definition: ToolRendererDefinition): AsyncDisposable
  registerCodeHighlighter(definition: CodeHighlighterDefinition): AsyncDisposable
  validate(): void
  commit(): void
  rollback(): void
  revert(): void
}

export interface RendererRegistrySnapshot {
  readonly revision: number
  readonly renderKinds: readonly RegistryEntry<RenderKindDefinition>[]
  readonly messageRenderers: readonly RegistryEntry<MessageRendererDefinition>[]
  readonly contentRenderers: readonly RegistryEntry<ContentRendererDefinition>[]
  readonly toolRenderers: readonly RegistryEntry<ToolRendererDefinition>[]
  readonly codeHighlighters: readonly RegistryEntry<CodeHighlighterDefinition>[]
}

export interface ResolvedRenderer {
  readonly kind: string
  readonly rendererId?: string
  readonly renderer?: RegistryEntry<MessageRendererDefinition | ContentRendererDefinition | ToolRendererDefinition | CodeHighlighterDefinition>
  readonly fallback: boolean
  readonly diagnostics: readonly { code: string; message: string; kind?: string; rendererId?: string }[]
}

export interface RenderCatalogSnapshot extends RendererRegistrySnapshot {}

function validateDefinition<TInput>(definition: RendererDefinitionBase<TInput>): void {
  if (!definition.id) throw new Error('Renderer id 不能为空')
  if (!Number.isFinite(definition.priority)) throw new Error(`Renderer priority 无效：${definition.id}`)
  if (typeof definition.fallback !== 'boolean') throw new Error(`Renderer fallback 必须显式声明：${definition.id}`)
  if (typeof definition.canRender !== 'function') throw new Error(`Renderer canRender 缺失：${definition.id}`)
}

function freezeRenderKind(definition: RenderKindDefinition): RenderKindDefinition {
  const freeze = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    return Object.freeze(value)
  }
  return Object.freeze({
    ...definition,
    ...(definition.aliases ? { aliases: Object.freeze([...definition.aliases]) } : {}),
    fixture: freeze(definition.fixture),
    defaultTokens: freeze(definition.defaultTokens),
    ...(definition.compatibility ? { compatibility: freeze({ ...definition.compatibility }) as Readonly<Record<string, string>> } : {}),
  })
}

function validateRenderKind(
  definition: RenderKindDefinition,
  existing: readonly RegistryEntry<RenderKindDefinition>[],
  allowMissingFallback = false,
  checkDuplicate = true,
): void {
  if (!definition.id.trim()) throw new Error('RenderKind id 不能为空')
  if (!definition.id.includes('.')) throw new Error(`RenderKind id 必须是 namespaced：${definition.id}`)
  if (!definition.category.trim()) throw new Error(`RenderKind category 不能为空：${definition.id}`)
  if (definition.aliases?.some(alias => !alias.trim() || alias.includes(' '))) throw new Error(`RenderKind aliases 非法：${definition.id}`)
  if (definition.id !== 'content.unknown' && !definition.fallbackKind) throw new Error(`RenderKind fallbackKind 缺失：${definition.id}`)
  if (!Number.isFinite(definition.priority)) throw new Error(`RenderKind priority 无效：${definition.id}`)
  if (!Number.isInteger(definition.settingsSchemaVersion) || definition.settingsSchemaVersion < 1) throw new Error(`RenderKind settingsSchemaVersion 无效：${definition.id}`)
  if (typeof definition.validateInput !== 'function') throw new Error(`RenderKind validateInput 缺失：${definition.id}`)
  if (definition.fallbackKind === definition.id) throw new Error(`RenderKind fallbackKind 自引用：${definition.id}`)
  if (checkDuplicate && existing.some(entry => entry.value.id === definition.id)) throw new Error(`RenderKind id 重复：${definition.id}`)
  if (!allowMissingFallback && definition.fallbackKind && !existing.some(entry => entry.value.id === definition.fallbackKind)) throw new Error(`RenderKind fallbackKind 未注册：${definition.id} -> ${definition.fallbackKind}`)
  const byId = new Map(existing.map(entry => [entry.value.id, entry.value]))
  byId.set(definition.id, definition)
  const seen = new Set<string>()
  const walk = (id: string) => {
    if (seen.has(id)) throw new Error(`RenderKind fallback chain 成环：${id}`)
    seen.add(id)
    const current = byId.get(id)
    if (current?.fallbackKind) walk(current.fallbackKind)
    seen.delete(id)
  }
  walk(definition.id)
}

function select<TInput, TDefinition extends RendererDefinitionBase<TInput>>(
  entries: readonly RegistryEntry<TDefinition>[],
  input: TInput,
): RegistryEntry<TDefinition> | undefined {
  const capable: RegistryEntry<TDefinition>[] = []
  for (const entry of entries) {
    try {
      if (entry.value.canRender(input)) capable.push(entry)
    } catch (error) {
      if (entry.value.onError?.(error, input) === 'rethrow') throw error
    }
  }
  return capable.find(entry => !entry.value.fallback) ?? capable.find(entry => entry.value.fallback)
}

export class RendererRegistry {
  private readonly kinds = new ReactiveRegistryStore<RenderKindDefinition>()
  private readonly messages = new ReactiveRegistryStore<MessageRendererDefinition>()
  private readonly contents = new ReactiveRegistryStore<ContentRendererDefinition>()
  private readonly tools = new ReactiveRegistryStore<ToolRendererDefinition>()
  private readonly highlighters = new ReactiveRegistryStore<CodeHighlighterDefinition>()
  private readonly listeners = new Set<() => void>()
  private revision = 0
  private batchDepth = 0
  private publishQueued = false
  private snapshotValue: RendererRegistrySnapshot = Object.freeze({
    revision: 0,
    renderKinds: Object.freeze([]),
    messageRenderers: Object.freeze([]),
    contentRenderers: Object.freeze([]),
    toolRenderers: Object.freeze([]),
    codeHighlighters: Object.freeze([]),
  })

  constructor() {
    const publish = () => this.publish()
    this.kinds.subscribe(publish)
    this.messages.subscribe(publish)
    this.contents.subscribe(publish)
    this.tools.subscribe(publish)
    this.highlighters.subscribe(publish)
    const owner = createPluginIdentity('core.renderer.catalog', 'builtin')
    this.kinds.register(owner, Object.freeze({
      id: 'content.unknown', category: 'content', priority: 10000,
      fixture: { raw: true }, defaultTokens: {}, settingsSchemaVersion: 1,
      validateInput: () => true,
    }), { contributionId: 'content.unknown', layer: 'platform', priority: 10000 })
  }

  registerRenderKind(owner: PluginIdentity, definition: RenderKindDefinition): AsyncDisposable {
    validateRenderKind(definition, this.snapshotValue.renderKinds)
    return this.kinds.register(owner, freezeRenderKind(definition), {
      contributionId: definition.id,
      priority: definition.priority,
    })
  }

  registerSolidRenderer(owner: PluginIdentity, definition: MessageRendererDefinition): AsyncDisposable {
    if (definition.renderer.kind !== 'solid') throw new Error(`Solid renderer kind 非法：${definition.id}`)
    return this.registerMessageRenderer(owner, definition)
  }

  registerMessageRenderer(owner: PluginIdentity, definition: MessageRendererDefinition): AsyncDisposable {
    validateDefinition(definition)
    if (!definition.renderer?.rendererId) throw new Error(`Message renderer 实现无 rendererId：${definition.id}`)
    return this.messages.register(owner, Object.freeze({ ...definition }), {
      contributionId: definition.id,
      priority: definition.priority,
    })
  }

  registerContentRenderer(owner: PluginIdentity, definition: ContentRendererDefinition): AsyncDisposable {
    validateDefinition(definition)
    if (!definition.kind || !definition.provider) throw new Error(`Content renderer 定义无效：${definition.id}`)
    return this.contents.register(owner, Object.freeze({ ...definition }), {
      contributionId: definition.id,
      priority: definition.priority,
    })
  }

  registerToolRenderer(owner: PluginIdentity, definition: ToolRendererDefinition): AsyncDisposable {
    validateDefinition(definition)
    if (!definition.kind || !definition.renderer) throw new Error(`Tool renderer 定义无效：${definition.id}`)
    return this.tools.register(owner, Object.freeze({ ...definition }), {
      contributionId: definition.id,
      priority: definition.priority,
    })
  }

  registerCodeHighlighter(owner: PluginIdentity, definition: CodeHighlighterDefinition): AsyncDisposable {
    validateDefinition(definition)
    if (typeof definition.highlight !== 'function') throw new Error(`Code highlighter 实现无效：${definition.id}`)
    return this.highlighters.register(owner, Object.freeze({ ...definition }), {
      contributionId: definition.id,
      priority: definition.priority,
    })
  }

  beginShadowTransaction(
    owner: PluginIdentity,
    replacingRuntimeInstanceId: string,
  ): RendererRegistryTransaction {
    const kinds = this.kinds.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    const stagedKinds: RenderKindDefinition[] = []
    const messages = this.messages.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    const contents = this.contents.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    const tools = this.tools.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    const highlighters = this.highlighters.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    const transactions = [kinds, messages, contents, tools, highlighters] as const
    return {
      registerRenderKind: definition => {
        validateRenderKind(definition, this.snapshotValue.renderKinds, true)
        stagedKinds.push(definition)
        return kinds.register(freezeRenderKind(definition), { contributionId: definition.id, priority: definition.priority })
      },
      registerSolidRenderer: definition => {
        if (definition.renderer.kind !== 'solid') throw new Error(`Solid renderer kind 非法：${definition.id}`)
        validateDefinition(definition)
        if (!definition.renderer?.rendererId) throw new Error(`Message renderer 实现无 rendererId：${definition.id}`)
        return messages.register(Object.freeze({ ...definition }), { contributionId: definition.id, priority: definition.priority })
      },
      registerMessageRenderer: definition => {
        validateDefinition(definition)
        if (!definition.renderer?.rendererId) throw new Error(`Message renderer 实现无 rendererId：${definition.id}`)
        return messages.register(Object.freeze({ ...definition }), {
          contributionId: definition.id,
          priority: definition.priority,
        })
      },
      registerContentRenderer: definition => {
        validateDefinition(definition)
        if (!definition.kind || !definition.provider) throw new Error(`Content renderer 定义无效：${definition.id}`)
        return contents.register(Object.freeze({ ...definition }), {
          contributionId: definition.id,
          priority: definition.priority,
        })
      },
      registerToolRenderer: definition => {
        validateDefinition(definition)
        if (!definition.kind || !definition.renderer) throw new Error(`Tool renderer 定义无效：${definition.id}`)
        return tools.register(Object.freeze({ ...definition }), {
          contributionId: definition.id,
          priority: definition.priority,
        })
      },
      registerCodeHighlighter: definition => {
        validateDefinition(definition)
        if (typeof definition.highlight !== 'function') throw new Error(`Code highlighter 实现无效：${definition.id}`)
        return highlighters.register(Object.freeze({ ...definition }), {
          contributionId: definition.id,
          priority: definition.priority,
        })
      },
      validate: () => {
        const existing = this.snapshotValue.renderKinds.filter(entry => entry.ownerRuntimeInstanceId !== replacingRuntimeInstanceId)
        const combined = [...existing, ...stagedKinds.map(definition => ({ value: definition } as RegistryEntry<RenderKindDefinition>))]
        const ids = new Set<string>()
        for (const definition of stagedKinds) {
          if (ids.has(definition.id) || existing.some(entry => entry.value.id === definition.id)) throw new Error(`RenderKind id 重复：${definition.id}`)
          ids.add(definition.id)
        }
        for (const definition of stagedKinds) validateRenderKind(definition, combined, false, false)
        for (const transaction of transactions) transaction.validate()
      },
      commit: () => {
        // Commit only after the cross-registry candidate has passed kind validation.
        const existing = this.snapshotValue.renderKinds.filter(entry => entry.ownerRuntimeInstanceId !== replacingRuntimeInstanceId)
        const combined = [...existing, ...stagedKinds.map(definition => ({ value: definition } as RegistryEntry<RenderKindDefinition>))]
        for (const definition of stagedKinds) validateRenderKind(definition, combined, false, false)
        this.batchDepth += 1
        try {
          for (const transaction of transactions) transaction.commit()
        } finally {
          this.batchDepth -= 1
          if (this.batchDepth === 0 && this.publishQueued) {
            this.publishQueued = false
            this.publish()
          }
        }
      },
      rollback: () => { for (const transaction of transactions) transaction.rollback() },
      revert: () => {
        this.batchDepth += 1
        try {
          for (const transaction of [...transactions].reverse()) transaction.revert()
        } finally {
          this.batchDepth -= 1
          if (this.batchDepth === 0 && this.publishQueued) {
            this.publishQueued = false
            this.publish()
          }
        }
      },
    }
  }

  resolveMessageRenderer(input: MessageRendererInput = {}) {
    return select(this.snapshotValue.messageRenderers, input)
  }

  resolveFallbackMessageRenderer(input: MessageRendererInput = {}, excludedContributionId?: string) {
    return select(
      this.snapshotValue.messageRenderers.filter(entry => (
        entry.value.fallback && entry.contributionId !== excludedContributionId
      )),
      input,
    )
  }

  resolveContentRenderer(input: ContentRendererInput) {
    return select(this.snapshotValue.contentRenderers.filter(entry => entry.value.kind === input.kind), input)
  }

  resolveToolRenderer(input: ToolRendererInput) {
    return select(this.snapshotValue.toolRenderers.filter(entry => (
      entry.value.kind === input.kind || entry.value.kind === '*'
    )), input)
  }

  resolveCodeHighlighter(input: CodeHighlighterInput) {
    return select(this.snapshotValue.codeHighlighters, input)
  }

  resolveSurface(node: RenderNode, context: RenderResolveContext = {}): ResolvedRenderer {
    const diagnostics: Array<{ code: string; message: string; kind?: string; rendererId?: string }> = []
    const requestedKind = node.kind?.trim() || 'content.unknown'
    const kinds = this.snapshotValue.renderKinds
    const kindEntry = kinds.find(entry => entry.value.id === requestedKind || entry.value.aliases?.includes(requestedKind))
    const candidateKinds: string[] = []
    let current = kindEntry?.value ?? kinds.find(entry => entry.value.id === 'content.unknown')?.value
    while (current) {
      if (candidateKinds.includes(current.id)) break
      candidateKinds.push(current.id)
      current = current.fallbackKind ? kinds.find(entry => entry.value.id === current?.fallbackKind)?.value : undefined
    }
    if (candidateKinds.length === 0) candidateKinds.push('content.unknown')
    const rendererId = context.rendererId ?? node.rendererId
    const find = (kind: string) => {
      const input = { kind, payload: node.payload }
      const definition = kinds.find(entry => entry.value.id === kind)?.value
      const acceptedKinds = new Set([kind, ...(definition?.aliases ?? [])])
      const candidates = [
        ...this.snapshotValue.contentRenderers.filter(entry => acceptedKinds.has(entry.value.kind)),
        ...this.snapshotValue.toolRenderers.filter(entry => acceptedKinds.has(entry.value.kind)),
      ]
      const explicit = rendererId ? candidates.find(entry => entry.contributionId === rendererId) : undefined
      if (explicit) return explicit
      for (const candidate of candidates) {
        try {
          if (candidate.value.canRender(input as never)) return candidate
        } catch (error) {
          const decision = candidate.value.onError?.(error, input as never)
          const diagnostic = { code: 'renderer.canRender.failed', message: `renderer ${candidate.contributionId} canRender failed`, kind, rendererId: candidate.contributionId }
          diagnostics.push(diagnostic)
          context.diagnostic?.(diagnostic)
          if (decision === 'rethrow') throw error
        }
      }
      return undefined
    }
    for (const kind of candidateKinds) {
      const definition = kinds.find(entry => entry.value.id === kind)?.value
      if (definition) {
        try {
          if (!definition.validateInput(node.payload)) continue
        } catch {
          const diagnostic = { code: 'render-kind.validate.failed', message: `RenderKind ${kind} validateInput failed`, kind }
          diagnostics.push(diagnostic)
          context.diagnostic?.(diagnostic)
          continue
        }
      }
      const renderer = find(kind)
      if (renderer) return { kind, rendererId: renderer.contributionId, renderer, fallback: kind !== requestedKind, diagnostics: Object.freeze(diagnostics) }
    }
    return { kind: 'content.unknown', fallback: true, diagnostics: Object.freeze(diagnostics) }
  }

  snapshot(): RenderCatalogSnapshot {
    return this.snapshotValue
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(): void {
    if (this.batchDepth > 0) {
      this.publishQueued = true
      return
    }
    this.revision += 1
    this.snapshotValue = Object.freeze({
      revision: this.revision,
      renderKinds: this.kinds.getSnapshot().entries,
      messageRenderers: this.messages.getSnapshot().entries,
      contentRenderers: this.contents.getSnapshot().entries,
      toolRenderers: this.tools.getSnapshot().entries,
      codeHighlighters: this.highlighters.getSnapshot().entries,
    })
    for (const listener of [...this.listeners]) notifyRegistryListener(listener)
  }
}
