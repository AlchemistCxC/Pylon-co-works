import rawCatalog from '../../../shared/agent-catalog.json' with { type: 'json' }
import type { InteractionKind } from '../activity/activity.ts'
import type { ToolAction, ToolKind } from '../tool/toolKinds.ts'
import type { ToolRegistryEntry } from '../tool/toolRegistry.ts'
import type { AgentDescriptor } from './agentContracts.ts'

export interface AgentCatalogDetector {
  id: string
  provider: string
  protocol: 'acp'
  priority: number
}

interface CatalogInvocation { command: string; args: string[] }
interface CatalogConfigEvidence { relativePath: string; format: 'json' | 'yaml'; fields: string[] }
interface CatalogDetection {
  detectorId: string
  priority: number
  invocations: CatalogInvocation[]
  configDirs: string[]
  configEvidence: CatalogConfigEvidence[]
  versionArgs: string[]
  packageManager: { kind: 'npx' | 'uvx' | 'binary' | 'none'; package: string | null; cmd: string | null } | null
  requires: { node: string | null; uv: string | null }
  checks: CatalogCheck[]
}
interface CatalogCheck {
  id: string
  label: string
  kind: 'node-min' | 'uv-min' | 'binary-present' | 'adapter-present' | 'config-evidence'
  params: Record<string, unknown>
  fix: { kind: 'open-url' | 'install-adapter' | 'install-uv'; payload: string } | null
}
interface CatalogTool {
  name: string
  aliases?: string[]
  displayName?: string
  kind: ToolKind
  action: ToolAction
  summaryFields?: string[]
  outputLabel?: 'lines' | 'matches' | 'changed-lines'
  capabilities?: string[]
}
interface CatalogLaunchProfile {
  kind: 'path' | 'uvx' | 'npm'
  command: string
  args: string[]
  env: { name: string; value: string }[]
  cwdPolicy: 'workspace' | 'provider-config' | 'inherit' | null
}
interface CatalogAdapterRelation {
  nativeCmd: string
  nativeLabel: string
  sharedConfigDir: string
  extraDirs: string[]
  docsUrl: string | null
}
interface CatalogVersionGate {
  id: 'steering-prompt-required' | 'goal-control-out-of-band' | 'cursor-acp-backend'
  minVersion: string | null
  enabled: boolean
  evidence: 'adapter-agent-info-version' | 'launch-recipe' | 'static-policy'
}
interface CatalogProvider {
  provider: string
  displayName: string
  protocol: 'acp'
  capabilities: AgentDescriptor['capabilities']
  interactionKinds: InteractionKind[]
  protocolDefaults: { setModelApi: 'config_option' | 'set_model' | 'none' }
  detection: CatalogDetection
  adaptation: CatalogAdaptation | null
  launch: CatalogLaunchProfile
  tools: CatalogTool[]
}
interface CatalogAdaptation {
  adapterRelation: CatalogAdapterRelation | null
  clientCapabilities: Record<string, unknown> | null
  promptCapabilities: Record<string, unknown> | null
  launchEnv: unknown[] | null
  versionGates: CatalogVersionGate[]
  sessionEstablishment: { order: string[] }
  configAdaptation: Record<string, unknown> | null
  mcp: Record<string, unknown> | null
  interactionBridges: unknown[] | null
}
interface CatalogDocument { schemaVersion: 3; providers: CatalogProvider[] }

