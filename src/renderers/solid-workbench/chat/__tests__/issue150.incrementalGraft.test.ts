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
  { name: '换序号分隔符（必须回退）', text: '1. 甲\n2) 乙\n3. 丙' },
  { name: '换子弹符（必须回退）', text: '- 甲\n* 乙\n+ 丙' },
  { name: '松散列表（项内空行）', text: '- 甲\n\n- 乙' },
  { name: '缩进续行（必须回退）', text: '第一行\n    缩进的代码\n尾行' },
  { name: '列表项 lazy 续行', text: '1. 甲\n继续写但不编号\n2. 乙' },
  { name: '列表后空行接段落', text: '1. 甲\n\n接一段普通文字' },
  { name: '引用块内续行与空行', text: '> 甲\n> 乙\n>\n> 丙\n\n普通段落' },
  { name: '标题后接段落', text: '## 标题\n正文一段\n\n又一段' },
  { name: '表格后接文字（必须回退）', text: '| a | b |\n| --- | --- |\n| 1 | 2 |\n普通文字' },
  { name: '有序列表多行项', text: '1. 第一项\n  第二行\n2. 第二项\n  第二行\n3. 第三项' },
  { name: '项内含行内元素的列表', text: '- **粗体**甲\n- 乙\n- 丙' },
  // 对抗性夹具：表格与换行（这两类是「拼错就会渲染漂移」的高风险形状）
  { name: '表格带对齐分隔行', text: '| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |' },
  { name: '段落紧接表格（形状突变）', text: '一句话\n| a | b |\n| --- | --- |\n| 1 | 2 |' },
  { name: '以竖线收尾的段落', text: 'foo |\nbar | baz' },
  { name: '表格后空行接列表', text: '| a |\n| --- |\n| 1 |\n\n- 项一\n- 项二' },
  { name: '列表项内硬换行（行尾两空格）', text: '1. 甲  \n   乙\n2. 丙' },
  { name: '连续空行分段', text: '甲\n\n\n\n乙\n\n丙' },
  { name: 'CRLF 行尾（必须回退）', text: '第一行\r\n第二行\r\n第三行' },
  { name: '硬换行紧接续行', text: '第一行  \n第二行\n第三行' },
]

/** 真机形状的长夹具：40 项有序列表（项间无空行），#150 现场实测的那一类单块。 */
function longListBlock(items: number): string {
  const lines: string[] = []
  for (let index = 0; index < items; index += 1) {
    lines.push(`${index + 1}. 第 ${index + 1} 项：核对 deriveRowSpecs 与 splitStreamingMarkdownBlocks 的契约并记录台账编号 ${index}`)
  }
  return lines.join('\n')
}

/** 纯文本段落流：30 个短段落 + 20 行连续正文（无 ASCII 标点）——行边界最密的形状。 */
function paragraphShapedText(): string {
  const parts: string[] = []
  for (let index = 0; index < 30; index += 1) parts.push(`第 ${index + 1} 段：先确认现象与复现路径，再核对渲染层的宽度来源与揭示节奏。`)
  const long: string[] = []
  for (let index = 0; index < 20; index += 1) long.push(`连续正文第 ${index + 1} 行，这里是一行没有任何标点符号的中文说明文字用来占据版面并制造行边界。`)
  parts.push(long.join('\n'))
  return parts.join('\n\n')
}

/** 真机同构的长夹具：30 个短段落 + 40 项列表 + 表格 + 20 行连续正文（#150 真机 prompt 的形状）。 */
function benchShapedText(): string {
  const parts: string[] = []
  for (let index = 0; index < 30; index += 1) parts.push(`第 ${index + 1} 段：先确认现象与复现路径，再核对渲染层的宽度来源与揭示节奏。`)
  parts.push(longListBlock(40))
  parts.push([
    '| 位置 | 谱 | 本例 | 合 |',
    '| --- | --- | --- | --- |',
    '| 一 | 仄仄平平仄仄平 | 示例句甲 | ✓ |',
    '| 二 | 平平仄仄仄平平 | 示例句乙 | ✓ |',
  ].join('\n'))
  const long: string[] = []
  for (let index = 0; index < 20; index += 1) {
    long.push(`连续正文第 ${index + 1} 行，这里是一行没有任何标点符号的中文说明文字用来占据版面并制造行边界。`)
  }
  parts.push(long.join('\n'))
  return parts.join('\n\n')
}

