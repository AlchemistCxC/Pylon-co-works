import { describe, expect, it } from 'vitest'
import { createFileSheetState, fileSheetReducer, resetFileSheetTransientState } from '../fileSheetState'

describe('FileSheet source clearing', () => {
  it('represents a cleared workspace explicitly and resets transient editor state', () => {
    const selected = createFileSheetState('workspace-a')
    expect(fileSheetReducer(selected, { type: 'set-target-session', sessionId: null })).toEqual({
      activeSection: 'builtin.file.explorer',
      targetSessionId: null,
    })
    expect(resetFileSheetTransientState()).toEqual({
      truncated: false,
      instruction: '',
      fileContent: '',
    })
  })
})