const LAUNCH_KINDS = new Set<CatalogLaunchProfile['kind']>(['path', 'uvx', 'npm'])
const LAUNCH_CWD_POLICIES = new Set<NonNullable<CatalogLaunchProfile['cwdPolicy']>>(['workspace', 'provider-config', 'inherit'])
const SESSION_METHODS = new Set(['resume', 'load', 'new'])
const POSIX_SYSTEM_PATH_PREFIXES = ['/bin/', '/sbin/', '/usr/', '/etc/', '/dev/', '/lib/', '/opt/', '/tmp/', '/var/']
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const SECRET_ENV_NEEDLES = ['API_KEY', 'APIKEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'CREDENTIAL']

const TOOL_KINDS = new Set<ToolKind>(['read', 'edit', 'execute', 'search', 'fetch', 'think', 'other'])
const TOOL_ACTIONS = new Set<ToolAction>(['read', 'write', 'edit', 'search', 'execute', 'fetch', 'navigate', 'click', 'type', 'snapshot', 'delegate', 'plan', 'skill', 'unknown'])
const INTERACTION_KINDS = new Set<InteractionKind>(['clarify', 'ask-question', 'approval', 'oauth', 'unknown'])

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Agent Catalog ${label} 必须是对象`)
  return value as Record<string, unknown>
}

function strictObject(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  const parsed = object(value, label)
  for (const key of Object.keys(parsed)) if (!keys.includes(key)) throw new Error(`Agent Catalog ${label} 未知字段：${key}`)
  return parsed
}

function nullableString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`Agent Catalog ${label} 必须是字符串`)
  return value
}

function detectionExtensions(detection: Record<string, unknown>): Pick<CatalogDetection, 'versionArgs' | 'packageManager' | 'requires' | 'checks'> {
  let packageManager: CatalogDetection['packageManager'] = null
  if (detection.packageManager !== undefined && detection.packageManager !== null) {
    const manager = strictObject(detection.packageManager, 'packageManager', ['kind', 'package', 'cmd'])
    if (!['npx', 'uvx', 'binary', 'none'].includes(String(manager.kind))) throw new Error('Agent Catalog packageManager.kind 非法')
    packageManager = { kind: manager.kind as NonNullable<CatalogDetection['packageManager']>['kind'], package: nullableString(manager.package, 'packageManager.package'), cmd: nullableString(manager.cmd, 'packageManager.cmd') }
  }
  const requirements = detection.requires === undefined ? {} : strictObject(detection.requires, 'requires', ['node', 'uv'])
  const rawChecks = detection.checks === undefined ? [] : detection.checks
  if (!Array.isArray(rawChecks)) throw new Error('Agent Catalog checks 必须是数组')
  const checks = rawChecks.map((value): CatalogCheck => {
    const check = strictObject(value, 'check', ['id', 'label', 'kind', 'params', 'fix'])
    if (!['node-min', 'uv-min', 'binary-present', 'adapter-present', 'config-evidence'].includes(String(check.kind))) throw new Error('Agent Catalog check.kind 非法')
    if (typeof check.id !== 'string' || typeof check.label !== 'string') throw new Error('Agent Catalog check.id/label 必须是字符串')
    let fix: CatalogCheck['fix'] = null
    if (check.fix !== undefined && check.fix !== null) {
      const rawFix = strictObject(check.fix, 'check.fix', ['kind', 'payload'])
      if (!['open-url', 'install-adapter', 'install-uv'].includes(String(rawFix.kind))) throw new Error('Agent Catalog check.fix.kind 非法')
      if (typeof rawFix.payload !== 'string') throw new Error('Agent Catalog check.fix.payload 必须是字符串')
      fix = { kind: rawFix.kind as NonNullable<CatalogCheck['fix']>['kind'], payload: rawFix.payload }
    }
    return { id: check.id, label: check.label, kind: check.kind as CatalogCheck['kind'], params: object(check.params, 'check.params'), fix }
  })
  const versionArgs = detection.versionArgs === undefined ? [] : detection.versionArgs
  if (!Array.isArray(versionArgs) || versionArgs.some(value => typeof value !== 'string')) throw new Error('Agent Catalog versionArgs 必须是字符串数组')
  return { versionArgs: [...versionArgs], packageManager, requires: { node: nullableString(requirements.node, 'requires.node'), uv: nullableString(requirements.uv, 'requires.uv') }, checks }
}

function adaptationPolicy(value: unknown, label: string): CatalogAdaptation | null {
  if (value === undefined || value === null) return null
  const raw = strictObject(value, label, ['adapterRelation', 'clientCapabilities', 'promptCapabilities', 'launchEnv', 'versionGates', 'sessionEstablishment', 'configAdaptation', 'mcp', 'interactionBridges'])
  const objectOrNull = (field: string): Record<string, unknown> | null => raw[field] === undefined || raw[field] === null ? null : object(raw[field], `${label}.${field}`)
  const arrayOrNull = (field: string): unknown[] | null => raw[field] === undefined || raw[field] === null ? null : (Array.isArray(raw[field]) ? raw[field] as unknown[] : (() => { throw new Error(`Agent Catalog ${label}.${field} 必须是数组`) })())
  // A0：三个已有生产消费者的策略在此闭成强类型；其余字段仍留待 A3 接线。
  return {
    adapterRelation: adapterRelationProjection(raw.adapterRelation, `${label}.adapterRelation`),
    clientCapabilities: objectOrNull('clientCapabilities'),
    promptCapabilities: objectOrNull('promptCapabilities'),
    launchEnv: arrayOrNull('launchEnv'),
    versionGates: versionGatesProjection(raw.versionGates, `${label}.versionGates`),
    sessionEstablishment: { order: sessionEstablishmentProjection(raw.sessionEstablishment, `${label}.sessionEstablishment`) },
    configAdaptation: objectOrNull('configAdaptation'),
    mcp: objectOrNull('mcp'),
    interactionBridges: arrayOrNull('interactionBridges'),
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Agent Catalog ${label} 不能为空`)
  return value.trim()
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`Agent Catalog ${label} 必须是字符串数组`)
  return value.map(item => item.trim()).filter(Boolean)
}

