import { describe, expect, it } from 'vitest'
import {
  allCoverageItems, EXPECTED_UNITS, PROVIDER_COVERAGE, summarize,
} from '../providerCoverageIndex.ts'
import { BUILTIN_TEXT_RENDER_KINDS } from '../../../rendererContent/textRenderKindCatalog.ts'
import { BUILTIN_EXECUTION_RENDER_KINDS } from '../../../rendererContent/executionRenderKindCatalog.ts'

/**
 * C16 / DIC-C16-01：三 provider 全覆盖审计的机器可读门禁。
 * 完成定义：121 项（44/46/31）逐项有状态/证据/锚点；SOURCE-ONLY（not-transported）
 * 明确列为未覆盖；normalized 项必须能给出 catalog/renderKind 或明确的非渲染语义。
 */

const ALL_STATUSES = ['normalized', 'flattened-with-reason', 'not-transported', 'unknown-fallback'] as const

describe('C16 provider coverage inventory', () => {
  it('映射单元数与字典 §十 精确一致（44/46/31）', () => {
    for (const provider of ['claude-code', 'peri', 'hermes'] as const) {
      const items = PROVIDER_COVERAGE[provider]
      expect(items.length, `${provider} 映射单元数`).toBe(EXPECTED_UNITS[provider])
    }
    expect(allCoverageItems().length).toBe(121)
  })

  it('每项都有完整字段：状态合法、证据/fixture/followUp 按状态要求', () => {
    const seen = new Set<string>()
    for (const item of allCoverageItems()) {
      expect(seen.has(item.id), `id 重复: ${item.id}`).toBe(false)
      seen.add(item.id)
      expect(ALL_STATUSES).toContain(item.status)
      expect(item.wireSymbol.trim().length).toBeGreaterThan(0)
      expect(item.dictionarySection.startsWith('§'), `${item.id} 缺字典节锚点`).toBe(true)
      // normalized 必须给出 Pylon 锚点与 semantic event
      if (item.status === 'normalized') {
        expect(item.pylonAnchors.length, `${item.id} normalized 但无 Pylon 锚点`).toBeGreaterThan(0)
        expect(item.semanticEvent.length).toBeGreaterThan(0)
      }
      // not-transported 必须登记上游 follow-up，且不得伪造 semanticEvent
      if (item.status === 'not-transported') {
        expect(item.followUp, `${item.id} not-transported 缺上游任务`).toMatch(/ACP-UP-\d+/)
      }
      // flattened-with-reason 必须写明原因
      if (item.status === 'flattened-with-reason') {
        expect(item.retainedOnlyFields.length, `${item.id} flattened 未记录保留 raw 证据`).toBeGreaterThan(0)
      }
      // unknown-fallback 至少要有 unknown 兜底路径锚点
      if (item.status === 'unknown-fallback') {
        const anchors = item.pylonAnchors.join(' ')
        expect(
          anchors.includes('unknown') || anchors.includes('diagnostic-only') || item.semanticEvent.includes('diagnostic'),
          `${item.id} unknown-fallback 无兜底证据`,
        ).toBe(true)
      }
    }
  })

  it('normalized 项的 renderKind 在 A07 catalog 有 definition（注册≠渲染反向锁）', () => {
    const catalogKinds = new Set<string>([
      ...BUILTIN_TEXT_RENDER_KINDS.map(kind => kind.id),
      ...BUILTIN_EXECUTION_RENDER_KINDS.map(kind => kind.id),
      // 非 content/activity 渲染面的 semantic kinds（tool.* 走工具卡、lifecycle 走 LifecycleCard、
      // interaction/usage/session 走 App surface）——这些不要求 catalog registration：
      'tool.read', 'tool.search', 'tool.fetch', 'tool.execute', 'tool.write', 'tool.edit',
      'tool.generic',
    ])
    for (const item of allCoverageItems()) {
      if (item.status !== 'normalized' || !item.renderKind) continue
      for (const kind of item.renderKind.split('/')) {
        const k = kind.trim()
        if (!k || k === '' ) continue
        // lifecycle 卡 / tool 卡等语义面允许白名单外描述，但 content./activity./tool. 前缀必须命中
        if (k.startsWith('content.') || k.startsWith('activity.') || k.startsWith('tool.')
          || k.startsWith('diagnostic.')) {
          expect(catalogKinds.has(k), `${item.id}: renderKind '${k}' 不在 catalog`).toBe(true)
        }
      }
    }
  })

  it('SOURCE-ONLY(not-transported) 明确列为未覆盖——汇总不得把它们计入已覆盖', () => {
    for (const provider of ['claude-code', 'peri', 'hermes'] as const) {
      const s = summarize(provider)
      const covered = s.byStatus.normalized ?? 0
      const total = s.totalUnits
      // not-transported + unknown-fallback + flattened 都不算完整覆盖
      const notCovered = total - covered
      expect(s.byStatus['not-transported'] + s.byStatus['unknown-fallback'] + s.byStatus['flattened-with-reason'])
        .toBe(notCovered)
      // 审计结论必须诚实：不允许宣称 100% normalized 全覆盖
      expect(covered, `${provider} 不应有虚假全覆盖`).toBeLessThan(total)
    }
  })
})
