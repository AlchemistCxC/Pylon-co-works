import type {
  CoverageEvidence, CoverageEvidenceClaim, CoverageItem, CoverageItemDraft,
  ProviderCoverageSummary, ProviderName, TransportStatus,
} from './providerCoverageInventory.ts'
import { CLAUDE_CODE_COVERAGE } from './claudeCodeCoverage.ts'
import { PERI_COVERAGE } from './periCoverage.ts'
import { HERMES_COVERAGE } from './hermesCoverage.ts'

export * from './providerCoverageInventory.ts'

const TRANSPORT_OVERRIDES: Readonly<Partial<Record<string, TransportStatus>>> = {
  // Provider prompt response is not a session/update. The host observes it and
  // commits a separate canonical `done`, losing provider result detail.
  'cc-14': 'SYNTHETIC',
}

/** Explicit transport audit. Deliberately independent from CoverageStatus so a
 * status edit cannot silently promote provider-source-only rows onto the wire. */
const SOURCE_ONLY_IDS = new Set([
  'cc-05', 'cc-10', 'cc-11', 'cc-13', 'cc-15', 'cc-16', 'cc-18', 'cc-19', 'cc-20', 'cc-21', 'cc-22', 'cc-23',
  'peri-05', 'peri-06', 'peri-07', 'peri-08', 'peri-10', 'peri-11', 'peri-12', 'peri-13', 'peri-14',
  'peri-15', 'peri-16', 'peri-17', 'peri-18', 'peri-19', 'peri-20', 'peri-21', 'peri-22', 'peri-23',
  'peri-24', 'peri-25', 'peri-26', 'peri-27', 'peri-34', 'peri-36', 'peri-37', 'peri-38', 'peri-44',
  'peri-28',
  'hm-05', 'hm-07', 'hm-08', 'hm-09', 'hm-10', 'hm-11', 'hm-12',
])

const SOURCE_REVISIONS: Readonly<Record<ProviderName, string>> = {
  'claude-code': 'package 2.8.4 source snapshot',
  peri: 'ef45872c0a725ef8acda5afffb6e45cabeeff9e3',
  hermes: '73997c41bb4950f259898e16fc22f97de2d760cc',
}

const FIXTURE_PATHS: Readonly<Record<string, string>> = {
  'acpNormalizer.test.ts': 'src/domains/workbench/normalizers/__tests__/acpNormalizer.test.ts',
  'activityProcessProjector.test.ts': 'src/domains/workbench/__tests__/activityProcessProjector.test.ts',
  'activitySubagentProjector.test.ts': 'src/domains/workbench/__tests__/activitySubagentProjector.test.ts',
  'activityWorkflowProjector.test.ts': 'src/domains/workbench/__tests__/activityWorkflowProjector.test.ts',
  'claudeCodeNormalizer.test.ts': 'src/domains/workbench/normalizers/__tests__/claudeCodeNormalizer.test.ts',
  'contentClassification.test.ts': 'src/domains/workbench/normalizers/__tests__/contentClassification.test.ts',
  'diffLspSnapshot.test.ts': 'src/domains/workbench/__tests__/diffLspSnapshot.test.ts',
  'goalModel.test.ts': 'src/domains/workbench/plan/__tests__/goalModel.test.ts',
  'hermesNormalizer.test.ts': 'src/domains/workbench/normalizers/__tests__/hermesNormalizer.test.ts',
  'interactionProjection.test.ts': 'src/domains/workbench/__tests__/interactionProjection.test.ts',
  'memorySkillArtifactParts.test.ts': 'src/domains/workbench/content/__tests__/memorySkillArtifactParts.test.ts',
  'periNormalizer.test.ts': 'src/domains/workbench/normalizers/__tests__/periNormalizer.test.ts',
  'searchLinkClassification.test.ts': 'src/domains/workbench/normalizers/__tests__/searchLinkClassification.test.ts',
  'secretInteractionProjection.test.ts': 'src/domains/workbench/__tests__/secretInteractionProjection.test.ts',
  'terminalSnapshot.test.ts': 'src/domains/workbench/__tests__/terminalSnapshot.test.ts',
  'usageBudgetProjection.test.ts': 'src/domains/workbench/__tests__/usageBudgetProjection.test.ts',
  'workbenchProjector.test.ts': 'src/domains/workbench/__tests__/workbenchProjector.test.ts',
  'workbenchProjectorLifecycle.test.ts': 'src/domains/workbench/__tests__/workbenchProjectorLifecycle.test.ts',
  'workbenchProjectorPlan.test.ts': 'src/domains/workbench/__tests__/workbenchProjectorPlan.test.ts',
  'workbenchProjectorReasoning.test.ts': 'src/domains/workbench/__tests__/workbenchProjectorReasoning.test.ts',
  'workbenchProjectorToolLifecycle.test.ts': 'src/domains/workbench/__tests__/workbenchProjectorToolLifecycle.test.ts',
  'c15ContentNormalization.test.ts': 'src/domains/workbench/content/__tests__/c15ContentNormalization.test.ts',
  'extensionNormalizer.test.ts': 'src/domains/workbench/normalizers/__tests__/extensionNormalizer.test.ts',
  'c15SlotLifecycle.test.ts': 'src/domains/rendererContent/__tests__/c15SlotLifecycle.test.ts',
}

