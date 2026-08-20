import assert from 'node:assert/strict'
import { normalizeWorkspaceEntries, workspaceTreeFromEntries, normalizeWorkspaceText, classifyWorkspaceError } from '../src/infrastructure/tauri/workspaceContracts.ts'

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

// W2-02：损坏 DTO 不崩（缺字段/非对象/二进制响应）
assert.deepEqual(normalizeWorkspaceEntries([{ name: 'x' }, { relativePath: 'y' }, 42, 'str']), [])
assert.equal(normalizeWorkspaceText(null), null)
assert.equal(normalizeWorkspaceText({ relativePath: 'a', content: 'x' }), null, '缺 bytesRead 等字段不崩')
assert.equal(normalizeWorkspaceText({ relativePath: 'b', content: 'y', bytesRead: 1, totalBytes: 2, truncated: false }).encoding, 'utf-8')
assert.deepEqual(normalizeWorkspaceEntries([{ name: 'bin', relativePath: 'bin.dat', kind: 'file' }]), [{ label: 'bin', path: 'bin.dat', kind: 'file', expandable: false }])

// W2-02：workspace_error 按 code 分支
assert.equal(classifyWorkspaceError(new Error('workspace_error: binary file')).code, 'binary')
assert.equal(classifyWorkspaceError('workspace_error: not_found').code, 'not_found')
assert.equal(classifyWorkspaceError('workspace_error: too_many entries').code, 'too_many')
assert.equal(classifyWorkspaceError(new Error('workspace_error: traversal detected')).code, 'traversal')
assert.equal(classifyWorkspaceError('something else').code, 'unknown')

console.log('Workspace API adapter normalization: PASS')
