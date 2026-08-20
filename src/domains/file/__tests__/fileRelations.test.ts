/**
 * fileRelations 行为测试（报告 5D / FE-AUD-022）：
 * 路径 normalize、path→sources 反查、source→files 正查。
 */
import { describe, expect, it } from 'vitest'
import { normalizeFilePath, sourcesForPath, filesForContext, touchedFileKey } from '../fileRelations'

const KEY_A = JSON.stringify(['agent-a', 'local:a'])
const KEY_B = JSON.stringify(['agent-b', 'local:b'])

const TOUCHED = {
  [KEY_A]: [
    { source: 'local:a', path: 'G:\\work\\src\\App.ts' },
    { source: 'local:a', path: 'G:/work/src/readme.md' },
  ],
  [KEY_B]: [
    { source: 'local:b', path: 'g:\\WORK\\src\\app.ts' },
  ],
}

describe('normalizeFilePath', () => {
  it('反斜杠转正斜杠 + 小写（Windows 统一）', () => {
    expect(normalizeFilePath('G:\\Work\\Src\\App.TS')).toBe('g:/work/src/app.ts')
    expect(normalizeFilePath('G:/work/src/app.ts')).toBe('g:/work/src/app.ts')
  })
})

describe('sourcesForPath（反查）', () => {
  it('大小写/分隔符不同的同一路径命中同一 source', () => {
    expect(sourcesForPath(TOUCHED, 'G:/Work/Src/App.ts')).toEqual(['local:a', 'local:b'])
  })

  it('未关联路径返回空', () => {
    expect(sourcesForPath(TOUCHED, 'G:/nope/x.ts')).toEqual([])
  })

  it('同 source 去重', () => {
    expect(sourcesForPath(TOUCHED, 'g:\\work\\src\\readme.md')).toEqual(['local:a'])
  })
})

describe('filesForContext（正查，I01-W3 context key）', () => {
  it('返回该 context key 的文件列表', () => {
    expect(filesForContext(TOUCHED, KEY_A).length).toBe(2)
    expect(filesForContext(TOUCHED, 'missing')).toEqual([])
  })
})

describe('touchedFileKey', () => {
  it('键 = source:normalizedPath', () => {
    expect(touchedFileKey({ source: 'local:a', path: 'G:\\X\\y.ts' })).toBe('local:a:g:/x/y.ts')
  })
})
