/**
 * issue #150 · 稳定性：**随机化差分**（确定性种子，失败可复现）。
 *
 * 手写夹具只能覆盖"想得到的形状"；这一条用真实 markdown 记号构成字母表随机拼文本，
 * 对每个文本的**每个前缀**断言「增量结果 == 整段重解析」。种子固定 ⇒ 失败可复现，
 * 不依赖 Math.random。
 *
 * 为什么值得单独一条：增量路径的判据是"否定式"的（不含标点、落点安全、标记同款…），
 * 否定式判据的正确性靠**穷举式反例搜索**，不能只靠人想到的用例。
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { clearMarkdownRenderModelCache, getMarkdownRenderModel, type MarkdownRoot } from '../markdownRenderModel.ts'

/** mulberry32：小而确定的伪随机。 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 字母表：把真正会改变解析的记号都放进来——行首标记、围栏、表格、行内标记、自动链接、
 * 实体、转义、缩进、硬换行、软换行、空行、CRLF、制表、非 BMP 字符。
 */
const TOKENS: readonly string[] = [
  '甲', '乙', '丙', '字', '。', '，', '：', '、', '「', '」',
  'a', 'b', 'Z', '0', '1', '2', ' ', '  ', '\n', '\n\n', '\r\n', '\t', '    ',
  '|', '---', ':---:', '**', '__', '`', '~~', '* ', '- ', '+ ', '1. ', '2) ',
  '#', '## ', '> ', '>', '[', ']', '(', ')', '<', '>', '&', '\\', '=', '~', '!',
  'http://a.b', 'www.x.co', 'a@b.co', '&amp;', '```', '```ts', '🎯', '\\*', '  \n',
]

function randomText(random: () => number, tokens: number): string {
  const parts: string[] = []
  for (let index = 0; index < tokens; index += 1) parts.push(TOKENS[Math.floor(random() * TOKENS.length)]!)
  return parts.join('')
}

async function referenceParse(text: string): Promise<MarkdownRoot> {
  clearMarkdownRenderModelCache()
  return getMarkdownRenderModel(text, { cache: false, incremental: false })
}

describe('issue 150 · 随机化差分（确定性种子）', () => {
  const SEEDS = [1, 7, 13, 29, 101, 2024, 31337, 424242]
  const STEPS = [1, 3] as const

  for (const seed of SEEDS) {
    it(`随机文本种子 ${seed}：每个前缀与整段重解析一致（步长 1/3）`, async () => {
      const random = seededRandom(seed)
      const text = randomText(random, 48)
      const reference = await referenceParse(text)
      for (const step of STEPS) {
        clearMarkdownRenderModelCache()
        for (let end = 1; end <= text.length; end += step) {
          const prefix = text.slice(0, end)
          const incremental = await getMarkdownRenderModel(prefix, { cache: false })
          const expected = await referenceParse(prefix)
          expect(incremental, `seed=${seed} step=${step} @${end} prefix=${JSON.stringify(prefix)}`).toEqual(expected)
        }
      }
      expect(JSON.stringify(reference).length).toBeGreaterThan(0)
    })
  }
})
