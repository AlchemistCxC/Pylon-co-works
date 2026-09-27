// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { loadMergeModule } from '../lazyMergeView'

// 0-C5：merge 包懒门面冒烟——动态加载可达、API 齐全、可构造双栏 MergeView；
// 主 chunk 不含 merge 包由 check:bundle 门禁与 lazy import 形态保证（本文件不静态 import 包）。
describe('lazyMergeView（0-C5 / issue #291）', () => {
  it('loadMergeModule 返回 MergeView/unifiedMergeView/acceptChunk/rejectChunk', async () => {
    const module = await loadMergeModule()
    expect(typeof module.MergeView).toBe('function')
    expect(typeof module.unifiedMergeView).toBe('function')
    expect(typeof module.acceptChunk).toBe('function')
    expect(typeof module.rejectChunk).toBe('function')
  })

  it('可构造双栏 MergeView（a/b 两文档）并销毁', async () => {
    const { MergeView } = await loadMergeModule()
    const parent = document.createElement('div')
    const view = new MergeView({
      a: { doc: 'old text' },
      b: { doc: 'new text' },
      parent,
    })
    expect(view.destroy).toBeTypeOf('function')
    view.destroy()
  })
})
