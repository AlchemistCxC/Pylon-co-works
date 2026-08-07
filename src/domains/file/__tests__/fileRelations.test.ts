/**
 * fileRelations 行为测试（报告 5D / FE-AUD-022）：
 * 路径 normalize、path→sources 反查、source→files 正查。
 */
import { describe, expect, it } from 'vitest'
import { normalizeFilePath, sourcesForPath, filesForSource, touchedFileKey } from '../fileRelations'

const TOUCHED = {
  'local:a': [
    { source: 'local:a', path: 'G:\\work\\src\\App.ts' },
    { source: 'local:a', path: 'G:/work/src/readme.md' },
  ],
  'local:b': [
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

describe('filesForSource（正查）', () => {
  it('返回该 source 的文件列表', () => {
    expect(filesForSource(TOUCHED, 'local:a').length).toBe(2)
    expect(filesForSource(TOUCHED, 'missing')).toEqual([])
  })
})

describe('touchedFileKey', () => {
  it('键 = source:normalizedPath', () => {
    expect(touchedFileKey({ source: 'local:a', path: 'G:\\X\\y.ts' })).toBe('local:a:g:/x/y.ts')
  })
})
