import { WORKBENCH_MESSAGE_FIXTURE } from './workbenchFixtures.ts'
import { DEFAULTS } from '../../../domains/theme/themeDefaults.ts'
import { createStaticWorkbenchAppearanceStore } from '../../../domains/workbench/workbenchAppearanceStore.ts'
import { createSessionUiStore } from '../../../domains/workbench/sessionUiStore.ts'
import { createFakeWorkbenchCommandFacade } from '../../../domains/workbench/workbenchCommandFacade.ts'
import { createPreviewWorkbenchRuntime } from '../../../domains/workbench/workbenchRuntime.ts'
import type { SolidWorkbenchServices } from '../workbenchContracts.ts'

export interface PreviewWorkbenchServices extends SolidWorkbenchServices {
  runtime: ReturnType<typeof createPreviewWorkbenchRuntime>
  appearance: ReturnType<typeof createStaticWorkbenchAppearanceStore>
  sessionUi: ReturnType<typeof createSessionUiStore>
  commands: ReturnType<typeof createFakeWorkbenchCommandFacade>
  destroy(): void
}

export function createPreviewWorkbenchServices(): PreviewWorkbenchServices {
  const runtime = createPreviewWorkbenchRuntime({
    sessionId: 'preview-session',
    status: 'ready',
    messages: [...WORKBENCH_MESSAGE_FIXTURE.messages],
    streamingText: WORKBENCH_MESSAGE_FIXTURE.streaming.text,
    streamingThinking: WORKBENCH_MESSAGE_FIXTURE.streaming.thinking,
    generating: true,
    generationPhase: { kind: 'responding' },
    generationStart: 1_000,
    lastTokenAt: 2_000,
    tokenCount: 12_480,
    summary: null,
    tasks: [...WORKBENCH_MESSAGE_FIXTURE.tasks],
    thinkingStart: 1_200,
    availableModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    activeModel: 'deepseek-v4-flash',
    availableModes: ['default', 'edit', 'auto', 'bypass'],
    activeMode: 'auto',
    canAttach: true,
    promptImage: false,
    error: null,
  })
  const appearance = createStaticWorkbenchAppearanceStore(structuredClone(DEFAULTS))
  const sessionUi = createSessionUiStore()
  const commands = createFakeWorkbenchCommandFacade()
  let destroyed = false

  return {
    runtime,
    appearance,
    sessionUi,
    commands,
    destroy() {
      if (destroyed) return
      destroyed = true
      runtime.destroy()
      appearance.destroy()
      sessionUi.destroy()
    },
  }
}
