// @vitest-environment jsdom
/**
 * #204 遗留：graft 基座的**字符预算**。
 *
 * 基座是整段 AST，条数上限（32）与文本长度脱钩，长思考尾块可以把几十 MB 钉在模块级缓存里。
 * 补字符预算后仍必须保住性能契约：**正在增长的那一行永远有基座**——否则它每一拍整段重解析，
 * 退化成 O(N²)（ADR-0006）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { clearMarkdownRenderModelCache, getMarkdownRenderModel, graftBaseStats } from '../markdownRenderModel.ts'
import { markdownParseCounters, resetMarkdownParseCounters } from '../markdownParseCounters.ts'

const MAX_GRAFT_BASE_CHARS = 256 * 1024

beforeEach(() => {
  clearMarkdownRenderModelCache()
})

/** 尾块路径（cache:false）才会写基座。 */
function tail(text: string) {
  return getMarkdownRenderModel(text, { cache: false })
}

describe('#204 graft 基座字符预算', () => {
  it('单条超预算时仍保留它——正在增长的行不得失去基座', async () => {
    const huge = 'a'.repeat(MAX_GRAFT_BASE_CHARS + 1000)
    await tail(huge)
    let stats = graftBaseStats()
    expect(stats.entries).toBe(1)
    expect(stats.chars).toBeGreaterThan(MAX_GRAFT_BASE_CHARS)

    // 该行继续纯文本增长：必须仍走 graft（基座在），而不是整段重解析
    resetMarkdownParseCounters()
    const before = markdownParseCounters()
    await tail(`${huge}bcd`)
    const after = markdownParseCounters()
    expect(after.grafted).toBe(before.grafted + 1)
    // 预算淘汰不会把最后一条挤掉
    stats = graftBaseStats()
    expect(stats.entries).toBe(1)
  })

  it('多行累积超预算时淘汰最旧的，且占用回落到预算内', async () => {
    const chunk = 'b'.repeat(64 * 1024)
    for (let index = 0; index < 6; index += 1) {
      await tail(`${chunk}${'x'.repeat(index)}`)
    }
    const stats = graftBaseStats()
    expect(stats.chars).toBeLessThanOrEqual(MAX_GRAFT_BASE_CHARS + chunk.length)
    expect(stats.entries).toBeLessThan(6)
    expect(stats.entries).toBeGreaterThanOrEqual(1)
  })

  it('清缓存同时清预算（不留幽灵占用）', async () => {
    await tail('c'.repeat(1024))
    expect(graftBaseStats().chars).toBeGreaterThan(0)
    clearMarkdownRenderModelCache()
    expect(graftBaseStats()).toEqual({ entries: 0, chars: 0 })
  })
})