function relativeDir(value: unknown, label: string): string {
  const raw = nonEmpty(value, label)
  const stripped = raw.startsWith('~/') || raw.startsWith('~\\') ? raw.slice(2) : raw
  if (!stripped || stripped.startsWith('/') || /^[A-Za-z]:[\\/]/.test(stripped) || stripped.split(/[\\/]/).includes('..')) {
    throw new Error(`Agent Catalog ${label} 必须是配置目录内的相对路径`)
  }
  return raw
}

/**
 * Schema v3 launch recipe. Windows-only by contract: a profile that cannot be
 * launched as a plain Windows child process is rejected while parsing, not at
 * spawn time.
 */
function launchProfile(value: unknown, provider: string): CatalogLaunchProfile {
  const label = `${provider}.launch`
  const raw = strictObject(value, label, ['kind', 'command', 'args', 'env', 'cwdPolicy'])
  if (!LAUNCH_KINDS.has(raw.kind as CatalogLaunchProfile['kind'])) throw new Error(`Agent Catalog ${label}.kind 非法`)
  const command = nonEmpty(raw.command, `${label}.command`)
  if (command.includes('/') || command.includes('\\')) throw new Error(`Agent Catalog ${label}.command 必须是 PATH 可解析的可执行名`)
  const args = raw.args === undefined ? [] : stringList(raw.args, `${label}.args`)
  for (const arg of args) {
    if (POSIX_SYSTEM_PATH_PREFIXES.some(prefix => arg.startsWith(prefix))) throw new Error(`Agent Catalog ${label}.args 含 Unix-only 参数：${arg}`)
    if (arg.includes('SIGTERM') || arg.includes('SIGKILL')) throw new Error(`Agent Catalog ${label}.args 含 Unix-only 参数：${arg}`)
    if (/^(sh|bash|zsh|dash|ksh)$/i.test(command) && ['-c', '-lc', '--command'].includes(arg)) throw new Error(`Agent Catalog ${label}.args 含 Unix-only 参数：${arg}`)
  }
  const rawEnv = raw.env === undefined ? [] : raw.env
  if (!Array.isArray(rawEnv)) throw new Error(`Agent Catalog ${label}.env 必须是数组`)
  const env = rawEnv.map((entry, index): { name: string; value: string } => {
    const parsed = strictObject(entry, `${label}.env[${index}]`, ['name', 'value'])
    const name = nonEmpty(parsed.name, `${label}.env.name`)
    if (!ENV_NAME_PATTERN.test(name)) throw new Error(`Agent Catalog ${label}.env.name 非法：${name}`)
    if (SECRET_ENV_NEEDLES.some(needle => name.toUpperCase().includes(needle))) throw new Error(`Agent Catalog ${label}.env 不得声明凭据：${name}`)
    return { name, value: nonEmpty(parsed.value, `${label}.env.value`) }
  })
  let cwdPolicy: CatalogLaunchProfile['cwdPolicy'] = null
  if (raw.cwdPolicy !== undefined && raw.cwdPolicy !== null) {
    if (!LAUNCH_CWD_POLICIES.has(raw.cwdPolicy as NonNullable<CatalogLaunchProfile['cwdPolicy']>)) throw new Error(`Agent Catalog ${label}.cwdPolicy 非法`)
    cwdPolicy = raw.cwdPolicy as NonNullable<CatalogLaunchProfile['cwdPolicy']>
  }
  return { kind: raw.kind as CatalogLaunchProfile['kind'], command, args, env, cwdPolicy }
}

