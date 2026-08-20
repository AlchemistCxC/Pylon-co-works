import type { RegistryEntry } from '../registry/types.ts'
import type { SessionCreationRegistrySnapshot } from './sessionCreationRegistry.ts'
import type {
  ResolvedSessionCreationContribution,
  SessionCreationArtifactDraft,
  SessionCreationArtifactSnapshot,
  SessionCreationContext,
  SessionCreationDiagnostic,
  SessionCreationJson,
  SessionCreationSnapshot,
} from './sessionCreationTypes.ts'

const MAX_CONTRIBUTIONS = 128
const MAX_ARTIFACT_BYTES = 256 * 1024
const COMPILER_BUDGET_MS = 50
const NAMESPACED_KIND = /^[a-z][a-z0-9.-]*(?:\/[a-z][a-z0-9._-]*)+$/

export function normalizeSessionCreationJson(value: unknown, path = 'payload'): SessionCreationJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return Object.freeze(value.map((item, index) => normalizeSessionCreationJson(item, `${path}[${index}]`)))
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const output: Record<string, SessionCreationJson> = {}
    for (const [key, item] of Object.entries(value)) output[key] = normalizeSessionCreationJson(item, `${path}.${key}`)
    return Object.freeze(output)
  }
  throw new Error(`${path} 必须是可持久化 JSON`)
}

function validateArtifact(
  draft: SessionCreationArtifactDraft,
  source: ResolvedSessionCreationContribution,
  index: number,
): SessionCreationArtifactSnapshot {
  if (!draft || typeof draft !== 'object') throw new Error(`artifact 非法：${source.id}[${index}]`)
  if (!NAMESPACED_KIND.test(draft.phase)) throw new Error(`artifact phase 必须是 namespaced path：${draft.phase}`)
  if (!NAMESPACED_KIND.test(draft.kind)) throw new Error(`artifact kind 必须是 namespaced path：${draft.kind}`)
  if (draft.order !== undefined && !Number.isFinite(draft.order)) throw new Error(`artifact order 非法：${source.id}[${index}]`)
  return Object.freeze({
    id: `${source.id}#${index}`,
    phase: draft.phase,
    kind: draft.kind,
    ownerPluginId: source.ownerPluginId,
    ownerRuntimeInstanceId: source.ownerRuntimeInstanceId,
    sourceContributionId: source.id,
    order: draft.order ?? source.order,
    failurePolicy: source.failurePolicy,
    payload: normalizeSessionCreationJson(draft.payload, `${source.id}[${index}].payload`),
  })
}

function diagnostic(entry: RegistryEntry<unknown>, error: unknown): SessionCreationDiagnostic {
  return Object.freeze({
    contributionId: entry.contributionId,
    ownerPluginId: entry.ownerPluginId,
    message: error instanceof Error ? error.message : String(error),
  })
}

export function compileSessionCreationSnapshot(
  registry: SessionCreationRegistrySnapshot,
  context: SessionCreationContext,
  now = Date.now(),
): SessionCreationSnapshot {
  if (registry.contributions.entries.length > MAX_CONTRIBUTIONS) {
    throw new Error(`Session creation contribution 超过上限：${registry.contributions.entries.length}`)
  }
  const artifacts: SessionCreationArtifactSnapshot[] = []
  const diagnostics: SessionCreationDiagnostic[] = []
  for (const entry of registry.contributions.entries) {
    const contribution = entry.value
    const policy = contribution.failurePolicy ?? 'optional'
    try {
      const rawPayload = typeof contribution.payload === 'function'
        ? contribution.payload(context)
        : contribution.payload
      if (rawPayload === null || rawPayload === undefined) continue
      const resolved: ResolvedSessionCreationContribution = Object.freeze({
        id: contribution.id,
        kind: contribution.kind,
        ownerPluginId: entry.ownerPluginId,
        ownerRuntimeInstanceId: entry.ownerRuntimeInstanceId,
        payload: normalizeSessionCreationJson(rawPayload, `${contribution.id}.payload`),
        order: contribution.order ?? entry.priority,
        failurePolicy: policy,
      })
      const compilers = registry.compilers.entries.filter(candidate => candidate.value.kind === resolved.kind)
      if (compilers.length !== 1) {
        throw new Error(compilers.length === 0
          ? `没有 compiler：${resolved.kind}`
          : `compiler 不唯一：${resolved.kind}`)
      }
      const startedAt = performance.now()
      const output = compilers[0].value.compile(resolved, context)
      const elapsed = performance.now() - startedAt
      if (elapsed > COMPILER_BUDGET_MS) throw new Error(`compiler 超出 ${COMPILER_BUDGET_MS}ms 预算：${resolved.kind}`)
      if (!Array.isArray(output)) throw new Error(`compiler 必须返回 artifact 数组：${resolved.kind}`)
      output.forEach((artifact, index) => artifacts.push(validateArtifact(artifact, resolved, index)))
    } catch (error) {
      if (policy === 'required') throw error
      diagnostics.push(diagnostic(entry, error))
    }
  }
  artifacts.sort((a, b) => a.order - b.order || a.ownerPluginId.localeCompare(b.ownerPluginId) || a.id.localeCompare(b.id))
  const artifactBytes = new TextEncoder().encode(JSON.stringify(artifacts)).byteLength
  if (artifactBytes > MAX_ARTIFACT_BYTES) throw new Error(`Session creation artifact 超过 ${MAX_ARTIFACT_BYTES} bytes 预算`)
  return Object.freeze({
    version: 1,
    createdAt: now,
    registryRevision: registry.revision,
    artifacts: Object.freeze(artifacts),
    diagnostics: Object.freeze(diagnostics),
  })
}

export function normalizeSessionCreationSnapshot(value: unknown): SessionCreationSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<SessionCreationSnapshot>
  if (raw.version !== 1 || !Number.isFinite(raw.createdAt) || !Number.isFinite(raw.registryRevision)) return undefined
  if (!Array.isArray(raw.artifacts) || !Array.isArray(raw.diagnostics)) return undefined
  try {
    const artifacts = raw.artifacts.map((artifact, index) => {
      if (!artifact || typeof artifact !== 'object') throw new Error(`artifact[${index}] 非法`)
      const item = artifact as SessionCreationArtifactSnapshot
      if (!item.id || !NAMESPACED_KIND.test(item.phase) || !NAMESPACED_KIND.test(item.kind)) throw new Error(`artifact[${index}] 非法`)
      return Object.freeze({
        ...item,
        ownerRuntimeInstanceId: typeof item.ownerRuntimeInstanceId === 'string' ? item.ownerRuntimeInstanceId : '',
        failurePolicy: item.failurePolicy === 'required' ? 'required' : 'optional',
        payload: normalizeSessionCreationJson(item.payload, `artifact[${index}].payload`),
      })
    })
    const diagnostics = raw.diagnostics.map(item => Object.freeze({ ...item })) as SessionCreationDiagnostic[]
    return Object.freeze({
      version: 1,
      createdAt: raw.createdAt!,
      registryRevision: raw.registryRevision!,
      artifacts: Object.freeze(artifacts),
      diagnostics: Object.freeze(diagnostics),
    })
  } catch {
    return undefined
  }
}
