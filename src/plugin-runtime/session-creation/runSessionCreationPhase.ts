import { normalizeSessionCreationJson } from './compileSessionCreationSnapshot.ts'
import type { SessionCreationRegistrySnapshot } from './sessionCreationRegistry.ts'
import type {
  SessionCreationArtifactHandler,
  SessionCreationArtifactSnapshot,
  SessionCreationDiagnostic,
  SessionCreationPhaseContext,
  SessionCreationPhaseEffect,
  SessionCreationPhaseResult,
  SessionCreationSnapshot,
} from './sessionCreationTypes.ts'

const HANDLER_BUDGET_MS = 5_000
const MAX_EFFECT_BYTES = 256 * 1024
const NAMESPACED_KIND = /^[a-z][a-z0-9.-]*(?:\/[a-z][a-z0-9._-]*)+$/

function artifactDiagnostic(artifact: SessionCreationArtifactSnapshot, error: unknown): SessionCreationDiagnostic {
  return Object.freeze({
    contributionId: artifact.sourceContributionId,
    ownerPluginId: artifact.ownerPluginId,
    message: error instanceof Error ? error.message : String(error),
  })
}

function normalizeEffects(value: void | readonly SessionCreationPhaseEffect[]): readonly SessionCreationPhaseEffect[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Session creation handler 必须返回 effect 数组或 void')
  return Object.freeze(value.map((effect, index) => {
    if (!effect || typeof effect !== 'object' || !NAMESPACED_KIND.test(effect.kind)) {
      throw new Error(`Session creation effect 非法：${index}`)
    }
    return Object.freeze({
      kind: effect.kind,
      payload: normalizeSessionCreationJson(effect.payload, `effect[${index}].payload`),
    })
  }))
}

function selectHandler(
  registry: SessionCreationRegistrySnapshot,
  artifact: SessionCreationArtifactSnapshot,
): SessionCreationArtifactHandler {
  const matches = registry.handlers.entries.filter(entry => (
    entry.value.phase === artifact.phase && entry.value.kind === artifact.kind
  ))
  const sameRuntime = matches.filter(entry => entry.ownerRuntimeInstanceId === artifact.ownerRuntimeInstanceId)
  const candidates = sameRuntime.length > 0 ? sameRuntime : matches
  if (candidates.length !== 1) {
    throw new Error(candidates.length === 0
      ? `没有 artifact handler：${artifact.phase} / ${artifact.kind}`
      : `artifact handler 不唯一：${artifact.phase} / ${artifact.kind}`)
  }
  return candidates[0].value
}

async function runWithBudget(
  handler: SessionCreationArtifactHandler,
  artifact: SessionCreationArtifactSnapshot,
  context: SessionCreationPhaseContext,
): Promise<readonly SessionCreationPhaseEffect[]> {
  if (context.signal.aborted) throw context.signal.reason ?? new DOMException('Aborted', 'AbortError')
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`artifact handler 超出 ${HANDLER_BUDGET_MS}ms 预算：${handler.id}`)), HANDLER_BUDGET_MS)
  })
  try {
    return normalizeEffects(await Promise.race([
      Promise.resolve(handler.run(artifact, context)),
      timeout,
    ]))
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function runSessionCreationPhase(
  registry: SessionCreationRegistrySnapshot,
  snapshot: SessionCreationSnapshot | undefined,
  phase: string,
  context: SessionCreationPhaseContext,
): Promise<SessionCreationPhaseResult> {
  if (!NAMESPACED_KIND.test(phase)) throw new Error(`Session creation phase 非法：${phase}`)
  const effects: SessionCreationPhaseEffect[] = []
  const diagnostics: SessionCreationDiagnostic[] = []
  for (const artifact of snapshot?.artifacts.filter(item => item.phase === phase) ?? []) {
    try {
      const handler = selectHandler(registry, artifact)
      effects.push(...await runWithBudget(handler, artifact, context))
    } catch (error) {
      if (artifact.failurePolicy === 'required') throw error
      diagnostics.push(artifactDiagnostic(artifact, error))
    }
  }
  const effectBytes = new TextEncoder().encode(JSON.stringify(effects)).byteLength
  if (effectBytes > MAX_EFFECT_BYTES) throw new Error(`Session creation effect 超过 ${MAX_EFFECT_BYTES} bytes 预算`)
  return Object.freeze({ effects: Object.freeze(effects), diagnostics: Object.freeze(diagnostics) })
}