const PROVIDER_WIRE_FIXTURES: Readonly<Record<ProviderName, readonly string[]>> = {
  'claude-code': ['F:/A-I/Agent/claude-code-main/src/services/acp/__tests__/bridge.test.ts'],
  peri: [
    'F:/A-I/Agent/Peri/peri-acp/src/event/mapper_test.rs',
    'F:/A-I/Agent/Peri/peri-acp/tests/integration_test.rs',
  ],
  hermes: [
    'F:/Hermes/hermes-agent/tests/acp/test_events.py',
    'F:/Hermes/hermes-agent/tests/acp/test_tools.py',
  ],
}

function verified(refs: readonly string[], note: string): CoverageEvidenceClaim {
  return { state: 'verified', refs, note }
}

function notApplicable(reason: string): CoverageEvidenceClaim {
  return { state: 'not-applicable', reason }
}

function fixtureRefs(item: CoverageItemDraft): readonly string[] {
  return [...new Set(item.fixtures.map((fixture) => {
    const basename = fixture.replace(/\(.+$/, '')
    return FIXTURE_PATHS[basename] ?? basename
  }))]
}

function sourceEvidence(item: CoverageItemDraft) {
  const refs = item.provider === 'claude-code'
    ? item.dictionarySection.startsWith('§二')
      ? [
          'F:/A-I/Agent/claude-code-main/src/types/message.ts',
          'F:/A-I/Agent/claude-code-main/src/services/acp/bridge/forwarding.ts',
          'F:/A-I/Agent/claude-code-main/src/services/acp/bridge/notifications.ts',
        ]
      : [
          'F:/A-I/Agent/claude-code-main/src/tools.ts',
          'F:/A-I/Agent/claude-code-main/src/services/acp/bridge/toolInfo.ts',
          'F:/A-I/Agent/claude-code-main/src/services/acp/bridge/toolResults.ts',
        ]
    : item.provider === 'peri'
      ? [item.dictionarySection.startsWith('§四')
          ? 'F:/A-I/Agent/Peri/peri-acp-types/src/event_v2.rs'
          : 'F:/A-I/Agent/Peri/peri-acp/src/event/mapper.rs']
      : [item.dictionarySection.startsWith('§六')
          ? 'F:/Hermes/hermes-agent/acp_adapter/events.py'
          : 'F:/Hermes/hermes-agent/acp_adapter/tools.py']
  return {
    state: 'verified' as const,
    refs,
    note: `${SOURCE_REVISIONS[item.provider]} / ${item.dictionarySection}: ${item.wireSymbol}`,
  }
}

function solidRendererRefs(item: CoverageItemDraft): readonly string[] {
  const semantic = `${item.semanticEvent} ${item.renderKind}`
  const refs = new Set<string>(['src/renderers/solid-workbench/SolidWorkbenchApp.solid.tsx'])
  if (semantic.includes('tool.')) refs.add('src/renderers/solid-workbench/chat/ToolInvocationCard.solid.tsx')
  if (semantic.includes('content.') || semantic.includes('diagnostic.')) refs.add('src/renderers/solid-workbench/chat/BuiltinSolidContentSlot.solid.tsx')
  if (semantic.includes('activity.')) {
    if (/process|terminal/.test(semantic)) refs.add('src/renderers/solid-workbench/chat/content/TerminalBlock.solid.tsx')
    if (/background|workflow/.test(semantic)) refs.add('src/renderers/solid-workbench/chat/content/WorkflowCard.solid.tsx')
    if (/subagent|delegation|team/.test(semantic)) refs.add('src/renderers/solid-workbench/chat/content/SubagentCard.solid.tsx')
    if (![...refs].some(ref => /TerminalBlock|WorkflowCard|SubagentCard/.test(ref))) {
      refs.add('src/renderers/solid-workbench/chat/content/SubagentCard.solid.tsx')
    }
  }
  if (semantic.includes('interaction.')) refs.add('src/renderers/solid-workbench/chat/content/InteractionCard.solid.tsx')
  if (/plan\.|goal\./.test(semantic)) {
    refs.add('src/renderers/solid-workbench/chat/GoalCard.solid.tsx')
    refs.add('src/renderers/solid-workbench/chat/content/PlanGoalContent.solid.tsx')
  }
  if (semantic.includes('lifecycle.')) refs.add('src/renderers/solid-workbench/chat/LifecycleCard.solid.tsx')
  if (/usage\.|budget\.|session\./.test(semantic)) refs.add('src/renderers/solid-workbench/chat/content/SessionSurfaceCard.solid.tsx')
  if (/message\.|reasoning\./.test(semantic)) refs.add('src/renderers/solid-workbench/chat/MessageRow.solid.tsx')
  return [...refs]
}

function settingsSchemaRefs(item: CoverageItemDraft): readonly string[] {
  const semantic = `${item.semanticEvent} ${item.renderKind}`
  const refs = new Set<string>()
  if (semantic.includes('tool.')) refs.add('src/domains/rendererContent/toolRenderKindCatalog.ts')
  if (semantic.includes('content.') || semantic.includes('message.') || semantic.includes('reasoning.') || semantic.includes('diagnostic.')) {
    refs.add('src/domains/rendererContent/textRenderKindCatalog.ts')
  }
  if (semantic.includes('activity.')) refs.add('src/domains/rendererContent/executionRenderKindCatalog.ts')
  if (semantic.includes('interaction.')) refs.add('src/domains/rendererContent/interactionRenderKindCatalog.ts')
  if (/usage\.|budget\.|session\./.test(semantic)) refs.add('src/domains/rendererContent/sessionRenderKindCatalog.ts')
  if (/plan\.|goal\.|lifecycle\./.test(semantic)) refs.add('src/plugins/core/renderer/builtinRenderContent.ts')
  if (refs.size === 0) refs.add('src/domains/rendererContent/textRenderKindCatalog.ts')
  return [...refs]
}

function rendererTestRefs(item: CoverageItemDraft): readonly string[] {
  const semantic = `${item.semanticEvent} ${item.renderKind}`
  const refs = new Set(fixtureRefs(item))
  refs.add('src/sheets/agent-workbench/__tests__/ReactWorkbenchFatalFallback.test.tsx')
  refs.add('src/renderers/solid-workbench/__tests__/mountSolidWorkbench.solid.test.tsx')
  if (semantic.includes('tool.')) refs.add('src/renderers/solid-workbench/chat/__tests__/ToolInvocationCard.solid.test.tsx')
  if (semantic.includes('activity.')) refs.add('src/renderers/solid-workbench/chat/content/__tests__/SubagentCard.solid.test.tsx')
  if (semantic.includes('interaction.')) refs.add('src/renderers/solid-workbench/chat/content/__tests__/InteractionCard.solid.test.tsx')
  if (/usage\.|budget\.|session\./.test(semantic)) refs.add('src/renderers/solid-workbench/chat/content/__tests__/SessionSurfaceCard.solid.test.tsx')
  if (/plan\.|goal\./.test(semantic)) refs.add('src/renderers/solid-workbench/chat/__tests__/GoalCard.solid.test.tsx')
  if (semantic.includes('lifecycle.')) refs.add('src/renderers/solid-workbench/chat/__tests__/LifecycleCard.solid.test.tsx')
  if (/message\.|reasoning\./.test(semantic)) refs.add('src/renderers/solid-workbench/chat/__tests__/MessageRow.solid.test.tsx')
  return [...refs]
}

function normalizerRefs(item: CoverageItemDraft): readonly string[] {
  const adapter = item.provider === 'claude-code'
    ? 'src/domains/workbench/normalizers/claudeCodeNormalizer.ts'
    : `src/domains/workbench/normalizers/${item.provider}Normalizer.ts`
  return [adapter, 'src/domains/workbench/normalizers/acpNormalizer.ts']
}

function wireFixtureRefs(item: CoverageItemDraft, transportStatus: TransportStatus): readonly string[] {
  if (transportStatus === 'SYNTHETIC') {
    return [
      ...PROVIDER_WIRE_FIXTURES[item.provider],
      'src-tauri/src/session/prompt.rs',
      'src/components/chat/__tests__/canonicalEventDoubleWrite.test.ts',
      'src/domains/workbench/coverage/__tests__/providerCoverage.test.ts',
    ]
  }
  return [
    ...PROVIDER_WIRE_FIXTURES[item.provider],
    'src/domains/workbench/coverage/__tests__/providerCoverage.test.ts',
    ...fixtureRefs(item),
  ]
}

function closeEvidence(item: CoverageItemDraft, transportStatus: TransportStatus): CoverageEvidence {
  const source = sourceEvidence(item)
  if (transportStatus === 'SOURCE-ONLY/BACKLOG') {
    const reason = item.followUp || 'provider source exists but the current ACP bridge exposes no carrier'
    const unavailable = { state: 'unavailable' as const, reason }
    const downstreamReason = `${item.id} has no observable ACP wire; downstream target seams are not consumption evidence`
    return {
      source,
      wireFixture: unavailable,
      identity: notApplicable(downstreamReason),
      provenance: notApplicable(downstreamReason),
      normalizer: notApplicable(downstreamReason),
      projector: notApplicable(downstreamReason),
      solidRenderer: notApplicable(downstreamReason),
      reactFallback: notApplicable(downstreamReason),
      settingsSchema: notApplicable(downstreamReason),
      pluginLifecycle: notApplicable(downstreamReason),
      tests: notApplicable(downstreamReason),
    }
  }

  const tests = rendererTestRefs(item)
  const normalizers = normalizerRefs(item)
  const wireFixtures = wireFixtureRefs(item, transportStatus)
  const semanticNote = `${item.semanticEvent || 'event.unknown'} → ${item.renderKind || 'SolidWorkbenchApp surface'}`
  return {
    source,
    wireFixture: verified(wireFixtures, `${transportStatus}: ${item.wireSymbol}`),
    identity: verified(['src/domains/workbench/events/workbenchEventSchema.ts'], item.firstClassFields.join(', ') || 'canonical envelope identity'),
    provenance: transportStatus === 'SYNTHETIC'
      ? { state: 'unavailable', reason: 'host synthetic done is committed as local-observed but currently lacks provenance.synthetic.reason/orderConfidence=observed' }
      : verified(['src/domains/workbench/events/workbenchEventSchema.ts'], 'origin/trust/orderConfidence stay on the canonical envelope'),
    normalizer: verified(normalizers, semanticNote),
    projector: verified(['src/domains/workbench/workbenchProjector.ts'], semanticNote),
    solidRenderer: verified(solidRendererRefs(item), semanticNote),
    reactFallback: verified(['src/sheets/agent-workbench/ReactWorkbenchFatalFallback.tsx'], semanticNote),
    settingsSchema: verified(settingsSchemaRefs(item), item.renderKind || 'surface settings are resolved by the active Suite'),
    pluginLifecycle: verified([
      'src/renderers/solid-workbench/builtinSolidRendererSuite.ts',
      'src/plugin-runtime/renderers/__tests__/rendererLifecycle.integration.test.tsx',
    ], 'family-level base/overlay Slot ownership and cleanup invariant; not an independent provider-row lifecycle'),
    tests: verified(tests.length > 0 ? tests : wireFixtures, `coverage tests for ${item.id}`),
  }
}

function closeTransportGate(items: readonly CoverageItemDraft[]): readonly CoverageItem[] {
  return items.map((item) => {
    const transportStatus = TRANSPORT_OVERRIDES[item.id]
      ?? (SOURCE_ONLY_IDS.has(item.id) ? 'SOURCE-ONLY/BACKLOG' : 'WIRE-STANDARD')
    const sourceOnly = transportStatus === 'SOURCE-ONLY/BACKLOG'
    return {
      ...item,
      fixtures: sourceOnly ? [] : item.fixtures,
      pylonAnchors: sourceOnly ? [] : item.pylonAnchors,
      transportStatus,
      evidence: closeEvidence(item, transportStatus),
    }
  })
}

export const PROVIDER_COVERAGE: Readonly<Record<'claude-code' | 'peri' | 'hermes', readonly CoverageItem[]>> = {
  'claude-code': closeTransportGate(CLAUDE_CODE_COVERAGE),
  peri: closeTransportGate(PERI_COVERAGE),
  hermes: closeTransportGate(HERMES_COVERAGE),
}

/** 字典 §十 的映射单元口径（44/46/31）——inventory 行数必须与之精确一致。 */
export const EXPECTED_UNITS: Record<'claude-code' | 'peri' | 'hermes', number> = {
  'claude-code': 44,
  peri: 46,
  hermes: 31,
}

import type { CoverageStatus } from './providerCoverageInventory.ts'

const EMPTY_STATUS: Record<CoverageStatus, number> = {
  normalized: 0, 'flattened-with-reason': 0, 'not-transported': 0, 'unknown-fallback': 0,
}

export function summarize(provider: 'claude-code' | 'peri' | 'hermes'): ProviderCoverageSummary {
  const items = PROVIDER_COVERAGE[provider]
  const byStatus: Record<CoverageStatus, number> = { ...EMPTY_STATUS }
  for (const item of items) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1
  return { provider, totalUnits: items.length, byStatus }
}

export function allCoverageItems(): readonly CoverageItem[] {
  return Object.values(PROVIDER_COVERAGE).flat()
}
