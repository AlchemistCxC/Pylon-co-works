// 迁移自 scripts/test-workspace-model.mts（P91 A1）。
// 落位说明：rightPanelTypes.test.ts 已被并行 agent 用于 test-logs-model.mts 迁移（未提交在途），
// 为避免覆写他人在途文件，本脚本断言独立落位为同目录 workspaceModel.test.ts（查重无重复断言）。
import { describe, expect, it } from 'vitest'
import {
  createWorkspaceViewState,
  transitionWorkspaceView,
  type WorkspaceTree,
  type WorkspaceViewState,
} from '../rightPanelTypes.ts'

describe('workspace view 状态机（迁移自 scripts/test-workspace-model.mts，P91 A1）', () => {
  const emptyTree: WorkspaceTree = { entries: [], selectedPath: null }
  const tree: WorkspaceTree = {
    selectedPath: null,
    entries: [
      { path: 'src', label: 'src', kind: 'folder', entries: [{ path: 'src/main.ts', label: 'main.ts', kind: 'file' }] },
    ],
  }

  const step = (state: WorkspaceViewState, type: Parameters<typeof transitionWorkspaceView>[1]) =>
    transitionWorkspaceView(state, type)

  it('create：无 session → no-session；有 session → unwired', () => {
    expect(createWorkspaceViewState(null)).toEqual({ status: 'no-session' })
    expect(createWorkspaceViewState('session-1')).toEqual({ status: 'unwired' })
  })

  it('unwired → loading → empty / ready → select → failed → clear-session', () => {
    let state = createWorkspaceViewState('session-1')
    state = step(state, { type: 'begin-loading' })
    expect(state.status).toBe('loading')
    state = step(state, { type: 'loaded', tree: emptyTree })
    expect(state).toEqual({ status: 'empty', tree: emptyTree })

    state = step(state, { type: 'begin-loading' })
    state = step(state, { type: 'loaded', tree })
    expect(state).toEqual({ status: 'ready', tree })
    state = step(state, { type: 'select', path: 'src/main.ts' })
    // WorkspaceViewState 是 union：tree 仅在 ready/error 变体上，经 toMatchObject 断言
    expect(state).toMatchObject({ status: 'ready', tree: { selectedPath: 'src/main.ts' } })

    state = step(state, { type: 'failed', message: 'workspace unavailable' })
    expect(state).toEqual({ status: 'error', message: 'workspace unavailable', tree: { ...tree, selectedPath: 'src/main.ts' } })
    state = step(state, { type: 'clear-session' })
    expect(state).toEqual({ status: 'no-session' })
  })

  it('No-session is terminal for local loading events; this model never invokes a backend', () => {
    const state: WorkspaceViewState = { status: 'no-session' }
    expect(step(state, { type: 'begin-loading' })).toEqual({ status: 'no-session' })
  })
})
