import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.ts'
import type { FontContribution, FontRole } from './fontContributionTypes.ts'

const FONT_ROLES = new Set<FontRole>(['interface', 'content', 'code'])

export function fontContributionCssVariable(id: string): string {
  const safeId = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
  return `--pylon-font-${safeId || 'invalid'}`
}

export function validateFontContribution(contribution: FontContribution): FontContribution {
  if (!contribution.id || contribution.id !== contribution.id.trim()) throw new Error('Font contribution id 非法')
  if (!contribution.label?.trim()) throw new Error(`Font contribution label 不能为空：${contribution.id}`)
  if (!contribution.family?.trim()) throw new Error(`Font contribution family 不能为空：${contribution.id}`)
  if (!Array.isArray(contribution.roles) || contribution.roles.length === 0) {
    throw new Error(`Font contribution roles 不能为空：${contribution.id}`)
  }
  const roles = [...new Set(contribution.roles)]
  if (roles.some(role => !FONT_ROLES.has(role))) throw new Error(`Font contribution role 非法：${contribution.id}`)
  return Object.freeze({ ...contribution, roles: Object.freeze(roles) })
}

export class FontContributionRegistry {
  private readonly registry = new ReactiveRegistryStore<FontContribution>()

  register(owner: PluginIdentity, contribution: FontContribution): AsyncDisposable {
    const normalized = validateFontContribution(contribution)
    return this.registry.register(owner, normalized, {
      contributionId: normalized.id,
      priority: normalized.order,
    })
  }

  beginShadowTransaction(
    owner: PluginIdentity,
    replacingRuntimeInstanceId: string,
  ): RegistryTransaction<FontContribution> {
    const transaction = this.registry.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    return {
      ...transaction,
      register: (contribution, options) => {
        const normalized = validateFontContribution(contribution)
        return transaction.register(normalized, {
          ...options,
          contributionId: normalized.id,
          priority: normalized.order,
        })
      },
    }
  }

  subscribe(listener: () => void): () => void { return this.registry.subscribe(listener) }
  getSnapshot(): RegistrySnapshot<FontContribution> { return this.registry.getSnapshot() }
  resolve(id: string) { return this.registry.getSnapshot().entries.find(entry => entry.contributionId === id) }
}

