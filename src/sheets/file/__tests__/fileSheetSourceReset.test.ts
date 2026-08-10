import { describe, expect, it } from 'vitest'
import { createFileSheetState, fileSheetReducer, resetFileSheetTransientState } from '../fileSheetState'

describe('FileSheet source clearing', () => {
  it('represents a cleared workspace explicitly and resets transient editor state', () => {
    const selected = createFileSheetState('workspace-a')
    expect(fileSheetReducer(selected, { type: 'set-source', source: null })).toEqual({
      activeSection: 'files',
      targetSource: null,
    })
    expect(resetFileSheetTransientState()).toEqual({
      truncated: false,
      instruction: '',
      fileContent: '',
    })
  })
})
