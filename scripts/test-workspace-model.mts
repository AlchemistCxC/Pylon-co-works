import { strict as assert } from 'node:assert'
import {
  createWorkspaceViewState,
  transitionWorkspaceView,
  type WorkspaceTree,
  type WorkspaceViewState,
} from '../src/components/right-panel/rightPanelTypes.ts'

const emptyTree: WorkspaceTree = { entries: [], selectedPath: null }
const tree: WorkspaceTree = {
  selectedPath: null,
  entries: [
    { path: 'src', label: 'src', kind: 'folder', entries: [{ path: 'src/main.ts', label: 'main.ts', kind: 'file' }] },
  ],
}

const step = (state: WorkspaceViewState, type: Parameters<typeof transitionWorkspaceView>[1]) =>
  transitionWorkspaceView(state, type)

assert.deepEqual(createWorkspaceViewState(null), { status: 'no-session' })
assert.deepEqual(createWorkspaceViewState('session-1'), { status: 'unwired' })

let state = createWorkspaceViewState('session-1')
state = step(state, { type: 'begin-loading' })
assert.equal(state.status, 'loading')
state = step(state, { type: 'loaded', tree: emptyTree })
assert.deepEqual(state, { status: 'empty', tree: emptyTree })

state = step(state, { type: 'begin-loading' })
state = step(state, { type: 'loaded', tree })
assert.deepEqual(state, { status: 'ready', tree })
state = step(state, { type: 'select', path: 'src/main.ts' })
assert.equal(state.tree?.selectedPath, 'src/main.ts')

state = step(state, { type: 'failed', message: 'workspace unavailable' })
assert.deepEqual(state, { status: 'error', message: 'workspace unavailable', tree: { ...tree, selectedPath: 'src/main.ts' } })
state = step(state, { type: 'clear-session' })
assert.deepEqual(state, { status: 'no-session' })

// No-session is terminal for local loading events; this model never invokes a backend.
assert.deepEqual(step(state, { type: 'begin-loading' }), { status: 'no-session' })

console.log('workspace model 回归测试通过')
