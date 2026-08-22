import { THEME_FIELD_DEFS, normalizeThemeValue } from '../../themeFieldDefs.ts'
import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.ts'
import type { PresentationProfileContribution } from './presentationProfileTypes.ts'
import type { RendererSettingValue } from '../renderers/rendererSettingsTypes.ts'

const FAMILIES = new Set(['terminal', 'gui', 'reading', 'hybrid', 'custom'])

function isRendererSettingValue(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  return Array.isArray(value)
    ? value.every(item => isRendererSettingValue(item, seen))
    : Object.values(value).every(item => isRendererSettingValue(item, seen))
}

export function validatePresentationProfile(
  contribution: PresentationProfileContribution,
): PresentationProfileContribution {
  if (!contribution.id || contribution.id !== contribution.id.trim()) throw new Error('Presentation profile id 非法')
  if (!contribution.label.trim()) throw new Error(`Presentation profile label 不能为空：${contribution.id}`)
  if (contribution.interfaceMode !== undefined
    && !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(contribution.interfaceMode)) {
    throw new Error(`Presentation profile interfaceMode 非法：${contribution.id}`)
  }
  if (!FAMILIES.has(contribution.family)) throw new Error(`Presentation profile family 非法：${contribution.id}`)
  if (!contribution.tokens || typeof contribution.tokens !== 'object' || Array.isArray(contribution.tokens)) {
    throw new Error(`Presentation profile tokens 必须是对象：${contribution.id}`)
  }
  const tokens: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(contribution.tokens)) {
    const definition = THEME_FIELD_DEFS[key as keyof typeof THEME_FIELD_DEFS]
    if (!definition || definition.meta) throw new Error(`Presentation profile token 未知：${contribution.id}.${key}`)
    const normalized = normalizeThemeValue(definition, value)
    if (normalized !== value) throw new Error(`Presentation profile token 无效：${contribution.id}.${key}`)
    tokens[key] = value
  }
  const kindTokens: Record<string, Readonly<Record<string, RendererSettingValue>>> = {}
  for (const [kind, values] of Object.entries(contribution.kindTokens ?? {})) {
    if (!/^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/.test(kind)
      || !values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error(`Presentation profile kindTokens kind 非法：${contribution.id}.${kind}`)
    }
    for (const [key, value] of Object.entries(values)) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key) || !isRendererSettingValue(value)) {
        throw new Error(`Presentation profile kindTokens token 非法：${contribution.id}.${kind}.${key}`)
      }
    }
    kindTokens[kind] = Object.freeze({ ...values })
  }
  return Object.freeze({
    ...contribution,
    tokens: Object.freeze(tokens),
    ...(contribution.kindTokens ? { kindTokens: Object.freeze(kindTokens) } : {}),
    ...(contribution.assets ? { assets: Object.freeze({ ...contribution.assets }) } : {}),
  })
}

export class PresentationProfileRegistry {
  private readonly registry = new ReactiveRegistryStore<PresentationProfileContribution>()

  register(owner: PluginIdentity, contribution: PresentationProfileContribution): AsyncDisposable {
    const normalized = validatePresentationProfile(contribution)
    return this.registry.register(owner, normalized, {
      contributionId: normalized.id,
      priority: normalized.order,
    })
  }

  beginShadowTransaction(
    owner: PluginIdentity,
    replacingRuntimeInstanceId: string,
  ): RegistryTransaction<PresentationProfileContribution> {
    const transaction = this.registry.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    return {
      ...transaction,
      register: (contribution, options) => {
        const normalized = validatePresentationProfile(contribution)
        return transaction.register(normalized, {
          ...options,
          contributionId: normalized.id,
          priority: normalized.order,
        })
      },
    }
  }

  subscribe(listener: () => void): () => void { return this.registry.subscribe(listener) }
  getSnapshot(): RegistrySnapshot<PresentationProfileContribution> { return this.registry.getSnapshot() }
  resolve(id: string) { return this.registry.getSnapshot().entries.find(entry => entry.contributionId === id) }
}