/** Closed adapter-relation projection; `null` when the provider is not a wrapper. */
function adapterRelationProjection(value: unknown, label: string): CatalogAdapterRelation | null {
  if (value === undefined || value === null) return null
  const raw = strictObject(value, label, ['nativeCmd', 'nativeLabel', 'sharedConfigDir', 'extraDirs', 'docsUrl'])
  const extraDirs = raw.extraDirs === undefined ? [] : stringList(raw.extraDirs, `${label}.extraDirs`)
  for (const dir of extraDirs) relativeDir(dir, `${label}.extraDirs`)
  return {
    nativeCmd: nonEmpty(raw.nativeCmd, `${label}.nativeCmd`),
    nativeLabel: nonEmpty(raw.nativeLabel, `${label}.nativeLabel`),
    sharedConfigDir: relativeDir(raw.sharedConfigDir, `${label}.sharedConfigDir`),
    extraDirs,
    docsUrl: raw.docsUrl === undefined || raw.docsUrl === null ? null : nonEmpty(raw.docsUrl, `${label}.docsUrl`),
  }
}

/**
 * Closed version-gate projection. Codeg's declaration is a flat map; `null`
 * fields mean "not declared here" and an unknown key fails closed rather than
 * becoming a gate nobody can evaluate.
 */
function versionGatesProjection(value: unknown, label: string): CatalogVersionGate[] {
  if (value === undefined || value === null) return []
  const raw = strictObject(value, label, ['steeringPromptRequiredMinVersion', 'goalControlOutOfBand', 'cursorAcpBackend'])
  const gates: CatalogVersionGate[] = []
  if (raw.steeringPromptRequiredMinVersion !== undefined && raw.steeringPromptRequiredMinVersion !== null) {
    const min = nonEmpty(raw.steeringPromptRequiredMinVersion, `${label}.steeringPromptRequiredMinVersion`)
    if (!/^\d+(\.\d+)*$/.test(min)) throw new Error(`Agent Catalog ${label}.steeringPromptRequiredMinVersion 非法：${min}`)
    gates.push({ id: 'steering-prompt-required', minVersion: min, enabled: true, evidence: 'adapter-agent-info-version' })
  }
  if (raw.goalControlOutOfBand !== undefined && raw.goalControlOutOfBand !== null) {
    if (typeof raw.goalControlOutOfBand !== 'boolean') throw new Error(`Agent Catalog ${label}.goalControlOutOfBand 必须是 boolean`)
    gates.push({ id: 'goal-control-out-of-band', minVersion: null, enabled: raw.goalControlOutOfBand, evidence: 'static-policy' })
  }
  if (raw.cursorAcpBackend !== undefined && raw.cursorAcpBackend !== null) {
    if (typeof raw.cursorAcpBackend !== 'boolean') throw new Error(`Agent Catalog ${label}.cursorAcpBackend 必须是 boolean`)
    gates.push({ id: 'cursor-acp-backend', minVersion: null, enabled: raw.cursorAcpBackend, evidence: 'launch-recipe' })
  }
  if (gates.length === 0) throw new Error(`Agent Catalog ${label} 不能为空对象`)
  return gates
}

