import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const panel = await readFile(resolve(root, 'src/components/right-panel/LogsPanel.tsx'), 'utf8')
const css = await readFile(resolve(root, 'src/components/right-panel/LogsPanel.css'), 'utf8')

for (const status of ['no-session', 'unwired', 'loading', 'empty', 'error']) {
  assert.match(panel, new RegExp(`state\\.status === ['"]${status}['"]`), `${status} branch is present`)
}
assert.match(panel, /<LogsList entries=\{state\.view\.entries\}/)
for (const field of ['entry.time', 'entry.level', 'entry.source', 'entry.message']) {
  assert.match(panel, new RegExp(field.replace('.', '\\.'), 's'), `${field} is rendered`)
}
assert.match(panel, /<time[^>]*>\{entry\.time\}<\/time>/)
assert.match(panel, /key=\{entry\.id\}/)
assert.doesNotMatch(panel, /dangerouslySetInnerHTML|innerHTML|invoke\(|listen\(/)
assert.match(panel, /LogsViewState/)
assert.match(panel, /import ['"]\.\/LogsPanel\.css['"]/)

for (const token of ['min-width: 0', 'overflow-wrap: anywhere', 'word-break: break-word', 'white-space: pre-wrap', 'overflow: auto']) {
  assert.match(css, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${token} protects the narrow panel`)
}
assert.match(css, /grid-template-columns/)
console.log('LogsPanel structure checks passed')
