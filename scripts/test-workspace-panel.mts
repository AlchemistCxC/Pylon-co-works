import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../src/components/right-panel/', import.meta.url)
const component = await readFile(new URL('WorkspacePanel.tsx', root), 'utf8')
const styles = await readFile(new URL('WorkspacePanel.css', root), 'utf8')
const types = await readFile(new URL('rightPanelTypes.ts', root), 'utf8')

for (const status of ['no-session', 'unwired', 'loading', 'empty', 'ready', 'error']) {
  assert.match(component, new RegExp(`status === ['\\"]${status}['\\"]`), `missing ${status} branch`)
}

assert.match(component, /WorkspaceViewState/)
assert.match(component, /WorkspaceEntry/)
assert.match(component, /entry\.path/)
assert.match(component, /entry\.label/)
assert.match(component, /entry\.kind/)
assert.match(component, /children\.map\(/)
assert.match(component, /stateTree\(state\)/)
assert.match(component, /state\.message/)
assert.match(component, /<PanelStatus/)
assert.match(component, /<WorkspaceTreeView/)
assert.match(component, /onSelect\?: \(path: string \| null\) => void/)
assert.doesNotMatch(component, /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML/)
assert.doesNotMatch(component, /invoke\(|fetch\(|axios|WebSocket/)

assert.match(types, /export interface WorkspaceEntry/)
assert.match(types, /export type WorkspaceViewState/)
assert.match(styles, /min-width:\s*0/)
assert.match(styles, /overflow-wrap:\s*anywhere/)
assert.match(styles, /word-break:\s*break-word/)
assert.match(styles, /text-overflow:\s*ellipsis/)

console.log('WorkspacePanel structure: PASS')