/** `resume -> load -> new` order must end at `new` and repeat nothing. */
function sessionEstablishmentProjection(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return ['resume', 'load', 'new']
  const raw = strictObject(value, label, ['order'])
  const order = stringList(raw.order, `${label}.order`)
  if (order.length === 0) throw new Error(`Agent Catalog ${label}.order 不能为空`)
  if (order[order.length - 1] !== 'new') throw new Error(`Agent Catalog ${label}.order 必须以 new 收尾`)
  if (new Set(order).size !== order.length) throw new Error(`Agent Catalog ${label}.order 不能重复`)
  for (const method of order) if (!SESSION_METHODS.has(method)) throw new Error(`Agent Catalog ${label}.order 非法：${method}`)
  return order
}

/**
 * Layer the closed v3 policies onto the raw adaptation block so consumers read
 * typed values instead of re-deriving meaning from untyped JSON.
 */

export function parseAgentCatalog(value: unknown): CatalogDocument {
  const root = object(value, 'root')
  if (root.schemaVersion !== 3) throw new Error(`Agent Catalog schemaVersion 不支持：${String(root.schemaVersion)}`)
  for (const key of Object.keys(root)) if (key !== 'schemaVersion' && key !== 'providers') throw new Error(`Agent Catalog 顶层字段未知：${key}`)
  if (!Array.isArray(root.providers) || root.providers.length === 0) throw new Error('Agent Catalog providers 不能为空')
  const seenProviders = new Set<string>()
  const seenDetectors = new Set<string>()
  const providers = root.providers.map((rawProvider, providerIndex): CatalogProvider => {
    const raw = object(rawProvider, `providers[${providerIndex}]`)
    const provider = nonEmpty(raw.provider, `providers[${providerIndex}].provider`).toLowerCase()
    if (seenProviders.has(provider)) throw new Error(`Agent Catalog provider 重复：${provider}`)
    seenProviders.add(provider)
    if (raw.protocol !== 'acp') throw new Error(`Agent Catalog ${provider}.protocol 必须是 acp`)
    const capabilities = object(raw.capabilities, `${provider}.capabilities`)
    const responseMethods = stringList(capabilities.responseMethods, `${provider}.capabilities.responseMethods`)
    for (const key of ['sessionUpdates', 'interactionEvents', 'permissionRequests', 'replay'] as const) {
      if (typeof capabilities[key] !== 'boolean') throw new Error(`Agent Catalog ${provider}.capabilities.${key} 必须是 boolean`)
    }
    const interactionKinds = stringList(raw.interactionKinds, `${provider}.interactionKinds`)
    if (interactionKinds.some(kind => !INTERACTION_KINDS.has(kind as InteractionKind))) throw new Error(`Agent Catalog ${provider}.interactionKinds 非法`)
    const protocolDefaults = object(raw.protocolDefaults, `${provider}.protocolDefaults`)
    if (!['config_option', 'set_model', 'none'].includes(String(protocolDefaults.setModelApi))) throw new Error(`Agent Catalog ${provider}.protocolDefaults.setModelApi 非法`)
    const detection = object(raw.detection, `${provider}.detection`)
    const adaptation = adaptationPolicy(raw.adaptation, `${provider}.adaptation`)
    if (raw.launch === undefined || raw.launch === null) throw new Error(`Agent Catalog ${provider}.launch 未声明`)
    const launch = launchProfile(raw.launch, provider)
    const detectorId = nonEmpty(detection.detectorId, `${provider}.detection.detectorId`)
    if (seenDetectors.has(detectorId)) throw new Error(`Agent Catalog detectorId 重复：${detectorId}`)
    seenDetectors.add(detectorId)
    if (!Number.isFinite(detection.priority)) throw new Error(`Agent Catalog ${provider}.detection.priority 必须是数字`)
    if (!Array.isArray(detection.invocations) || detection.invocations.length === 0) throw new Error(`Agent Catalog ${provider}.detection.invocations 不能为空`)
    const invocations = detection.invocations.map((rawInvocation, invocationIndex) => {
      const invocation = object(rawInvocation, `${provider}.detection.invocations[${invocationIndex}]`)
      return { command: nonEmpty(invocation.command, `${provider}.detection.invocations.command`), args: stringList(invocation.args, `${provider}.detection.invocations.args`) }
    })
    const configEvidence = (detection.configEvidence === undefined ? [] : detection.configEvidence)
    if (!Array.isArray(configEvidence)) throw new Error(`Agent Catalog ${provider}.detection.configEvidence 必须是数组`)
    const parsedConfigEvidence = configEvidence.map((rawEvidence, evidenceIndex): CatalogConfigEvidence => {
      const evidence = object(rawEvidence, `${provider}.detection.configEvidence[${evidenceIndex}]`)
      const relativePath = nonEmpty(evidence.relativePath, `${provider}.detection.configEvidence.relativePath`)
      if (relativePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
        throw new Error(`Agent Catalog ${provider}.detection.configEvidence.relativePath 必须位于配置目录内`)
      }
      if (evidence.format !== 'json' && evidence.format !== 'yaml') throw new Error(`Agent Catalog ${provider}.detection.configEvidence.format 非法`)
      const fields = stringList(evidence.fields, `${provider}.detection.configEvidence.fields`)
      if (fields.length === 0) throw new Error(`Agent Catalog ${provider}.detection.configEvidence.fields 不能为空`)
      return { relativePath, format: evidence.format, fields }
    })
    const extensions = detectionExtensions(detection)
    if (!Array.isArray(raw.tools)) throw new Error(`Agent Catalog ${provider}.tools 必须是数组`)
    const seenTools = new Set<string>()
    const tools = raw.tools.map((rawTool, toolIndex): CatalogTool => {
      const tool = object(rawTool, `${provider}.tools[${toolIndex}]`)
      const name = nonEmpty(tool.name, `${provider}.tools[${toolIndex}].name`)
      const toolKey = name.toLowerCase()
      if (seenTools.has(toolKey)) throw new Error(`Agent Catalog tool 重复：${provider}/${name}`)
      seenTools.add(toolKey)
      if (!TOOL_KINDS.has(tool.kind as ToolKind) || !TOOL_ACTIONS.has(tool.action as ToolAction)) throw new Error(`Agent Catalog tool 类型非法：${provider}/${name}`)
      const outputLabel = tool.outputLabel
      if (outputLabel !== undefined && !['lines', 'matches', 'changed-lines'].includes(String(outputLabel))) throw new Error(`Agent Catalog outputLabel 非法：${provider}/${name}`)
      return {
        name,
        ...(tool.aliases === undefined ? {} : { aliases: stringList(tool.aliases, `${provider}/${name}.aliases`) }),
        ...(typeof tool.displayName === 'string' ? { displayName: tool.displayName } : {}),
        kind: tool.kind as ToolKind,
        action: tool.action as ToolAction,
        ...(tool.summaryFields === undefined ? {} : { summaryFields: stringList(tool.summaryFields, `${provider}/${name}.summaryFields`) }),
        ...(outputLabel === undefined ? {} : { outputLabel: outputLabel as CatalogTool['outputLabel'] }),
        ...(tool.capabilities === undefined ? {} : { capabilities: stringList(tool.capabilities, `${provider}/${name}.capabilities`) }),
      }
    })
    return {
      provider,
      displayName: nonEmpty(raw.displayName, `${provider}.displayName`),
      protocol: 'acp',
      capabilities: {
        sessionUpdates: capabilities.sessionUpdates as boolean,
        interactionEvents: capabilities.interactionEvents as boolean,
        permissionRequests: capabilities.permissionRequests as boolean,
        replay: capabilities.replay as boolean,
        responseMethods,
      },
      interactionKinds: interactionKinds as InteractionKind[],
      protocolDefaults: { setModelApi: protocolDefaults.setModelApi as CatalogProvider['protocolDefaults']['setModelApi'] },
      detection: {
        detectorId,
        priority: detection.priority as number,
        invocations,
        configDirs: stringList(detection.configDirs, `${provider}.detection.configDirs`),
        configEvidence: parsedConfigEvidence,
        ...extensions,
      },
      adaptation,
      launch,
      tools,
    }
  })
  return { schemaVersion: 3, providers }
}

