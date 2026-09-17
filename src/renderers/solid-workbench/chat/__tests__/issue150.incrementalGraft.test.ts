/**
 * issue #150：尾块增量 graft —— 与整段重解析**逐前缀一致**的差分测试。
 *
 * 契约（ADR-0006）：只有当追加的确实是「纯文本差量」时才把差量拼到上一模型上，其余一律回退整段
 * 重解析。这里的判据是**可判定的**，所以验证方式也是可判定的：对每个夹具文本的**每个前缀**，
 * 断言增量路径的结果与「对同一前缀整段重解析」逐块相同；再对「该 graft 的」「该回退的」两类
 * 边界逐个断言，避免差分测试退化成恒真（全程回退也能通过一致性）。
 *
 * 为什么是 jsdom：解析链里的 `decode-named-character-reference` 在 DOM 环境下走 `index.dom.js`，
 * node 环境会直接抛 `document is not defined`——本文件不读 DOM，只是解析器需要该环境。
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { clearMarkdownRenderModelCache, getMarkdownRenderModel, type MarkdownRoot } from '../markdownRenderModel.ts'
import { markdownParseCounters, resetMarkdownParseCounters } from '../markdownParseCounters.ts'

/** 参照路径：整段重解析，且不写 LRU、不写 graft 基座（`incremental: false`）。 */
function fullParse(text: string): Promise<MarkdownRoot> {
  return getMarkdownRenderModel(text, { cache: false, incremental: false })
}

/** 尾块路径的一步（与组件同形：`cache: false`），并报告这一步是否走了 graft。 */
async function tailStep(text: string): Promise<{ grafted: boolean; model: MarkdownRoot }> {
  const before = markdownParseCounters().grafted
  const model = await getMarkdownRenderModel(text, { cache: false })
  return { grafted: markdownParseCounters().grafted > before, model }
}

/**
 * 夹具：每个 ≤ 220 字，覆盖「该 graft」（纯中文、全角标点、英文单词流）与
 * 「必须回退」的全部构造（ASCII 标点、行尾、行首、行内元素、自动链接、实体/转义、块构造）。
 */
const CORPUS: readonly { readonly name: string; readonly text: string }[] = [
  { name: '纯中文长句（无 ASCII 标点）', text: '这一段的每一个字都是汉字而且没有任何标点符号就这样一直写下去看看增量拼接能不能一路跟到底不掉链子' },
  { name: '中文含全角标点', text: '先确认现象与复现路径，再核对渲染层的宽度来源与揭示节奏，最后把结论登记到台账。' },
  { name: '英文散文（含 ASCII 标点）', text: 'The quick brown fox jumps over the lazy dog, then it stops, and thinks about nothing at all.' },
  { name: '中英混排（#55 形状）', text: '第 N 段：先确认现象与复现路径，再核对 **渲染层** 的宽度来源与 `reveal` 节奏。' },
  { name: '行内强调', text: '前一段话 **这里加粗** 后面继续写下去，再 **再粗一次** 收尾。' },
  { name: '未闭合强调收尾', text: '开始写 **粗体还没闭合' },
  { name: '行内代码', text: '看这个 `deriveRowSpecs` 函数是怎么写的，然后继续。' },
  { name: '链接', text: '参考 [官方文档](https://example.com/docs) 的说明再决定。' },
  { name: '自动链接', text: '见 www.example.com 与 https://example.com/path?q=1 两处。' },
  { name: '实体与转义', text: '符号 &amp; 与 &lt;tag&gt; 以及 \\*星号\\* 都要原样显示。' },
  { name: '有序列表（无空行）', text: '1. 第一项的内容\n2. 第二项的内容\n3. 第三项的内容' },
  { name: '无序列表与嵌套', text: '- 顶层一项\n- 顶层二项\n  - 嵌套一项\n  - 嵌套二项' },
  { name: '任务列表', text: '- [x] 已完成的事项\n- [ ] 未完成的事项' },
  { name: '缩进代码块', text: '前面一句话：\n\n    const rows = deriveRowSpecs(visible, final)' },
  { name: '围栏代码块', text: '```ts\nconst split = splitStreamingMarkdownBlocks(visible)\n```' },
  { name: '表格', text: '| 位置 | 谱 | 本例 |\n| --- | --- | --- |\n| 一 | 仄仄平平仄仄平 | 示例句甲 |' },
  { name: 'ATX 与 setext 标题', text: '# 一级标题\n\n正文一句话。\n\n二级标题\n--------' },
  { name: '引用块', text: '> 引用的一行\n> 引用的第二行\n\n普通段落。' },
  { name: '硬换行（行尾两空格）', text: '第一行末尾两个空格  \n第二行紧跟其后' },
  { name: '删除线', text: '这里 ~~划掉的内容~~ 后面继续写。' },
  { name: '空行分段与块边界', text: '第一段已经完成。\n\n第二段正在增长，尚未结束\n\n第三段' },
  { name: 'emoji 与非 BMP 字符', text: '结论：🎯 命中目标，📌 记一笔，然后继续往下写正文内容。' },
  { name: '行尾反斜杠', text: '这一行以反斜杠结尾 \\' },
  { name: '分隔线', text: '上面的段落。\n\n---\n\n下面的段落。' },
]

/** 真机形状的长夹具：40 项有序列表（项间无空行），#150 现场实测的那一类单块。 */
function longListBlock(items: number): string {
  const lines: string[] = []
  for (let index = 0; index < items; index += 1) {
    lines.push(`${index + 1}. 第 ${index + 1} 项：核对 deriveRowSpecs 与 splitStreamingMarkdownBlocks 的契约并记录台账编号 ${index}`)
  }
  return lines.join('\n')
}