beforeEach(() => {
  clearMarkdownRenderModelCache()
  resetMarkdownParseCounters()
})

describe('issue 150: 增量 graft 与整段重解析逐前缀一致', () => {
  // 步长要参数化：真机揭示每帧约 2–5 字到达，不同步长会走出**不同形状的差量**
  // （`" 乙"`、`"2. "`、`"甲\n"`…），只跑 1 字步长会漏掉整类形状。
  const STEPS = [1, 2, 3, 5] as const
  for (const fixture of CORPUS) {
    it(`每个前缀都一致（步长 1/2/3/5）：${fixture.name}`, async () => {
      for (const step of STEPS) {
        clearMarkdownRenderModelCache()
        for (let end = 1; end <= fixture.text.length; end += step) {
          const prefix = fixture.text.slice(0, end)
          const incremental = await tailStep(prefix)
          const reference = await fullParse(prefix)
          expect(incremental.model, `${fixture.name} step=${step} @${end}`).toEqual(reference)
        }
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

  it('ASCII 标点 / 行首构造一律回退整段重解析', async () => {
    const cases = ['hello world', '第一行\n', '1. 列表项', '# 标题', '| a | b |', '   缩进', '> 引用', '---', '```ts']
    for (const base of cases) {
      clearMarkdownRenderModelCache()
      const warm = await tailStep(base)
      expect(warm.model.children.length, base).toBeGreaterThanOrEqual(0)
      // 追加一个「结构字符」：必须回退（行首构造还会改写整块，不能按续行处理）
      for (const suffix of [',', '|', '#', '-']) {
        const step = await tailStep(base + suffix)
        expect(step.grafted, `${JSON.stringify(base)}+${JSON.stringify(suffix)}`).toBe(false)
      }
    }
  })

  it('尾随换行不改变模型：纯换行差量是「不变式拼接」，换行后的行内容按行规则拼接', async () => {
    // 真机实测：一行边界会先来一个纯 `\n` 差量，再来行内容——两者都不该触发整段重解析
    for (const base of ['第一行', '1. 甲', '# 标题', '> 引用', '| a |\n| --- |\n| x']) {
      clearMarkdownRenderModelCache()
      await tailStep(base)
      const terminated = await tailStep(`${base}\n`)
      expect(terminated.grafted, `${JSON.stringify(base)}+\\n`).toBe(true)
      expect(terminated.model, `${JSON.stringify(base)}+\\n`).toEqual(await fullParse(`${base}\n`))
    }
    // 段落 / 列表项 / 标题 / 引用之后的续行或新段落：走行拼接
    for (const base of ['第一行', '1. 甲', '# 标题', '> 引用']) {
      clearMarkdownRenderModelCache()
      await tailStep(base)
      const started = await tailStep(`${base}\n第二行`)
      expect(started.grafted, `${JSON.stringify(base)}+\\n第二行`).toBe(true)
      expect(started.model, `${JSON.stringify(base)}+\\n第二行`).toEqual(await fullParse(`${base}\n第二行`))
    }
    // 表格之后接文字：形状不同（表格结束、另起段落），回退但结果必须一致
    clearMarkdownRenderModelCache()
    await tailStep('| a |\n| --- |\n| x')
    const afterTable = await tailStep('| a |\n| --- |\n| x\n第二行')
    expect(afterTable.model).toEqual(await fullParse('| a |\n| --- |\n| x\n第二行'))
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

describe('issue 150: 按行拼接（续行 / 新列表项 / 新段落）的方向性', () => {
  /** 从 base 一步跨到 text（模拟「一整行一次到达」的发布形态）。 */
  async function stepFrom(base: string, text: string): Promise<{ grafted: boolean; model: MarkdownRoot }> {
    clearMarkdownRenderModelCache()
    await tailStep(base)
    const step = await tailStep(text)
    expect(step.model, `${JSON.stringify(text)}`).toEqual(await fullParse(text))
    return step
  }

  it('续行 / 新列表项 / 新段落都走拼接', async () => {
    expect((await stepFrom('第一行', '第一行\n第二行')).grafted).toBe(true)
    expect((await stepFrom('1. 甲', '1. 甲\n2. 乙')).grafted).toBe(true)
    expect((await stepFrom('- 甲', '- 甲\n- 乙')).grafted).toBe(true)
    expect((await stepFrom('第一段', '第一段\n\n第二段')).grafted).toBe(true)
    expect((await stepFrom('1. 甲', '1. 甲\n\n段落')).grafted).toBe(true)
    expect((await stepFrom('## 标题', '## 标题\n正文')).grafted).toBe(true)
    expect((await stepFrom('1. 甲', '1. 甲\n继续写')).grafted).toBe(true)
  })

  it('换款标记 / 松散列表 / 缩进续行 / 表格后接文字一律回退', async () => {
    expect((await stepFrom('1. 甲', '1. 甲\n2) 乙')).grafted).toBe(false)
    expect((await stepFrom('- 甲', '- 甲\n* 乙')).grafted).toBe(false)
    expect((await stepFrom('- 甲', '- 甲\n\n- 乙')).grafted).toBe(false)
    expect((await stepFrom('第一行', '第一行\n    缩进')).grafted).toBe(false)
    expect((await stepFrom('| a |\n| --- |\n| 1 |', '| a |\n| --- |\n| 1 |\n文字')).grafted).toBe(false)
    expect((await stepFrom('1. 甲', '1. 甲\n\n2. 乙')).grafted).toBe(false)
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
    // 「每步一次」= steps。实测（见开发记录）：2931 字 / 1466 步 → parsed 54、grafted 1412（27×），
    // 解析 CPU 2357ms → 67ms（35×）；这里留余量锁住「一个数量级」。
    expect(counters.parsed).toBeLessThan(steps / 10)
    expect(counters.grafted).toBeGreaterThan(steps / 2)
    expect(counters.maxTextLength).toBeLessThanOrEqual(text.length)
  })

  it('真机同构内容按 2 字步长：整段重解析次数被成本锁拦住（含尾随换行归一化）', async () => {
    // 这些入口是**纯性能**路径：退化掉也不会算错（回退永远正确），所以必须由成本锁看守。
    // 实测 5025 字 / 2513 步 → parsed 160、grafted 2353；关掉尾随换行归一化会退化到 ~230+。
    const text = benchShapedText()
    let steps = 0
    for (let end = 1; end <= text.length; end += 2) {
      await tailStep(text.slice(0, end))
      steps += 1
    }
    const counters = markdownParseCounters()
    expect(counters.parsed).toBeLessThan(steps / 12)
    expect(counters.grafted).toBeGreaterThan(steps * 0.8)
  })

  it('纯文本段落流按 2 字步长：整段重解析压到「每千步不到一次」', async () => {
    // 这一条专门看守「行内容入口」（基座已以换行结尾时，行内容直接按行规则拼接）：
    // 实测 996 步 → parsed 1；关掉该入口会退化到 ~15（步长 1 时多候选基座探测能救回来，故用步长 2）。
    const text = paragraphShapedText()
    let steps = 0
    for (let end = 1; end <= text.length; end += 2) {
      await tailStep(text.slice(0, end))
      steps += 1
    }
    const counters = markdownParseCounters()
    expect(counters.parsed).toBeLessThan(steps / 100)
    expect(counters.grafted).toBeGreaterThan(steps * 0.9)
  })
})
