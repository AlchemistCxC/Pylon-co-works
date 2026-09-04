import { THEME_FIELD_DEFS, type ThemeFieldKey } from '../../themeFieldDefs.ts'
import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistryEntry, RegistrySnapshot, RegistryTransaction } from '../registry/types.ts'
import type { PluginSettingOption, PluginSettingOptionsContribution } from './pluginSettingsTypes.ts'
import { stringifySettingsTarget } from './settingsTargetGrammar.ts'

const TARGET_PATTERN = /^[a-z][a-z0-9-]*(?:\.[A-Za-z0-9_%~-]+)+$/
// Legacy targets may contain dotted third-party Kind owners. Structured
// targets are canonical; this compatibility validator only rejects empty
// segments and preserves the original string for migration.
const RENDERER_TARGET_PATTERN = /^(suite|slot)\.[A-Za-z0-9_.%~-]+\.[A-Za-z0-9_%~-]+$|^kind\.[A-Za-z0-9_.%~-]+(?:\.[A-Za-z0-9_%~-]+){2,}$/

function themeFieldFromTarget(target: string): ThemeFieldKey | null {
  if (!target.startsWith('theme.')) return null
  const field = target.slice('theme.'.length) as ThemeFieldKey
  return field in THEME_FIELD_DEFS ? field : null
}

function validateOption(option: PluginSettingOption, contributionId: string): PluginSettingOption {
  if (!option.value || option.value !== option.value.trim()) {
    throw new Error(`Plugin setting option value 非法：${contributionId}`)
  }
  if (option.label !== undefined && !option.label.trim()) {
    throw new Error(`Plugin setting option label 不能为空：${contributionId}.${option.value}`)
  }
  if (option.order !== undefined && !Number.isFinite(option.order)) {
    throw new Error(`Plugin setting option order 非法：${contributionId}.${option.value}`)
  }
  return Object.freeze({ ...option })
}

export function validatePluginSettingOptionsContribution(
  contribution: PluginSettingOptionsContribution,
): PluginSettingOptionsContribution {
  if (!contribution.id || contribution.id !== contribution.id.trim()) {
    throw new Error('Plugin setting options contribution id 非法')
  }
  const structuredTarget = typeof contribution.target !== 'string'
  const target = structuredTarget ? stringifySettingsTarget(contribution.target) : contribution.target
  if (!TARGET_PATTERN.test(target) || (!structuredTarget && (target.startsWith('kind.') || target.startsWith('suite.') || target.startsWith('slot.')) && !RENDERER_TARGET_PATTERN.test(target))) {
    throw new Error(`Plugin setting options target 非法：${contribution.id}`)
  }
  const themeField = themeFieldFromTarget(target)
  if (target.startsWith('theme.') && !themeField) {
    throw new Error(`Plugin setting options target 不存在：${target}`)
  }
  if (themeField) {
    const definition = THEME_FIELD_DEFS[themeField]
    if (definition.type !== 'select' && definition.type !== 'color') {
      throw new Error(`Plugin setting options target 不支持候选项：${target}`)
    }
  }
  const remove = [...new Set(contribution.remove ?? [])]
  if (remove.some(value => !value || value !== value.trim())) {
    throw new Error(`Plugin setting options remove 包含非法值：${contribution.id}`)
  }
  const upsert = (contribution.upsert ?? []).map(option => validateOption(option, contribution.id))
  if (new Set(upsert.map(option => option.value)).size !== upsert.length) {
    throw new Error(`Plugin setting options upsert 包含重复值：${contribution.id}`)
  }
  if (remove.length === 0 && upsert.length === 0) {
    throw new Error(`Plugin setting options contribution 不能为空：${contribution.id}`)
  }
  return Object.freeze({
    ...contribution,
    target,
    remove: Object.freeze(remove),
    upsert: Object.freeze(upsert),
  })
}

export class PluginSettingOptionsRegistry {
  private readonly registry = new ReactiveRegistryStore<PluginSettingOptionsContribution>()

  register(owner: PluginIdentity, contribution: PluginSettingOptionsContribution): AsyncDisposable {
    const normalized = validatePluginSettingOptionsContribution(contribution)
    return this.registry.register(owner, normalized, {
      contributionId: normalized.id,
      priority: normalized.order,
    })
  }

  beginShadowTransaction(
    owner: PluginIdentity,
    replacingRuntimeInstanceId: string,
  ): RegistryTransaction<PluginSettingOptionsContribution> {
    const transaction = this.registry.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    return {
      ...transaction,
      register: (contribution, options) => {
        const normalized = validatePluginSettingOptionsContribution(contribution)
        return transaction.register(normalized, {
          ...options,
          contributionId: normalized.id,
          priority: normalized.order,
        })
      },
    }
  }

  subscribe(listener: () => void): () => void { return this.registry.subscribe(listener) }
  getSnapshot(): RegistrySnapshot<PluginSettingOptionsContribution> { return this.registry.getSnapshot() }
}

interface ResolvedOption extends PluginSettingOption {
  readonly label: string
  readonly contributionId?: string
}

interface MutableResolvedOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
  order?: number
  contributionId?: string
  sequence: number
}

/** Pure resolver shared by Settings controls and contract tests. */
export function resolvePluginSettingOptions(
  target: string,
  base: readonly PluginSettingOption[],
  entries: readonly RegistryEntry<PluginSettingOptionsContribution>[],
): readonly ResolvedOption[] {
  const values = new Map<string, MutableResolvedOption>()
  let sequence = 0
  for (const option of base) {
    values.set(option.value, { ...option, label: option.label ?? option.value, sequence: sequence++ })
  }
  for (const entry of entries) {
    if (entry.value.target !== target) continue
    for (const value of entry.value.remove ?? []) values.delete(value)
    for (const option of entry.value.upsert ?? []) {
      const current = values.get(option.value)
      values.set(option.value, {
        ...(current ?? { value: option.value, label: option.value, sequence: sequence++ }),
        ...option,
        label: option.label ?? current?.label ?? option.value,
        contributionId: entry.contributionId,
      })
    }
  }
  return Object.freeze([...values.values()]
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.sequence - b.sequence)
    .map(({ sequence: _sequence, ...option }) => Object.freeze(option)))
}
