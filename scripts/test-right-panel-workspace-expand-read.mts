import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../src/components/', import.meta.url)
const right = await readFile(new URL('RightPanel.tsx', root), 'utf8')
const workspace = await readFile(new URL('right-panel/WorkspacePanel.tsx', root), 'utf8')
const types = await readFile(new URL('right-panel/rightPanelTypes.ts', root), 'utf8')
const api = await readFile(new URL('right-panel/workspaceApi.ts', root), 'utf8')

assert.match(right, /invoke<unknown>\('list_workspace_entries', \{ source: sessionSource, relativePath: path \}\)/)
assert.match(right, /invoke<unknown>\('read_workspace_text', \{ source: sessionSource, relativePath: path \}\)/)
assert.match(right, /mergeWorkspaceEntries\(state\.tree\.entries, path, children\)/)
assert.match(right, /normalizeWorkspaceText\(payload\)/)
assert.match(workspace, /onExpand\?: \(path: string\) => void/)
assert.match(workspace, /onRead\?: \(path: string\) => void/)
assert.match(workspace, /entry\.kind === 'folder' && entry\.expandable/)
assert.match(workspace, /entry\.kind === 'file'/)
assert.match(types, /WorkspaceTextPreview/)
assert.match(api, /mergeWorkspaceEntries/)
assert.match(api, /normalizeWorkspaceText/)

console.log('Workspace expand/read wiring: PASS')
