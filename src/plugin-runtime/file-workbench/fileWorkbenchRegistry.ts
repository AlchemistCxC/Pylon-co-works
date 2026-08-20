import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.ts'
import type { FileWorkbenchContribution } from './fileWorkbenchTypes.ts'

function validate(value: FileWorkbenchContribution): FileWorkbenchContribution {
  if (!value.id || value.id !== value.id.trim()) throw new Error('File Workbench contribution id 非法')
  return Object.freeze(value)
}

export class FileWorkbenchRegistry {
  private readonly registry = new ReactiveRegistryStore<FileWorkbenchContribution>()
  register(owner: PluginIdentity, value: FileWorkbenchContribution): AsyncDisposable {
    const normalized = validate(value)
    return this.registry.register(owner, normalized, { contributionId: normalized.id, priority: 'priority' in normalized ? normalized.priority : normalized.order })
  }
  beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RegistryTransaction<FileWorkbenchContribution> {
    return this.registry.beginShadowTransaction(owner, replacingRuntimeInstanceId)
  }
  subscribe(listener: () => void): () => void { return this.registry.subscribe(listener) }
  getSnapshot(): RegistrySnapshot<FileWorkbenchContribution> { return this.registry.getSnapshot() }
}
