import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const CSS_PATH =
  'src/plugins/product/packages/builtin.pylon-workspace/styles/sheets/file/FileSheet.css'
const css = readFileSync(CSS_PATH, 'utf8')

/**
 * issue #69 契约测试（在 issue38 契约断言上升级）。
 *
 * 只读投影（`.file-tab-*`）与 CodeMirror 编辑投影的几何必须**同源**，而且这种同源要由
 * 结构保证，不能靠“契约块恰好在文件末尾所以赢了级联”。因此本测试有两条腿：
 *   ① 契约块内部：token 集 + 分组选择器必须把两态几何写成同一组声明；
 *   ② 契约块之外：投影选择器的每一条规则体都不得再声明几何属性（“无旁路”断言）——
 *      旧块 A/B 与编辑块里任何 border/padding/flex/font/tab-size 都会在这里被抓住，
 *      而不是只检查“最后一条同名规则”。
 */

// ── 最小 CSS 解析（去注释 + 逐条规则体）────────────────────────────────────
interface Rule {
  selector: string
  body: string
}

function rulesOf(source: string): Rule[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Rule[] = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(withoutComments))) {
    rules.push({ selector: match[1].trim(), body: match[2] })
  }
  return rules
}

/** 选择器里的 class token（`.a.b` → a、b；属性选择器与伪元素不参与）。 */
function classesOf(selector: string): string[] {
  return (selector.match(/\.[A-Za-z0-9_-]+/g) ?? []).map(token => token.slice(1))
}

/** 声明属性名（只保留属性，`--x: 1` 的属性名就是 `--x`）。 */
function propertiesOf(body: string): string[] {
  return body
    .split(';')
    .map(declaration => declaration.split(':')[0]?.trim() ?? '')
    .filter(Boolean)
}

/** 契约块起点：唯一真源声明块的注释标题。 */
const CONTRACT_MARKER = 'File code projection contract'
const contractStart = css.indexOf(CONTRACT_MARKER)
const contract = css.slice(contractStart)
const legacy = css.slice(0, contractStart)

function pickRule(source: string, predicate: (rule: Rule) => boolean): Rule {
  const found = rulesOf(source).filter(predicate).pop()
  expect(found, '缺少预期规则').toBeTruthy()
  return found!
}

const inContract = (predicate: (rule: Rule) => boolean) => pickRule(contract, predicate)
const bySelector = (selector: string) => inContract(rule => rule.selector === selector)
const bySelectorPart = (part: string) => inContract(rule => rule.selector.includes(part))
const grouped = (...tokens: string[]) =>
  inContract(rule => tokens.every(token => classesOf(rule.selector).includes(token)))

/**
 * 两态投影的 DOM 面：只读态的代码/行号/正文元素，与编辑态 CodeMirror 的等价元素。
 * 这些元素上的几何声明只允许出现在契约块里。
 */
const PROJECTION_CLASSES = new Set([
  'file-tab-view',
  'file-tab-edit',
  'file-tab-code',
  'file-tab-gutter',
  'file-tab-gutter-line',
  'file-tab-pre',
  'file-tab-line',
  'file-code-editor',
  'cm-editor',
  'cm-scroller',
  'cm-content',
  'cm-line',
  'cm-gutters',
  'cm-gutter',
  'cm-gutterElement',
  'cm-lineNumbers',
  'cm-foldGutter',
])

/**
 * 几何属性黑名单：任何一项出现在契约块之外的投影规则里，都意味着两态几何又多了一个
 * 真源（旧块 A/B 与编辑块历来就是这样“穿透契约”的）。颜色/背景/光标/层级不在此列。
 */
const GEOMETRY_PROPERTIES = new Set([
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'padding-block', 'padding-block-start', 'padding-block-end',
  'padding-inline', 'padding-inline-start', 'padding-inline-end',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border', 'border-width', 'border-style',
  'border-left', 'border-right', 'border-top', 'border-bottom',
  'border-left-width', 'border-right-width', 'border-top-width', 'border-bottom-width',
  'border-inline', 'border-inline-start', 'border-inline-end',
  'border-block', 'border-block-start', 'border-block-end',
  'box-sizing', 'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
  'flex', 'flex-basis', 'flex-grow', 'flex-shrink', 'flex-direction', 'flex-wrap',
  'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'tab-size', 'text-align', 'scrollbar-width', 'overflow', 'overflow-x', 'overflow-y',
  'position', 'inset', 'top', 'right', 'bottom', 'left', 'display',
  'letter-spacing', 'word-spacing', 'white-space', 'vertical-align', 'text-indent',
  'gap', 'row-gap', 'column-gap', 'order', 'columns', 'column-width',
])

