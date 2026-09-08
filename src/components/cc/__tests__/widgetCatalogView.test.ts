import { describe, expect, it } from 'vitest'
import { BUILTIN_CC_SURFACE_CONTRIBUTION, BUILTIN_CC_WIDGET_DEFINITIONS } from '../../../domains/cc/widgetCatalog.ts'
import { mergeCcWidgetCatalog } from '../widgetCatalogView.ts'

describe('mergeCcWidgetCatalog', () => {
  it('prefers builtin widgets on id collisions and retains plugin-only entries', () => {
    const result = mergeCcWidgetCatalog(BUILTIN_CC_WIDGET_DEFINITIONS, {
      revision: 1,
      entries: [
        { ownerPluginId: 'plugin.x', ownerRuntimeInstanceId: 'plugin.x@1', contributionId: 'input', layer: 'feature', priority: 1, value: { id: 'input', label: 'override' } },
        { ownerPluginId: 'plugin.x', ownerRuntimeInstanceId: 'plugin.x@1', contributionId: 'extra', layer: 'feature', priority: 1, value: { id: 'extra', label: 'Extra' } },
      ],
    })
    expect(result.find(item => item.id === 'input')?.label).toBe('输入栏')
    expect(result.some(item => item.id === 'extra')).toBe(true)
  })

  it('handles an empty catalog', () => {
    expect(mergeCcWidgetCatalog([], { revision: 0, entries: [] })).toEqual([])
  })

  it('exposes the six basic theme fields for the body surface', () => {
    const result = mergeCcWidgetCatalog([BUILTIN_CC_SURFACE_CONTRIBUTION], { revision: 0, entries: [] })
    expect(result[0].id).toBe('cc-surface')
    expect(result[0].propertyFields?.map(field => field.key)).toEqual([
      'ccHeight', 'ccMarginX', 'ccMarginBottom', 'ccRadius', 'ccBg', 'ccSurfaceOpacity',
    ])
  })
})
