/**
 * hookPipeline —— 产品 HookPhase 与插件 Hook Runtime 的类型适配层。
 */
import type {
  HookContext,
  HookPhase,
  HookPhaseResult,
} from '../contracts/agentHook.ts'
import { HookRuntime } from '../plugin-runtime/hooks/hookRuntime.ts'
import {
  HOOK_PHASE_MAP,
  runHookPhaseWithRuntime,
} from '../plugin-runtime/hooks/hookPhaseAdapter.ts'
import { getHookRuntime } from '../plugin-runtime/runtimeServices.ts'

export interface HookPipelineOptions {
  timeoutMs?: number
  failureLimit?: number
  cooldownMs?: number
  onObserveError?: (phase: HookPhase, pluginId: string, error: unknown) => void
}

export interface HookPipeline {
  hasEnabledHooks(phase: HookPhase, enabledPluginIds?: readonly string[]): boolean
  run(phase: HookPhase, context: HookContext, enabledPluginIds?: readonly string[]): Promise<HookPhaseResult>
  snapshot(): { pluginId: string; failures: number; openedAt: number | null }[]
  reset(): void
}

export function hasEnabledHooks(phase: HookPhase, enabledPluginIds?: readonly string[]): boolean {
  return getHookRuntime().hasEnabledHooks(HOOK_PHASE_MAP[phase], enabledPluginIds)
}

export function createHookPipeline(options: HookPipelineOptions = {}): HookPipeline {
  const runtime = options.timeoutMs === undefined && options.failureLimit === undefined
    && options.cooldownMs === undefined && options.onObserveError === undefined
    ? getHookRuntime()
    : new HookRuntime(undefined, {
      failureLimit: options.failureLimit,
      cooldownMs: options.cooldownMs,
    })
  return {
    hasEnabledHooks(phase, enabledPluginIds) {
      return runtime.hasEnabledHooks(HOOK_PHASE_MAP[phase], enabledPluginIds)
    },
    async run(phase, context, enabledPluginIds) {
      const result = await runHookPhaseWithRuntime(runtime, phase, context, enabledPluginIds)
      return result
    },
    snapshot: () => runtime.circuitsSnapshot(),
    reset: () => runtime.reset(),
  }
}

export const hookPipeline: HookPipeline = createHookPipeline()

export async function runHookPhase(
  phase: HookPhase,
  context: HookContext,
  enabledPluginIds?: readonly string[],
): Promise<HookPhaseResult> {
  return hookPipeline.run(phase, context, enabledPluginIds)
}

export function subscribeHookTraces(listener: () => void): () => void {
  return getHookRuntime().subscribeTrace(listener)
}

export function getHookTraceSnapshot() {
  return getHookRuntime().traceSnapshot()
}