const catalog = parseAgentCatalog(rawCatalog)

/** Deep catalog interface: callers consume projections, not the shared document shape. */
export const builtinAgentCatalog = Object.freeze({
  descriptors(): readonly AgentDescriptor[] {
    return catalog.providers.map(entry => ({
      provider: entry.provider,
      displayName: entry.displayName,
      protocol: entry.protocol,
      capabilities: { ...entry.capabilities, responseMethods: [...entry.capabilities.responseMethods] },
      tools: entry.tools.map(tool => ({ name: tool.name, aliases: tool.aliases, kind: tool.kind, action: tool.action, capabilities: tool.capabilities })),
      interactionKinds: [...entry.interactionKinds],
    }))
  },
  detectors(): readonly AgentCatalogDetector[] {
    return catalog.providers.map(entry => ({ id: entry.detection.detectorId, provider: entry.provider, protocol: entry.protocol, priority: entry.detection.priority }))
  },
  tools(): readonly ToolRegistryEntry[] {
    return catalog.providers.flatMap(entry => entry.tools.map(tool => ({ provider: entry.provider, ...tool })))
  },
  providers(): readonly string[] {
    return catalog.providers.map(entry => entry.provider)
  },
  matchExecutable(path: string): { provider: string; displayName: string; args: string[] } | null {
    const command = path.trim().split(/[\\/]/).pop()?.replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase()
    if (!command) return null
    for (const entry of catalog.providers) {
      const invocation = entry.detection.invocations.find(candidate => candidate.command.toLowerCase() === command)
      if (invocation) return { provider: entry.provider, displayName: entry.displayName, args: [...invocation.args] }
    }
    return null
  },
  /**
   * Catalog-derived fill-in hint for the executable field.
   *
   * A provider-specific `switch` here used to hardcode hermes/peri wording, so
   * every new provider needed a component change (A4: no component-level
   * provider switch). The hint is now built from the same catalog data the
   * launcher consumes: the declared launch command, the declared wrapper
   * relation, and the config dir detection reads.
   */
  executableHint(provider: string | null | undefined): string {
    const entry = catalog.providers.find(candidate => candidate.provider === (provider ?? '').trim().toLowerCase())
    if (!entry) {
      return 'exe 填 Agent 可执行文件绝对路径；PATH 内的命令也可只填命令名。'
    }
    const parts = [`exe 填 ${entry.launch.command}（PATH 内可只填命令名）或其绝对路径`]
    const relation = entry.adaptation?.adapterRelation ?? null
    if (relation) {
      parts.push(`这是 ACP wrapper：启动 ${entry.launch.command}，用户自装的 ${relation.nativeLabel}（${relation.nativeCmd}）仅作探测证据`)
    }
    if (entry.detection.configDirs.length > 0) {
      parts.push(`配置探测读 ${entry.detection.configDirs.join(' / ')}`)
    }
    return `${parts.join('；')}。`
  },
})