beforeEach(() => {
  clearMarkdownRenderModelCache()
  resetMarkdownParseCounters()
})

describe('issue 150: 增量 graft 与整段重解析逐前缀一致', () => {
  for (const fixture of CORPUS) {
    it(`每个前缀都一致：${fixture.name}`, async () => {
      for (let end = 1; end <= fixture.text.length; end += 1) {
        const prefix = fixture.text.slice(0, end)
        const incremental = await tailStep(prefix)
        const reference = await fullParse(prefix)
        expect(incremental.model, `${fixture.name} @${end}`).toEqual(reference)
      }
    })
  }

  it('每个前缀都一致：真机形状长列表（按 3 字步长抽样）', async () => {
    const text = longListBlock(40)
    for (let end = 1; end <= text.length; end += 3) {
      const prefix = text.slice(0, end)
      const incremental = await tailStep(prefix)
      const reference = await fullParse(prefix)
      expect(incremental.model, `长列表 @${end}`).toEqual(reference)
    }
  })
})

describe('issue 150: graft 判据的方向性（该拼的拼、该退的退）', () => {
  it('纯文本追加走 graft：中文、全角标点、英文单词都能一路拼下去', async () => {
    // 无 ASCII 空格与标点：每一步（除第一步没有基座）都应当走拼接
    const text = '这一段的每一个字都是汉字而且没有任何标点符号就这样一路写下去看看增量拼接能不能跟到底'
    const results: boolean[] = []
    for (let end = 1; end <= text.length; end += 1) {
      const step = await tailStep(text.slice(0, end))
      results.push(step.grafted)
    }
    expect(results[0]).toBe(false)
    expect(results.slice(1).every(Boolean)).toBe(true)
    const counters = markdownParseCounters()
    expect(counters.parsed).toBe(1)
    expect(counters.grafted).toBe(text.length - 1)
  })

  it('空格步不产生新内容：块末空白按 CommonMark 规则剥掉，仍走 graft', async () => {
    const text = '第一句 第二句 第三句'
    const results: boolean[] = []
    for (let end = 1; end <= text.length; end += 1) {
      const step = await tailStep(text.slice(0, end))
      results.push(step.grafted)
    }
    // 第一步没有基座（必须整段解析），其余每一步——含以空格结尾的那几步——都走拼接
    expect(results[0]).toBe(false)
    expect(results.slice(1).every(Boolean)).toBe(true)
    expect(markdownParseCounters().parsed).toBe(1)
  })

  it('每个安全容器里的「块末空白」都一致：段落 / 标题 / 列表项 / 表格单元 / 引用', async () => {
    const cases: readonly string[] = [
      '一句话。',            // 段落
      '# 标题',             // ATX 标题
      '- 列表项',           // 列表项
      '| a |\n| --- |\n| x', // 表格单元（末列）
      '> 引用',             // 引用块
    ]
    for (const base of cases) {
      clearMarkdownRenderModelCache()
      await tailStep(base)
      for (const suffix of [' ', '  ', '。 ']) {
        const text = base + suffix
        const step = await tailStep(text)
        expect(step.model, `${JSON.stringify(text)}`).toEqual(await fullParse(text))
      }
    }
  })

  it('ASCII 标点 / 换行 / 行首构造一律回退整段重解析', async () => {
    const cases = ['hello world', '第一行\n', '1. 列表项', '# 标题', '| a | b |', '   缩进', '> 引用', '---', '```ts']
    for (const base of cases) {
      clearMarkdownRenderModelCache()
      const warm = await tailStep(base)
      expect(warm.model.children.length, base).toBeGreaterThanOrEqual(0)
      // 追加一个「结构字符」或换行：必须回退
      for (const suffix of [',', '\n', '|', '#', ' ']) {
        const text = base + suffix
        if (text === base) continue
        const step = await tailStep(text)
        if (suffix === ' ' && !/[\r\n]$/.test(base)) continue
        expect(step.grafted, `${JSON.stringify(base)}+${JSON.stringify(suffix)}`).toBe(false)
      }
    }
  })

  it('落点行内元素或 URL/实体/转义上下文时回退', async () => {
    const cases: readonly string[] = [
      '前面的话 **加粗**',          // 叶子落在 <strong> 内
      '前面的话 `code`',            // 叶子落在 <code> 内
      '参考 [链接](https://a.b)',   // 叶子落在 <a> 内
      '见 www.example.com',        // 自动链接：叶子在 <a> 内且尾部是 URL
      '符号 &amp;',                // 实体：渲染值与原文不一致
      '转义 \\*',                  // 转义：渲染值与原文不一致
      '表格行 | a | b |',          // 以 | 收尾：末尾不在文本节点内部
    ]
    for (const base of cases) {
      clearMarkdownRenderModelCache()
      await tailStep(base)
      const step = await tailStep(`${base}接着写字`)
      expect(step.grafted, base).toBe(false)
    }
  })
})

describe('issue 150: 真机形状的成本下降', () => {
  it('长列表按 2 字步长流式揭示：整段重解析次数相对每步一次下降一个数量级', async () => {
    const text = longListBlock(40)
    let steps = 0
    for (let end = 1; end <= text.length; end += 2) {
      await tailStep(text.slice(0, end))
      steps += 1
    }
    const counters = markdownParseCounters()
    // 「每步一次」= steps。实测（见开发记录）：2931 字 / 1466 步 → parsed 132、grafted 1334（11.1×），
    // 解析 CPU 2368ms → 197ms（12.0×）；这里留余量锁住「一个数量级」。
    expect(counters.parsed).toBeLessThan(steps / 10)
    expect(counters.grafted).toBeGreaterThan(steps / 2)
    expect(counters.maxTextLength).toBeLessThanOrEqual(text.length)
  })
})
