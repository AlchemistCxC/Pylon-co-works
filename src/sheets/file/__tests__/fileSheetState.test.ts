// 迁移自 scripts/test-file-sheet-state.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { createFileSheetState, fileSheetReducer, resetFileSheetTransientState, type FileSheetState } from '../fileSheetState.ts'

describe('fileSheetState target/section reducer', () => {
  it('createFileSheetState：初始 section 为 explorer，target 绑定 sessionId', () => {
    expect(createFileSheetState('session-a')).toEqual({ activeSection: 'builtin.file.explorer', targetSessionId: 'session-a' })
  })

  it('set-section：切换 section 不动 target', () => {
    let state: FileSheetState = createFileSheetState('session-a')
    state = fileSheetReducer(state, { type: 'set-section', section: 'plugin.activity' })
    expect(state.activeSection).toBe('plugin.activity')
    expect(state.targetSessionId).toBe('session-a')
  })

  it('set-target-session：可清空 target', () => {
    let state: FileSheetState = createFileSheetState('session-a')
    state = fileSheetReducer(state, { type: 'set-target-session', sessionId: null })
    expect(state.targetSessionId).toBeNull()
  })

  it('resetFileSheetTransientState：transient 字段复位', () => {
    expect(resetFileSheetTransientState()).toEqual({ truncated: false, instruction: '', fileContent: '' })
  })
})
