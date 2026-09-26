import '../src/plugin-runtime/pluginCompositionRoot.ts'
import { describe, expect, it } from 'vitest'
import { getSheetRegistryEntry, resolveSheetSingletonKey } from '../src/workspace-sheets/sheetRegistry.ts'
import { getWorkspaceRegistrySnapshot } from '../src/workspace-sheets/workspaceRegistry.ts'
import { createSheetState, EMPTY_SHEET_STATE, sheetReducer } from '../src/workspace-sheets/sheetState.ts'
import { useLegacyCompatRuntime } from './legacyCompatHarness.mts'

useLegacyCompatRuntime()

const agentA = { type: 'open' as const, now: 100, sheet: { kind: 'agent', title: 'Profile A', agentId: 'profile-a' } }

describe('sheetState reducer legacy compat', () => {
  it('open 去重与 focus：singleton key 去重、focus 更新激活与时间戳', () => {
    const opened = sheetReducer(EMPTY_SHEET_STATE, agentA)
    expect(opened.sheets.length).toBe(1)
    expect(opened.activeSheetId).toBe(opened.sheets[0].id)
    expect(opened.sheets[0].singletonKey).toBe('agent:profile-a')

    const duplicate = sheetReducer(opened, { ...agentA, now: 200 })
    expect(duplicate.sheets.length).toBe(1)
    expect(duplicate.activeSheetId).toBe(opened.sheets[0].id)
    expect(duplicate.sheets[0].lastFocusedAt).toBe(200)

    const agentB = sheetReducer(duplicate, { type: 'open', now: 300, sheet: { kind: 'agent', title: 'Profile B', agentId: 'profile-b' } })
    const prism = sheetReducer(agentB, { type: 'open', now: 400, sheet: { kind: 'prism', title: 'Prism' } })
    expect(prism.sheets.length).toBe(3)

    const focused = sheetReducer(prism, { type: 'focus', id: agentB.sheets[0].id, now: 500 })
    expect(focused.activeSheetId).toBe(agentB.sheets[0].id)
    expect(focused.sheets[0].lastFocusedAt).toBe(500)
    expect(sheetReducer(focused, { type: 'focus', id: 'missing', now: 600 }).activeSheetId).toBe(focused.activeSheetId)
  })

  it('close 与 reopen：close 记入 recentlyClosed、reopen 恢复并激活', () => {
    const opened = sheetReducer(EMPTY_SHEET_STATE, agentA)
    const duplicate = sheetReducer(opened, { ...agentA, now: 200 })
    const agentB = sheetReducer(duplicate, { type: 'open', now: 300, sheet: { kind: 'agent', title: 'Profile B', agentId: 'profile-b' } })
    const prism = sheetReducer(agentB, { type: 'open', now: 400, sheet: { kind: 'prism', title: 'Prism' } })
    const focused = sheetReducer(prism, { type: 'focus', id: agentB.sheets[0].id, now: 500 })

    const closed = sheetReducer(focused, { type: 'close', id: agentB.sheets[0].id, now: 700 })
    expect(closed.sheets.some(sheet => sheet.id === agentB.sheets[0].id)).toBe(false)
    expect(closed.recentlyClosed[0].id).toBe(agentB.sheets[0].id)
    expect(closed.activeSheetId).toBe(prism.sheets[2].id)

    const reopened = sheetReducer(closed, { type: 'reopen', now: 800 })
    expect(reopened.sheets.some(sheet => sheet.id === agentB.sheets[0].id)).toBe(true)
    expect(reopened.activeSheetId).toBe(agentB.sheets[0].id)
  })

  it('closeOthers 与 closeRight：保留目标（含左侧）并归档被关 sheet', () => {
    const opened = sheetReducer(EMPTY_SHEET_STATE, agentA)
    const duplicate = sheetReducer(opened, { ...agentA, now: 200 })
    const agentB = sheetReducer(duplicate, { type: 'open', now: 300, sheet: { kind: 'agent', title: 'Profile B', agentId: 'profile-b' } })
    const prism = sheetReducer(agentB, { type: 'open', now: 400, sheet: { kind: 'prism', title: 'Prism' } })
    const focused = sheetReducer(prism, { type: 'focus', id: agentB.sheets[0].id, now: 500 })
    const closed = sheetReducer(focused, { type: 'close', id: agentB.sheets[0].id, now: 700 })
    const reopened = sheetReducer(closed, { type: 'reopen', now: 800 })
    const three = createSheetState(reopened.sheets, reopened.activeSheetId, reopened.recentlyClosed)

    const closeOthers = sheetReducer(three, { type: 'closeOthers', id: reopened.sheets[0].id, now: 900 })
    expect(closeOthers.sheets.length).toBe(1)
    expect(closeOthers.activeSheetId).toBe(reopened.sheets[0].id)
    expect(closeOthers.recentlyClosed.length).toBe(2)

    const closeRightBase = sheetReducer(EMPTY_SHEET_STATE, { type: 'open', now: 1, sheet: { kind: 'file', title: 'a', singletonKey: 'a' } })
    const closeRightWithB = sheetReducer(closeRightBase, { type: 'open', now: 2, sheet: { kind: 'file', title: 'b', singletonKey: 'b' } })
    const closeRightWithC = sheetReducer(closeRightWithB, { type: 'open', now: 3, sheet: { kind: 'file', title: 'c', singletonKey: 'c' } })
    const closeRight = sheetReducer(closeRightWithC, { type: 'closeRight', id: closeRightWithC.sheets[0].id, now: 4 })
    expect(closeRight.sheets.map(sheet => sheet.title)).toEqual(['a'])
  })

  it('pin 语义：pinned 挡 close/closeRight/closeOthers，togglePin 可切换', () => {
    const pinnedBase = createSheetState([
      { id: 'pinned', kind: 'file', title: 'Pinned', singletonKey: 'pinned', pinned: true, createdAt: 1, lastFocusedAt: 1 },
      { id: 'middle', kind: 'file', title: 'Middle', singletonKey: 'middle', createdAt: 2, lastFocusedAt: 2 },
      { id: 'right', kind: 'file', title: 'Right', singletonKey: 'right', createdAt: 3, lastFocusedAt: 3 },
    ], 'middle')
    const unpinned = sheetReducer(pinnedBase, { type: 'close', id: 'pinned', now: 5 })
    expect(unpinned.sheets.map(sheet => sheet.id)).toEqual(['pinned', 'middle', 'right'])
    expect(unpinned.recentlyClosed.length).toBe(0)
    const unpinnedRight = sheetReducer(pinnedBase, { type: 'closeRight', id: 'middle', now: 6 })
    expect(unpinnedRight.sheets.map(sheet => sheet.id)).toEqual(['pinned', 'middle'])
    const toggled = sheetReducer(pinnedBase, { type: 'togglePin', id: 'middle', now: 7 })
    expect(toggled.sheets.find(sheet => sheet.id === 'middle')?.pinned).toBe(true)
    const closeOthersWithPinned = sheetReducer(toggled, { type: 'closeOthers', id: 'middle', now: 8 })
    expect(closeOthersWithPinned.sheets.map(sheet => sheet.id)).toEqual(['pinned', 'middle'])
  })

  it('11 kind 注册表与 createSheetState 容错', () => {
    expect(resolveSheetSingletonKey({ kind: 'prism' })).toBe('prism')
    expect(getSheetRegistryEntry('unknown')).toBeUndefined()
    // W1-01：9 kind 注册表（删 diff/changes/git-history，增 overview/search/history/browser/gateway）；
    // #154 阶段 4：增 settings（设置迁入 sheet 体系）；#371：增 docs（离线文档站）
    expect(getWorkspaceRegistrySnapshot().workspaces.length, 'W1-01 + #154 + #371：11 kind 注册表').toBe(11)
    expect(getSheetRegistryEntry('diff')).toBeUndefined()
    expect(getSheetRegistryEntry('changes')).toBeUndefined()
    expect(getSheetRegistryEntry('git-history')).toBeUndefined()
    expect(getSheetRegistryEntry('overview')?.singleton).toBe(true)
    expect(resolveSheetSingletonKey({ kind: 'gateway' })).toBe('gateway')

    const opened = sheetReducer(EMPTY_SHEET_STATE, agentA)
    const duplicate = sheetReducer(opened, { ...agentA, now: 200 })
    const agentB = sheetReducer(duplicate, { type: 'open', now: 300, sheet: { kind: 'agent', title: 'Profile B', agentId: 'profile-b' } })
    const prism = sheetReducer(agentB, { type: 'open', now: 400, sheet: { kind: 'prism', title: 'Prism' } })
    const focused = sheetReducer(prism, { type: 'focus', id: agentB.sheets[0].id, now: 500 })
    const closed = sheetReducer(focused, { type: 'close', id: agentB.sheets[0].id, now: 700 })
    const reopened = sheetReducer(closed, { type: 'reopen', now: 800 })
    const three = createSheetState(reopened.sheets, reopened.activeSheetId, reopened.recentlyClosed)
    expect(three.sheets.length).toBe(reopened.sheets.length)
    expect(createSheetState([{ ...reopened.sheets[0], kind: 'invalid' as never }]).sheets.length).toBe(0)
  })
})
