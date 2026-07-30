import { strict as assert } from 'node:assert'
import { SHEET_REGISTRY, getSheetRegistryEntry, resolveSheetSingletonKey } from '../src/workspace-sheets/sheetRegistry.ts'
import { createSheetState, EMPTY_SHEET_STATE, sheetReducer } from '../src/workspace-sheets/sheetState.ts'

const agentA = { type: 'open' as const, now: 100, sheet: { kind: 'agent', title: 'Riccati', agentId: 'riccati' } }
const opened = sheetReducer(EMPTY_SHEET_STATE, agentA)
assert.equal(opened.sheets.length, 1)
assert.equal(opened.activeSheetId, opened.sheets[0].id)
assert.equal(opened.sheets[0].singletonKey, 'agent:riccati')

const duplicate = sheetReducer(opened, { ...agentA, now: 200 })
assert.equal(duplicate.sheets.length, 1)
assert.equal(duplicate.activeSheetId, opened.sheets[0].id)
assert.equal(duplicate.sheets[0].lastFocusedAt, 200)

const agentB = sheetReducer(duplicate, { type: 'open', now: 300, sheet: { kind: 'agent', title: 'Serina', agentId: 'serina' } })
const prism = sheetReducer(agentB, { type: 'open', now: 400, sheet: { kind: 'prism', title: 'Prism' } })
assert.equal(prism.sheets.length, 3)
assert.equal(resolveSheetSingletonKey({ kind: 'prism' }), 'prism')
assert.equal(getSheetRegistryEntry('unknown'), undefined)
assert.equal(Object.keys(SHEET_REGISTRY).length, 7)

const focused = sheetReducer(prism, { type: 'focus', id: agentB.sheets[0].id, now: 500 })
assert.equal(focused.activeSheetId, agentB.sheets[0].id)
assert.equal(focused.sheets[0].lastFocusedAt, 500)
assert.equal(sheetReducer(focused, { type: 'focus', id: 'missing', now: 600 }).activeSheetId, focused.activeSheetId)

const closed = sheetReducer(focused, { type: 'close', id: agentB.sheets[0].id, now: 700 })
assert.equal(closed.sheets.some(sheet => sheet.id === agentB.sheets[0].id), false)
assert.equal(closed.recentlyClosed[0].id, agentB.sheets[0].id)
assert.equal(closed.activeSheetId, prism.sheets[2].id)

const reopened = sheetReducer(closed, { type: 'reopen', now: 800 })
assert.equal(reopened.sheets.some(sheet => sheet.id === agentB.sheets[0].id), true)
assert.equal(reopened.activeSheetId, agentB.sheets[0].id)

const three = createSheetState(reopened.sheets, reopened.activeSheetId, reopened.recentlyClosed)
assert.equal(three.sheets.length, reopened.sheets.length)
assert.equal(createSheetState([{ ...reopened.sheets[0], kind: 'invalid' as never }]).sheets.length, 0)

const closeOthers = sheetReducer(three, { type: 'closeOthers', id: reopened.sheets[0].id, now: 900 })
assert.equal(closeOthers.sheets.length, 1)
assert.equal(closeOthers.activeSheetId, reopened.sheets[0].id)
assert.equal(closeOthers.recentlyClosed.length, 2)

const closeRightBase = sheetReducer(EMPTY_SHEET_STATE, { type: 'open', now: 1, sheet: { kind: 'file', title: 'a', singletonKey: 'a' } })
const closeRightWithB = sheetReducer(closeRightBase, { type: 'open', now: 2, sheet: { kind: 'file', title: 'b', singletonKey: 'b' } })
const closeRightWithC = sheetReducer(closeRightWithB, { type: 'open', now: 3, sheet: { kind: 'file', title: 'c', singletonKey: 'c' } })
const closeRight = sheetReducer(closeRightWithC, { type: 'closeRight', id: closeRightWithC.sheets[0].id, now: 4 })
assert.deepEqual(closeRight.sheets.map(sheet => sheet.title), ['a'])

console.log('F0.1 Sheet registry/reducer 回归测试通过')
