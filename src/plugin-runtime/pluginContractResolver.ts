export interface PluginContract {
  readonly id: string
  readonly version: string
  readonly enabled: boolean
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly conflicts?: readonly string[]
  readonly activationEvents?: readonly string[]
}

export type PluginContractDiagnosticCode =
  | 'dependency_missing'
  | 'dependency_blocked'
  | 'dependency_version_mismatch'
  | 'optional_dependency_version_mismatch'
  | 'dependency_cycle'
  | 'plugin_conflict'
  | 'waiting_activation'

export interface PluginContractDiagnostic {
  readonly pluginId: string
  readonly code: PluginContractDiagnosticCode
  readonly message: string
  readonly blocking: boolean
  readonly relatedPluginIds: readonly string[]
}

export interface PluginContractResolution {
  readonly eligibleIds: readonly string[]
  readonly blocked: readonly PluginContractDiagnostic[]
  readonly diagnostics: readonly PluginContractDiagnostic[]
}

interface Version {
  major: number
  minor: number
  patch: number
}

function parseVersion(value: string): Version | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function compareVersion(left: Version, right: Version): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}

export function satisfiesPluginVersionRange(version: string, range: string): boolean {
  if (range === '*') return parseVersion(version) !== undefined
  const actual = parseVersion(version)
  const minimum = parseVersion(range.startsWith('^') ? range.slice(1) : range)
  if (!actual || !minimum) return false
  if (!range.startsWith('^')) return compareVersion(actual, minimum) === 0
  const maximum = minimum.major > 0
    ? { major: minimum.major + 1, minor: 0, patch: 0 }
    : minimum.minor > 0
      ? { major: 0, minor: minimum.minor + 1, patch: 0 }
      : { major: 0, minor: 0, patch: minimum.patch + 1 }
  return compareVersion(actual, minimum) >= 0 && compareVersion(actual, maximum) < 0
}

export function resolvePluginContracts(
  contracts: readonly PluginContract[],
  emittedEvents: readonly string[] = [],
): PluginContractResolution {
  const enabled = new Map(
    contracts.filter(contract => contract.enabled).map(contract => [contract.id, contract]),
  )
  const eligibleIds: string[] = []
  const eligible = new Set<string>()
  const blocked: PluginContractDiagnostic[] = []
  const notices: PluginContractDiagnostic[] = []
  const states = new Map<string, 'visiting' | 'done'>()
  const blockedIds = new Set<string>()
  const stack: string[] = []

  const addBlocked = (
    pluginId: string,
    code: PluginContractDiagnosticCode,
    message: string,
    relatedPluginIds: readonly string[],
  ) => {
    blockedIds.add(pluginId)
    if (blocked.some(item => item.pluginId === pluginId && item.code === code)) return
    blocked.push(Object.freeze({
      pluginId,
      code,
      message,
      blocking: true,
      relatedPluginIds: Object.freeze([...relatedPluginIds]),
    }))
  }

  for (const contract of [...enabled.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const conflictId of [...(contract.conflicts ?? [])].sort()) {
      if (!enabled.has(conflictId)) continue
      addBlocked(contract.id, 'plugin_conflict', `与已启用插件 ${conflictId} 冲突`, [conflictId])
      addBlocked(conflictId, 'plugin_conflict', `与已启用插件 ${contract.id} 冲突`, [contract.id])
    }
  }

  const visit = (pluginId: string): boolean => {
    const state = states.get(pluginId)
    if (state === 'done') return eligible.has(pluginId)
    if (state === 'visiting') {
      const cycle = stack.slice(stack.indexOf(pluginId))
      for (const member of cycle) {
        addBlocked(member, 'dependency_cycle', `依赖成环：${cycle.join(' -> ')} -> ${pluginId}`, cycle)
      }
      return false
    }
    const contract = enabled.get(pluginId)
    if (!contract) return false
    states.set(pluginId, 'visiting')
    stack.push(pluginId)
    for (const [dependencyId, range] of Object.entries(contract.dependencies ?? {})
      .sort(([left], [right]) => left.localeCompare(right))) {
      const dependency = enabled.get(dependencyId)
      if (!dependency) {
        addBlocked(pluginId, 'dependency_missing', `缺少已启用依赖 ${dependencyId}`, [dependencyId])
        continue
      }
      const dependencyEligible = visit(dependencyId)
      if (!dependencyEligible && !blockedIds.has(pluginId)) {
        addBlocked(pluginId, 'dependency_blocked', `依赖 ${dependencyId} 不可激活`, [dependencyId])
      }
      if (!satisfiesPluginVersionRange(dependency.version, range)) {
        addBlocked(
          pluginId,
          'dependency_version_mismatch',
          `依赖 ${dependencyId}@${dependency.version} 不满足 ${range}`,
          [dependencyId],
        )
      }
    }
    for (const [dependencyId, range] of Object.entries(contract.optionalDependencies ?? {})
      .sort(([left], [right]) => left.localeCompare(right))) {
      const dependency = enabled.get(dependencyId)
      if (!dependency || satisfiesPluginVersionRange(dependency.version, range)) continue
      notices.push(Object.freeze({
        pluginId,
        code: 'optional_dependency_version_mismatch',
        message: `可选依赖 ${dependencyId}@${dependency.version} 不满足 ${range}`,
        blocking: false,
        relatedPluginIds: Object.freeze([dependencyId]),
      }))
    }
    stack.pop()
    states.set(pluginId, 'done')
    if (blockedIds.has(pluginId)) return false
    const activationEvents = contract.activationEvents ?? []
    if (activationEvents.length > 0
      && !activationEvents.some(event => emittedEvents.includes(event))) {
      notices.push(Object.freeze({
        pluginId,
        code: 'waiting_activation',
        message: `等待激活事件：${activationEvents.join(', ')}`,
        blocking: false,
        relatedPluginIds: Object.freeze([]),
      }))
      return false
    }
    eligibleIds.push(pluginId)
    eligible.add(pluginId)
    return true
  }
  for (const pluginId of [...enabled.keys()].sort()) visit(pluginId)

  return Object.freeze({
    eligibleIds: Object.freeze(eligibleIds),
    blocked: Object.freeze(blocked),
    diagnostics: Object.freeze([...blocked, ...notices]),
  })
}
