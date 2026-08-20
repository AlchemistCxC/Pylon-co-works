import type { PluginIdentity } from '../pluginIdentity.ts'
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
} from './rendererTypes.ts'
import { notifyRegistryListener } from '../registry/registryBatch.ts'

export interface RendererRegistryTransaction {
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
  readonly messageRenderers: readonly RegistryEntry<MessageRendererDefinition>[]
  readonly contentRenderers: readonly RegistryEntry<ContentRendererDefinition>[]
  readonly toolRenderers: readonly RegistryEntry<ToolRendererDefinition>[]
  readonly codeHighlighters: readonly RegistryEntry<CodeHighlighterDefinition>[]
}

function validateDefinition<TInput>(definition: RendererDefinitionBase<TInput>): void {
  if (!definition.id) throw new Error('Renderer id 不能为空')
  if (!Number.isFinite(definition.priority)) throw new Error(`Renderer priority 无效：${definition.id}`)
  if (typeof definition.fallback !== 'boolean') throw new Error(`Renderer fallback 必须显式声明：${definition.id}`)
  if (typeof definition.canRender !== 'function') throw new Error(`Renderer canRender 缺失：${definition.id}`)
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
  private readonly messages = new ReactiveRegistryStore<MessageRendererDefinition>()
  private readonly contents = new ReactiveRegistryStore<ContentRendererDefinition>()
  private readonly tools = new ReactiveRegistryStore<ToolRendererDefinition>()
  private readonly highlighters = new ReactiveRegistryStore<CodeHighlighterDefinition>()
  private readonly listeners = new Set<() => void>()
  private revision = 0
  private snapshotValue: RendererRegistrySnapshot = Object.freeze({
    revision: 0,
    messageRenderers: Object.freeze([]),
    contentRenderers: Object.freeze([]),
    toolRenderers: Object.freeze([]),
    codeHighlighters: Object.freeze([]),
  })

  constructor() {
    const publish = () => this.publish()
    this.messages.subscribe(publish)
    this.contents.subscribe(publish)
    this.tools.subscribe(publish)
    this.highlighters.subscribe(publish)
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
    const messages = this.messages.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    const contents = this.contents.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    const tools = this.tools.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    const highlighters = this.highlighters.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    const transactions = [messages, contents, tools, highlighters] as const
    return {
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
      validate: () => { for (const transaction of transactions) transaction.validate() },
      commit: () => { for (const transaction of transactions) transaction.commit() },
      rollback: () => { for (const transaction of transactions) transaction.rollback() },
      revert: () => { for (const transaction of [...transactions].reverse()) transaction.revert() },
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

  snapshot(): RendererRegistrySnapshot {
    return this.snapshotValue
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(): void {
    this.revision += 1
    this.snapshotValue = Object.freeze({
      revision: this.revision,
      messageRenderers: this.messages.getSnapshot().entries,
      contentRenderers: this.contents.getSnapshot().entries,
      toolRenderers: this.tools.getSnapshot().entries,
      codeHighlighters: this.highlighters.getSnapshot().entries,
    })
    for (const listener of [...this.listeners]) notifyRegistryListener(listener)
  }
}
