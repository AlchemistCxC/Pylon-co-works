import { describe, expect, it } from 'vitest'
import { resolveDocumentOptionValue } from '../workbenchOptionCatalog.ts'

describe('Workbench option catalog', () => {
  it('reads the provider-selected reasoning value from normalized options', () => {
    expect(resolveDocumentOptionValue([
      {
        id: 'thought_level',
        label: '思考强度',
        value: 'high',
        schema: { options: [{ id: 'low', label: 'low' }, { id: 'high', label: 'high' }] },
      },
    ], 'reasoning')).toBe('high')
  })
})
