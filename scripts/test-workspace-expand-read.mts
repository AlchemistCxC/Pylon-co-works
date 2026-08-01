import assert from 'node:assert/strict'
import { normalizeWorkspaceText, mergeWorkspaceEntries } from '../src/components/right-panel/workspaceApi.ts'

const tree = [{ path: 'src', label: 'src', kind: 'folder' as const, expandable: true }]
assert.deepEqual(mergeWorkspaceEntries(tree, 'src', [{ path: 'src/main.ts', label: 'main.ts', kind: 'file' as const }]), [
  { path: 'src', label: 'src', kind: 'folder', expandable: false, entries: [{ path: 'src/main.ts', label: 'main.ts', kind: 'file' }] },
])
assert.deepEqual(normalizeWorkspaceText({
  relativePath: 'src/main.ts', content: 'const x = 1', bytesRead: 11, totalBytes: 11, truncated: false,
}), {
  relativePath: 'src/main.ts', content: 'const x = 1', bytesRead: 11, totalBytes: 11, truncated: false, encoding: 'utf-8',
})
assert.equal(normalizeWorkspaceText({ relativePath: 'x', content: 'x' }), null)

console.log('Workspace expand/read adapter: PASS')