/** 契约 token：名 → 值。改值可以，改语义不行（两态都必须消费同一个 token）。 */
const TOKEN_DEFAULTS: Record<string, string> = {
  '--file-code-font-size': 'var(--editor-font-size, 13px)',
  '--file-code-line-height': 'var(--editor-line-height, 1.5)',
  '--file-code-top-padding': '10px',
  '--file-code-bottom-padding': '32px',
  '--file-code-gutter-width': '56px',
  '--file-code-fold-width': '16px',
  '--file-code-gutter-pad-left': '8px',
  '--file-code-gutter-pad-right': '12px',
  '--file-code-line-inset': '16px',
  '--file-code-content-pad-right': '0px',
  '--file-code-mark-rail': '2px',
  '--file-code-tab-size': '2',
}

const px = (value: string): number => Number.parseFloat(value)

describe('FileSheet code geometry contract (issue38 · issue #69)', () => {
  it('declares the whole two-projection token set once, on both projection hosts', () => {
    const tokenBlock = grouped('file-tab-view', 'file-code-editor')
    expect(tokenBlock.body).toContain('--file-code-font-size')
    for (const [name, value] of Object.entries(TOKEN_DEFAULTS)) {
      const declaration = `${name}: ${value};`
      expect(contract.split(declaration).length - 1, `token 必须恰好声明一次：${name}`).toBe(1)
    }
  })

  it('gives both projections one gutter rail: same box width, same separator technique', () => {
    const rail = grouped('file-tab-gutter', 'cm-gutters')
    const railWidth = 'calc(var(--file-code-gutter-width) + var(--file-code-fold-width))'
    expect(rail.body).toContain(`flex: 0 0 ${railWidth}`)
    expect(rail.body).toContain(`width: ${railWidth}`)
    expect(rail.body).toContain(`min-width: ${railWidth}`)
    // 分隔线只由契约的 inset 阴影表达：border 会吃掉盒内 1px 布局宽度（两态差出 1px）
    expect(rail.body).toContain('border: 0')
    expect(rail.body).toContain('box-shadow: inset -1px 0 0')

    // 只读态：折叠轨同样预留 ⇒ 行号右缘 = 盒左 + gutter-width − pad-right
    const readOnlyRail = bySelector('.file-tab-gutter')
    expect(readOnlyRail.body).toContain(
      'padding-right: calc(var(--file-code-gutter-pad-right) + var(--file-code-fold-width))',
    )
    expect(readOnlyRail.body).toContain('text-align: right')

    // 编辑态：行号列固定为行号轨，折叠列吃掉剩余的折叠轨（不再按内容定宽）
    const numberColumn = bySelectorPart('.cm-gutters .cm-lineNumbers')
    expect(numberColumn.body).toContain('flex: 0 0 var(--file-code-gutter-width)')
    expect(numberColumn.body).toContain('min-width: 0')
    const foldColumn = bySelectorPart('.cm-gutters .cm-foldGutter')
    expect(foldColumn.body).toContain('flex: 1 1 auto')
    expect(foldColumn.body).toContain('min-width: 0')

    // 行号单元：两态同一右对齐 + 同一左右内边距
    const numberUnit = grouped('file-tab-gutter-line', 'cm-gutterElement')
    expect(numberUnit.body).toContain('text-align: right')
    expect(numberUnit.body).toContain('line-height: var(--file-code-line-height)')
    expect(bySelectorPart('.cm-lineNumbers .cm-gutterElement').body).toContain(
      'padding: 0 var(--file-code-gutter-pad-right) 0 var(--file-code-gutter-pad-left)',
    )

    // 文档化的不变量：行号文字右缘 = 行号轨宽 − 右内边距
    expect(
      px(TOKEN_DEFAULTS['--file-code-gutter-width']) -
        px(TOKEN_DEFAULTS['--file-code-gutter-pad-right']),
    ).toBe(44)
  })

  it('gives both projections one line box: same min-height, inset and mark rail', () => {
    const lineBox = grouped('file-tab-line', 'cm-line')
    expect(lineBox.body).toContain(
      'min-height: calc(var(--file-code-font-size) * var(--file-code-line-height))',
    )
    expect(lineBox.body).toContain('padding: 0 var(--file-code-line-inset)')
    expect(lineBox.body).toContain('border-left: var(--file-code-mark-rail) solid transparent')
    // 首字符左缘 = 盒宽 + 标记轨 + 行内边距（两态同一算式，不再靠 border 穿透造成 2px）
    expect(
      px(TOKEN_DEFAULTS['--file-code-mark-rail']) + px(TOKEN_DEFAULTS['--file-code-line-inset']),
    ).toBe(18)
  })

  it('keeps the tab column width and the content host on the shared tokens', () => {
    expect(bySelector('.file-tab-pre').body).toContain('tab-size: var(--file-code-tab-size)')
    const contentHost = grouped('file-tab-pre', 'cm-content')
    expect(contentHost.body).toContain('padding-top: var(--file-code-top-padding)')
    expect(contentHost.body).toContain('padding-bottom: var(--file-code-bottom-padding)')
    expect(contentHost.body).toContain('font-family: var(--mono)')
  })

  // issue #93：正文容器的右内边距两态必须同值，且同值要由构造保证——共享规则体 +
  // 同一 token，而不是两态各写一个数字碰巧相等（改前只读态 24px、编辑态 0，宽行滚到
  // 最右时右端留白差 24px）。因此这里同时钉住「共享规则消费 token」与「两态各自
  // 规则体不得再自带水平内边距」。
  it('gives both projections one content inset, owned by the shared rule and token', () => {
    const contentHost = grouped('file-tab-pre', 'cm-content')
    expect(contentHost.body).toContain('padding-right: var(--file-code-content-pad-right)')
    expect(contentHost.body).toContain('padding-left: 0')

    for (const selector of ['.file-tab-pre', '.file-code-editor .cm-content']) {
      const body = bySelector(selector).body
      expect(body, `${selector} 不得自带水平内边距（会绕开共享 token）`).not.toContain('padding-right')
      expect(body, `${selector} 不得自带水平内边距（会绕开共享 token）`).not.toContain('padding-left')
    }
  })

  it('paints the changed-line decoration without consuming layout width', () => {
    const marker = bySelector('.file-tab-line[data-changed="true"]::before')
    expect(marker.body).toContain('position: absolute')
    expect(marker.body).not.toContain('margin-right')
    const markerRail = bySelector('.file-tab-line[data-changed="true"]')
    expect(markerRail.body).toContain('border-left-color: var(--editor-modified-mark')
  })

  // ── “无旁路”：契约块之外不得再出现任何投影几何声明 ─────────────────────────
  it('has no geometry bypass outside the contract block', () => {
    const bypasses = rulesOf(legacy)
      .filter(rule => classesOf(rule.selector).some(token => PROJECTION_CLASSES.has(token)))
      .flatMap(rule =>
        propertiesOf(rule.body)
          .filter(property => GEOMETRY_PROPERTIES.has(property))
          .map(property => `${rule.selector} { ${property} }`),
      )
    expect(bypasses, `契约块之外仍有投影几何声明：\n${bypasses.join('\n')}`).toEqual([])
  })

  it('drops the superseded partial fix and the old per-block geometry', () => {
    expect(contract).not.toContain('.cm-gutters .cm-gutter {')
    expect(legacy).not.toContain('.file-tab-gutter-line {')
    expect(legacy).not.toContain('tab-size: 2')
    expect(legacy).not.toContain('border-left: 2px solid transparent')
  })

  // ── 注释完整性：注释里的 “*/” 会提前闭合注释，把紧随的规则整条吞掉 ──────────
  // #83 的头部注释里写过 `file-main-*/`，浏览器（与本文件的 rulesOf 同口径的非贪婪
  // 剥离）都在那处提前收尾，紧随的 `.file-sheet { display: flex }` 因此整条消失——
  // sheet 外壳退化成块级堆叠、编辑器不再被约束宽度（横向滚动随之失效）。本断言把
  // “壳规则必须真的被解析出来”钉住，并禁止注释残渣漏进选择器。
  it('parses the sheet shell out of the file, with no comment residue in selectors', () => {
    const rules = rulesOf(css)
    const shell = rules.find(rule => rule.selector === '.file-sheet')
    expect(shell, '.file-sheet 规则未被解析出来：头部注释可能提前闭合').toBeTruthy()
    expect(shell!.body).toContain('display: flex')
    expect(shell!.body).toContain('flex: 1')

    const leaked = rules
      .filter(rule => /[\u4e00-\u9fff]|\*\//.test(rule.selector))
      .map(rule => rule.selector.slice(0, 80))
    expect(leaked, `注释残渣漏进了选择器：\n${leaked.join('\n')}`).toEqual([])
  })
})

// ── token 卫生（issue #281）──────────────────────────────────────────────────
describe('FileSheet token hygiene (issue #281)', () => {
  const INDEX_CSS_PATH = 'src/index.css'
  const EDITOR_TS_PATH = 'src/sheets/file/FileCodeEditor.tsx'
  const indexCss = readFileSync(INDEX_CSS_PATH, 'utf8')
  const editorTs = readFileSync(EDITOR_TS_PATH, 'utf8')

  const schemeBlocksOf = (source: string): readonly string[] => {
    const blocks: string[] = []
    const pattern = /\{([^{}]*)\}/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source))) blocks.push(match[1])
    return blocks.filter(block => block.includes('--bg-panel:'))
  }

  it('defines --bg-elevated in every scheme block that defines the bg family (search panel was transparent)', () => {
    const blocks = schemeBlocksOf(indexCss)
    expect(blocks.length, 'index.css 应存在亮/暗两个 bg 族定义块').toBeGreaterThanOrEqual(2)
    for (const block of blocks) {
      expect(block, 'bg 族定义块缺少 --bg-elevated 定义').toMatch(/--bg-elevated:/)
    }
  })

  it('keeps --syn-cmt/--syn-mh fallbacks identical across CSS and HighlightStyle', () => {
    // themeFieldDefs 的 default 是唯一真源（--syn-cmt/--syn-mh 均为 #65737e）。
    // 只读投影（FileSheet.css 的 pl-* 类）与编辑态 HighlightStyle（FileCodeEditor.tsx）
    // 的 fallback 字面量必须逐个一致，否则主题未发射该 var 时两态颜色漂移。
    const collect = (source: string, name: string): string[] =>
      [...source.matchAll(new RegExp(`var\\(--${name},\\s*([^)]+)\\)`, 'g'))].map(m => m[1]!.trim())
    for (const name of ['syn-cmt', 'syn-mh']) {
      const fallbacks = [...collect(css, name), ...collect(editorTs, name)]
      expect(fallbacks.length, `${name} 应存在带兜底的消费点`).toBeGreaterThan(0)
      const drifted = fallbacks.filter(value => value !== '#65737e')
      expect(drifted, `${name} 兜底色漂移：${drifted.join(', ')}`).toEqual([])
    }
  })

  it('colors file-type icons via scoped tokens, not bare literals', () => {
    const iconRules = rulesOf(css).filter(rule => /\.file-type-icon\.type-/.test(rule.selector))
    expect(iconRules.length).toBeGreaterThanOrEqual(6)
    const literals = iconRules
      .filter(rule => /#[0-9a-fA-F]{3,8}\b/.test(rule.body))
      .map(rule => `${rule.selector} { ${rule.body.trim()} }`)
    expect(literals, `图标色存在裸字面量：\n${literals.join('\n')}`).toEqual([])
  })

  it('uses --text-on-accent (not #fff) on accent/danger button text', () => {
    for (const selector of ['.file-save-btn', '.file-conflict-force']) {
      const rule = rulesOf(css).find(item => item.selector === selector)
      expect(rule, `${selector} 规则缺失`).toBeTruthy()
      expect(rule!.body).not.toMatch(/#fff\b/i)
      expect(rule!.body).toContain('var(--text-on-accent)')
    }
  })
})
