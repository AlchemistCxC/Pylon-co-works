import assert from 'node:assert/strict'
import { normalizeWorkspaceEntries, workspaceTreeFromEntries } from '../src/components/right-panel/workspaceApi.ts'

const entries = normalizeWorkspaceEntries([
  { name: 'src', relativePath: 'src', kind: 'directory', expandable: true },
  { name: 'main.ts', relativePath: 'src/main.ts', kind: 'file' },
  { name: 'link', relativePath: 'link', kind: 'symlink' },
  { name: 'other', relativePath: 'other', kind: 'other' },
  null,
])

assert.deepEqual(entries, [
  { label: 'src', path: 'src', kind: 'folder', expandable: true },
  { label: 'main.ts', path: 'src/main.ts', kind: 'file', expandable: false },
])
assert.deepEqual(workspaceTreeFromEntries([]), { entries: [], selectedPath: null })
assert.deepEqual(normalizeWorkspaceEntries({}), [])

console.log('Workspace API adapter normalization: PASS')
