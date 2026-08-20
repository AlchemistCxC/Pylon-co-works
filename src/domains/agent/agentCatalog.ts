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
}
interface CatalogTool {
  name: string
  aliases?: string[]
  displayName?: string
  kind: ToolKind
  action: ToolAction
  summaryFields?: string[]
  outputLabel?: 'lines' | 'matches' | 'changed-lines'
}
interface CatalogProvider {
  provider: string
  displayName: string
  protocol: 'acp'
  capabilities: AgentDescriptor['capabilities']
  interactionKinds: InteractionKind[]
  protocolDefaults: { setModelApi: 'config_option' | 'set_model' | 'none' }
  detection: CatalogDetection
  tools: CatalogTool[]
}
interface CatalogDocument { schemaVersion: 1; providers: CatalogProvider[] }

const TOOL_KINDS = new Set<ToolKind>(['read', 'edit', 'execute', 'search', 'fetch', 'think', 'other'])
const TOOL_ACTIONS = new Set<ToolAction>(['read', 'write', 'edit', 'search', 'execute', 'fetch', 'navigate', 'click', 'type', 'snapshot', 'delegate', 'plan', 'skill', 'unknown'])
const INTERACTION_KINDS = new Set<InteractionKind>(['clarify', 'ask-question', 'approval', 'oauth', 'unknown'])

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Agent Catalog ${label} 必须是对象`)
  return value as Record<string, unknown>
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Agent Catalog ${label} 不能为空`)
  return value.trim()
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`Agent Catalog ${label} 必须是字符串数组`)
  return value.map(item => item.trim()).filter(Boolean)
}

export function parseAgentCatalog(value: unknown): CatalogDocument {
  const root = object(value, 'root')
  if (root.schemaVersion !== 1) throw new Error(`Agent Catalog schemaVersion 不支持：${String(root.schemaVersion)}`)
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
      },
      tools,
    }
  })
  return { schemaVersion: 1, providers }
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
      tools: entry.tools.map(tool => ({ name: tool.name, aliases: tool.aliases, kind: tool.kind, action: tool.action })),
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
})
