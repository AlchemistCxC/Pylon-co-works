import { describe, expect, it } from 'vitest'
import {
  EMPTY_FILE_TAB_STATE,
  fileTabKey,
  parseFileTabs,
  serializeFileTabs,
} from '../fileSheetState'

describe('file/diff tab identity 版本化 schema', () => {
  it('tab singleton key 区分 path+viewType——同路径 text/diff 不互相覆盖', () => {
    expect(fileTabKey({ path: 'src/a.ts', viewType: 'file.text' })).toBe('file.text:src/a.ts')
    expect(fileTabKey({ path: 'src/a.ts', viewType: 'git.diff' })).toBe('git.diff:src/a.ts')
    expect(fileTabKey({ path: 'src/a.ts', viewType: 'file.text' })).not.toBe(fileTabKey({ path: 'src/a.ts', viewType: 'git.diff' }))
  })

  it('空/未持久化 → 回退为空 v2 状态', () => {
    expect(parseFileTabs(undefined)).toEqual(EMPTY_FILE_TAB_STATE)
    expect(parseFileTabs('')).toEqual(EMPTY_FILE_TAB_STATE)
  })

  it('损坏 JSON / 非数组非 v2 对象 → 回退为空（不使整个 persistence 变 EMPTY）', () => {
    expect(parseFileTabs('garbage{')).toEqual(EMPTY_FILE_TAB_STATE)
    expect(parseFileTabs('null')).toEqual(EMPTY_FILE_TAB_STATE)
    expect(parseFileTabs('42')).toEqual(EMPTY_FILE_TAB_STATE)
    expect(parseFileTabs('{}')).toEqual(EMPTY_FILE_TAB_STATE)
    expect(parseFileTabs('"str"')).toEqual(EMPTY_FILE_TAB_STATE)
  })

  it('旧 openTabs:string[]（v1）迁移为 file-mode tabs，activeKey 取最后一条', () => {
    expect(parseFileTabs('["src/a.ts","src/b.ts"]')).toEqual({
      version: 3,
      tabs: [
        { path: 'src/a.ts', viewType: 'file.text' },
        { path: 'src/b.ts', viewType: 'file.text' },
      ],
      activeKey: 'file.text:src/b.ts',
    })
  })

  it('v2 同 key 重复记录只保留一条（保留最后一条，含 staged 差异）', () => {
    const raw = JSON.stringify({
      version: 2,
      tabs: [
        { path: 'src/a.ts', mode: 'file' },
        { path: 'src/a.ts', mode: 'diff', staged: true },
        { path: 'src/a.ts', mode: 'diff', staged: false },
        { path: 'src/a.ts', mode: 'file' },
      ],
      activeKey: 'file:src/a.ts',
    })
    expect(parseFileTabs(raw)).toEqual({
      version: 3,
      tabs: [
        { path: 'src/a.ts', viewType: 'file.text' },
        { path: 'src/a.ts', viewType: 'git.diff', staged: false },
      ],
      activeKey: 'file.text:src/a.ts',
    })
  })

  it('v1 数组重复路径按 tab key 去重（只保留一条 file tab）', () => {
    expect(parseFileTabs('["a.ts","b.ts","a.ts"]')).toEqual({
      version: 3,
      tabs: [
        { path: 'a.ts', viewType: 'file.text' },
        { path: 'b.ts', viewType: 'file.text' },
      ],
      activeKey: 'file.text:b.ts',
    })
  })

  it('v1 数组中非字符串条目被过滤', () => {
    expect(parseFileTabs('["a.ts", 42, "", "b.ts"]')).toEqual({
      version: 3,
      tabs: [
        { path: 'a.ts', viewType: 'file.text' },
        { path: 'b.ts', viewType: 'file.text' },
      ],
      activeKey: 'file.text:b.ts',
    })
  })

  it('v3 serialize → parse 往返保真（含 git.diff staged tab）', () => {
    const state = {
      version: 3 as const,
      tabs: [
        { path: 'src/a.ts', viewType: 'file.text' },
        { path: 'src/a.ts', viewType: 'git.diff', staged: true },
      ],
      activeKey: 'git.diff:src/a.ts',
    }
    expect(parseFileTabs(serializeFileTabs(state))).toEqual(state)
  })

  it('v2 非法条目（空 path / 未知 mode）被过滤', () => {
    const raw = JSON.stringify({
      version: 2,
      tabs: [
        { path: '', mode: 'file' },
        { path: 'good.ts', mode: 'file' },
        { path: 'bad.ts', mode: 'preview' },
      ],
      activeKey: 'file:good.ts',
    })
    expect(parseFileTabs(raw)).toEqual({
      version: 3,
      tabs: [{ path: 'good.ts', viewType: 'file.text' }],
      activeKey: 'file.text:good.ts',
    })
  })

  it('v2 activeKey 失效（指向不存在 tab）→ 回退最后一个 tab 的 key', () => {
    const raw = JSON.stringify({
      version: 2,
      tabs: [
        { path: 'a.ts', mode: 'file' },
        { path: 'b.ts', mode: 'file' },
      ],
      activeKey: 'file:ghost.ts',
    })
    expect(parseFileTabs(raw).activeKey).toBe('file.text:b.ts')
  })

  it('v2 tabs 为空 → activeKey 为 null', () => {
    expect(parseFileTabs('{"version":2,"tabs":[],"activeKey":"file:a.ts"}').activeKey).toBeNull()
  })

  it('损坏 staged 字段不会以 truthy 字符串进入 Git diff 请求', () => {
    const parsed = parseFileTabs(JSON.stringify({
      version: 3,
      tabs: [{ path: 'a.ts', viewType: 'git.diff', staged: 'false' }],
      activeKey: 'git.diff:a.ts',
    }))
    expect(parsed.tabs).toEqual([{ path: 'a.ts', viewType: 'git.diff' }])
  })
})
