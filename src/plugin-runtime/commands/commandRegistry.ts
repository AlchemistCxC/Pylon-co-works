import type { CommandPermission, CommandSetDescriptor } from '../../contracts/agentCommandSet.ts'
import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegisterOptions, RegistrySnapshot } from '../registry/types.ts'

export interface CommandRegistryTransaction {
  register(command: CommandDefinition, options?: CommandRegisterOptions): AsyncDisposable
  validate(): void
  commit(): void
  rollback(): void
  revert(): void
}

export interface CommandExecutionContext {
  readonly commandId: string
  readonly args?: unknown
  readonly signal?: AbortSignal
}

export interface CommandDefinition<T = unknown> extends CommandSetDescriptor {
  id: string
  execute?: (context: CommandExecutionContext) => T | Promise<T>
}

export interface CommandDescriptor {
  id: string
  ownerPluginId: string
  ownerRuntimeInstanceId: string
  name: string
  aliases?: readonly string[]
  description: string
  inputHint?: string
  agentPromptSnippet?: string
  permission?: CommandPermission
  priority: number
  executable: boolean
}

export interface CommandFilter {
  ownerPluginIds?: readonly string[]
  executable?: boolean
}

export type CommandRegisterOptions = Omit<RegisterOptions, 'contributionId'> & {
  contributionId?: string
}

export class CommandRegistry {
  private readonly registry = new ReactiveRegistryStore<CommandDefinition>()

  register(owner: PluginIdentity, command: CommandDefinition, options: CommandRegisterOptions = {}): AsyncDisposable {
    this.validate(command)
    return this.registry.register(owner, Object.freeze({ ...command }), {
      ...options,
      contributionId: options.contributionId ?? command.id,
      priority: options.priority ?? command.priority,
    })
  }

  beginShadowTransaction(
    owner: PluginIdentity,
    replacingRuntimeInstanceId: string,
  ): CommandRegistryTransaction {
    const transaction = this.registry.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    return {
      register: (command, options = {}) => {
        this.validate(command)
        return transaction.register(Object.freeze({ ...command }), {
          ...options,
          contributionId: options.contributionId ?? command.id,
          priority: options.priority ?? command.priority,
        })
      },
      validate: () => transaction.validate(),
      commit: () => { transaction.commit() },
      rollback: () => transaction.rollback(),
      revert: () => transaction.revert(),
    }
  }

  subscribe(listener: () => void): () => void {
    return this.registry.subscribe(listener)
  }

  getSnapshot(): RegistrySnapshot<CommandDefinition> {
    return this.registry.getSnapshot()
  }

  list(filter: CommandFilter = {}): CommandDescriptor[] {
    const owners = filter.ownerPluginIds ? new Set(filter.ownerPluginIds) : null
    return this.registry.getSnapshot().entries
      .filter(entry => !owners || owners.has(entry.ownerPluginId))
      .filter(entry => filter.executable === undefined || Boolean(entry.value.execute) === filter.executable)
      .map(entry => this.toDescriptor(entry.ownerPluginId, entry.ownerRuntimeInstanceId, entry.value))
  }

  describe(id: string): CommandDescriptor | null {
    const entry = this.resolveEntry(id)
    return entry ? this.toDescriptor(entry.ownerPluginId, entry.ownerRuntimeInstanceId, entry.value) : null
  }

  async execute<T = unknown>(id: string, args?: unknown, options: { signal?: AbortSignal } = {}): Promise<T> {
    const entry = this.resolveEntry(id)
    if (!entry) throw new Error(`命令不存在：${id}`)
    if (!entry.value.execute) throw new Error(`命令不可执行：${entry.value.id}`)
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError')
    return entry.value.execute({ commandId: entry.value.id, args, signal: options.signal }) as Promise<T>
  }

  private resolveEntry(id: string) {
    const normalized = id.replace(/^\//, '').toLowerCase()
    return this.registry.getSnapshot().entries.find(entry => {
      const command = entry.value
      return command.id.toLowerCase() === normalized
        || command.name.toLowerCase() === normalized
        || (command.aliases ?? []).some(alias => alias.toLowerCase() === normalized)
    })
  }

  private validate(command: CommandDefinition): void {
    if (!command.id || !command.name) throw new Error('Command id/name 不能为空')
    if (command.name.startsWith('/')) throw new Error(`Command name 不得包含斜杠：${command.name}`)
  }

  private toDescriptor(ownerPluginId: string, ownerRuntimeInstanceId: string, command: CommandDefinition): CommandDescriptor {
    return {
      id: command.id,
      ownerPluginId,
      ownerRuntimeInstanceId,
      name: command.name,
      ...(command.aliases ? { aliases: command.aliases } : {}),
      description: command.description,
      ...(command.inputHint ? { inputHint: command.inputHint } : {}),
      ...(command.agentPromptSnippet ? { agentPromptSnippet: command.agentPromptSnippet } : {}),
      ...(command.permission ? { permission: command.permission } : {}),
      priority: command.priority,
      executable: Boolean(command.execute),
    }
  }
}
