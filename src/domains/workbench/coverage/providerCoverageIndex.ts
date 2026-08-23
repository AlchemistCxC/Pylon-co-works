import type { CoverageItem, ProviderCoverageSummary } from './providerCoverageInventory.ts'
import { CLAUDE_CODE_COVERAGE } from './claudeCodeCoverage.ts'
import { PERI_COVERAGE } from './periCoverage.ts'
import { HERMES_COVERAGE } from './hermesCoverage.ts'

export * from './providerCoverageInventory.ts'

export const PROVIDER_COVERAGE: Readonly<Record<'claude-code' | 'peri' | 'hermes', readonly CoverageItem[]>> = {
  'claude-code': CLAUDE_CODE_COVERAGE,
  peri: PERI_COVERAGE,
  hermes: HERMES_COVERAGE,
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
  return [...CLAUDE_CODE_COVERAGE, ...PERI_COVERAGE, ...HERMES_COVERAGE]
}
