// 代码高亮的 **Lezer 引擎**（issue #241 / ADR-0020：高亮从 wasm/syntect 改为 Lezer）。
//
// 为什么是 Lezer 而不是继续用 wasm：见 ADR-0020 的四张实测表——语法资产占渲染器可控内存
// ~30% 且**不可归还**（wasm 线性内存只涨不跌、GC 无效），首次用到某语言还要同步编译
// 0.5–1s；Lezer 侧 12 个语法合计 ~8.9MB、单次 4KB 高亮 1.13ms、且与应用里的编辑器同一引擎。
//
// 本模块只做**计算**：整块代码进、行数组出（每行一组 span）。**不做**缓存、不做语言别名门
// 之外的编排、不产 HTML——那三层留在 `codeHighlight.ts`（消费方零改动的关键）。
//
// 两个刻意的形状选择：
// 1. **出口形状与 wasm 版一致**（`HighlightedLine[]`：每行一组 `{ classes, text }`），
//    这样切流只换「行数组从哪来」，`codeHighlight.ts` 的拼 HTML / 转义 / 缓存一行不动。
// 2. **CodeMirror 全部动态 import**：它们体量不小，静态 import 会进主 chunk 撞
//    `check:bundle` 的 MAIN_BUDGET（编辑器侧同样是懒加载，见 FileCodeEditor 的注释）。

/** 一行的行内片段：`classes` 为空表示该段无类（渲染成纯文本）。 */
export interface LezerHighlightSpan {
  readonly classes: readonly string[]
  readonly text: string
}

export interface LezerHighlightedLine {
  readonly spans: readonly LezerHighlightSpan[]
}

/**
 * 语言别名 → `@codemirror/language-data` 的匹配线索（扩展名 / 名字）。
 *
 * **同步门**：`hasHighlightLanguage()` 靠它判断「有没有该语言」，未命中即返回 `null`
 * 语义（与旧实现在同步语言门挡住未知语言同形——未知语言绝不进引擎）。
 * 表与 `codeHighlight.ts` 的 `LANGUAGE_SCOPES` 同源（同一批别名），但值从 TextMate scope
 * 换成扩展名：Lezer 按语言包匹配，不认 scope。
 */
const LANGUAGE_HINTS: Readonly<Record<string, { extensions: readonly string[], name?: string }>> = {
  js: { extensions: ['js'] }, javascript: { extensions: ['js'] }, jsx: { extensions: ['js'] },
  ts: { extensions: ['ts'] }, typescript: { extensions: ['ts'] }, tsx: { extensions: ['tsx'] },
  py: { extensions: ['py'] }, python: { extensions: ['py'] },
  rs: { extensions: ['rs'] }, rust: { extensions: ['rs'] },
  go: { extensions: ['go'] }, java: { extensions: ['java'] },
  c: { extensions: ['c'] }, cpp: { extensions: ['cpp', 'cc', 'c++', 'h'] }, cxx: { extensions: ['cpp', 'cc'] },
  css: { extensions: ['css'] }, json: { extensions: ['json'] },
  yaml: { extensions: ['yaml', 'yml'] }, yml: { extensions: ['yaml', 'yml'] },
  sh: { extensions: ['sh'] }, shell: { extensions: ['sh'] }, bash: { extensions: ['sh'] },
  html: { extensions: ['html'] }, markup: { extensions: ['html'] },
}

/** 有没有该语言（同步门；调用方据此决定「过界还是回退 null」）。 */
export function hasHighlightLanguage(language: string): boolean {
  return LANGUAGE_HINTS[language.toLowerCase()] !== undefined
}

/**
 * Lezer tag → 类名。**类名沿用本应用既有的一套**（`pl-*`，颜色在 ChatView.css /
 * FileSheet.css 里接到 `var(--syn-*)`，`--syn-*` 由 `themeFieldDefs.ts` 提供且用户可配）。
 *
 * 为什么沿用而不是另起一套：`pl-*` 在我们这里已经**只是类名**（palette 在 `--syn-*`），
 * 换名不会带来任何收益，却要让两份 CSS 与 4 个测试文件跟着动。真正被替换的是它的**来源**
 * ——旧的是 Rust 侧 `starry-theme.json` 的「TextMate scope → 类名」表，这里是「Lezer tag → 类名」表。
 *
 * 表的取舍（对应 #241 的未决问题 1/2）：
 * - `operator` / `punctuation` / `bracket` 族**不映射**（留无类）：旧实现把它们混在 `pl-k` 里
 *   （`=`、`:`、`{` 都是关键字色），Lezer 侧是独立标签。首版取保守——不额外制造"更花"的观感；
 *   若验收认为对比度不足，再把这几族接上（改这一张表即可）。
 * - 旧类 `pl-smi`（property）/`pl-pds`/`pl-sr`/`pl-mh`/`pl-cor`/`pl-s1` 里有对应语义的继续用，
 *   没有对应 tag 的（`pl-cor`）不强行凑。
 */
async function buildTagToClass(): Promise<Array<{ tag: unknown, cls: string }>> {
  const { tags } = await import('@lezer/highlight')
  return [
    // 关键字族 → 关键字色
    { tag: tags.keyword, cls: 'pl-k' },
    { tag: tags.controlKeyword, cls: 'pl-k' },
    { tag: tags.definitionKeyword, cls: 'pl-k' },
    { tag: tags.moduleKeyword, cls: 'pl-k' },
    { tag: tags.operatorKeyword, cls: 'pl-k' },
    { tag: tags.modifier, cls: 'pl-k' },
    { tag: tags.self, cls: 'pl-k' },
    { tag: tags.bool, cls: 'pl-k' },
    { tag: tags.null, cls: 'pl-k' },
    // 操作符族 → 关键字色：**与现状观感一致**（旧实现把 `=`/`:` 这类也标成 pl-k）
    { tag: tags.operator, cls: 'pl-k' },
    { tag: tags.compareOperator, cls: 'pl-k' },
    { tag: tags.arithmeticOperator, cls: 'pl-k' },
    { tag: tags.logicOperator, cls: 'pl-k' },
    { tag: tags.bitwiseOperator, cls: 'pl-k' },
    { tag: tags.derefOperator, cls: 'pl-k' },
    { tag: tags.updateOperator, cls: 'pl-k' },
    { tag: tags.definitionOperator, cls: 'pl-k' },
    { tag: tags.typeOperator, cls: 'pl-k' },
    { tag: tags.controlOperator, cls: 'pl-k' },
    // 标点/括号族 → 关键字色。**取这一档的判据（实测三档，见 #241）**：
    //   不接标点 → 覆盖率 55.7%、掉色 4.5%（掉的主要是 ts/rust 的 `:` —— 现状它是 pl-k）
    //   接上标点 → 覆盖率 69.4%、掉色 3.3%（代价：css 的 `{`/`;` 也上色，现状它们无色）
    // 选后者：与现状「算子即关键字色」的观感一致、且不会出现「`=` 有色而 `;` 无色」的割裂。
    // 想更素只删这五行（其余不动）。
    { tag: tags.punctuation, cls: 'pl-k' },
    { tag: tags.bracket, cls: 'pl-k' },
    { tag: tags.squareBracket, cls: 'pl-k' },
    { tag: tags.paren, cls: 'pl-k' },
    { tag: tags.brace, cls: 'pl-k' },
    // 字面量族 → 字面量色
    { tag: tags.number, cls: 'pl-c1' },
    { tag: tags.atom, cls: 'pl-c1' },
    { tag: tags.color, cls: 'pl-c1' },
    // 字符串族
    { tag: tags.string, cls: 'pl-s' },
    { tag: tags.special(tags.string), cls: 'pl-s' },
    { tag: tags.character, cls: 'pl-s' },
    { tag: tags.escape, cls: 'pl-s' },
    // 正则 → 旧类 pl-sr
    { tag: tags.regexp, cls: 'pl-sr' },
    // 注释
    { tag: tags.comment, cls: 'pl-c' },
    { tag: tags.lineComment, cls: 'pl-c' },
    { tag: tags.blockComment, cls: 'pl-c' },
    { tag: tags.docComment, cls: 'pl-c' },
    { tag: tags.meta, cls: 'pl-c' },
    // 实体/类型/标签
    { tag: tags.tagName, cls: 'pl-ent' },
    { tag: tags.typeName, cls: 'pl-ent' },
    { tag: tags.className, cls: 'pl-ent' },
    { tag: tags.namespace, cls: 'pl-s1' },
    { tag: tags.labelName, cls: 'pl-s1' },
    { tag: tags.attributeName, cls: 'pl-s1' },
    { tag: tags.attributeValue, cls: 'pl-s' },
    // 函数
    { tag: tags.function(tags.variableName), cls: 'pl-en' },
    { tag: tags.function(tags.propertyName), cls: 'pl-en' },
    { tag: tags.function(tags.definition(tags.variableName)), cls: 'pl-en' },
    // 属性名 → 旧类 pl-smi
    { tag: tags.propertyName, cls: 'pl-smi' },
    // 变量 / 参数
    { tag: tags.variableName, cls: 'pl-v' },
    { tag: tags.definition(tags.variableName), cls: 'pl-v' },
    { tag: tags.constant(tags.variableName), cls: 'pl-v' },
    // 链接（markdown 内联代码块外的少数场景）
    { tag: tags.link, cls: 'pl-s' },
    { tag: tags.url, cls: 'pl-s' },
    // 非法 / 未定义
    { tag: tags.invalid, cls: 'pl-cor' },
  ]
}

let enginePromise: Promise<{
  languages: readonly { extensions: readonly string[], name: string, load: () => Promise<unknown> }[]
  highlighter: unknown
}> | undefined

/** 懒装载引擎与语言清单（首次调用才付这份成本；与编辑器侧同一套包）。 */
function loadEngine() {
  enginePromise ??= (async () => {
    const [{ languages }, { tagHighlighter }] = await Promise.all([
      import('@codemirror/language-data'),
      import('@lezer/highlight'),
    ])
    const table = await buildTagToClass()
    return {
      languages: languages as never,
      highlighter: tagHighlighter(table.map(({ tag, cls }) => ({ tag: tag as never, class: cls })) as never),
    }
  })()
  return enginePromise
}

/**
 * 整块代码 → 行数组（每行一组 span）。语言未覆盖时返回 `undefined`（调用方回落纯文本）。
 *
 * 与旧 wasm 出口的差异只在内部：Lezer 是**增量解析器**，但本函数每次调用都新建
 * `EditorState`（一次性高亮，不持有文档状态）——所以「更快」来自没有编译期与过界编组，
 * 不来自增量。真要吃增量（流式尾块逐帧增长）需要保留 state，见 #241 未决问题 4 的说明。
 */
export async function highlightBlockWithLezer(
  code: string,
  language: string,
): Promise<readonly LezerHighlightedLine[] | undefined> {
  const hint = LANGUAGE_HINTS[language.toLowerCase()]
  if (hint === undefined) return undefined
  const { languages, highlighter } = await loadEngine()
  const description = languages.find((item) => {
    if (hint.name !== undefined && item.name.toLowerCase() === hint.name) return true
    return hint.extensions.some(extension => item.extensions.includes(extension))
  })
  if (description === undefined) return undefined
  const support = await description.load()
  const [{ EditorState }, { syntaxTree }, { highlightTree }] = await Promise.all([
    import('@codemirror/state'),
    import('@codemirror/language'),
    import('@lezer/highlight'),
  ])
  const tree = syntaxTree(EditorState.create({ doc: code, extensions: [support as never] }))

  // 把「字符区间 → 类名」按行切成 span 数组（行内不含 '\n'，与旧出口同形状）。
  const lines: Array<LezerHighlightSpan[]> = [[]]
  const push = (text: string, classes: readonly string[]): void => {
    // 跨行文本按 '\n' 切开——高亮区间可以横跨换行（块注释、多行字符串）。
    const pieces = text.split('\n')
    pieces.forEach((piece, index) => {
      if (index > 0) lines.push([])
      if (piece.length === 0) return
      if (classes.length === 0) lines[lines.length - 1]!.push({ classes: [], text: piece })
      else {
        const last = lines[lines.length - 1]!
        const previous = last[last.length - 1]
        // 相邻同类片段合并：Lezer 会把一行拆成很多细粒度区间，逐段成 span 会让 DOM 膨胀
        if (previous !== undefined
          && previous.classes.length === classes.length
          && previous.classes.every((cls, at) => cls === classes[at])) {
          last[last.length - 1] = { classes: previous.classes, text: previous.text + piece }
        } else {
          last.push({ classes, text: piece })
        }
      }
    })
  }

  let cursor = 0
  highlightTree(tree, highlighter as never, (from, to, classes) => {
    const mapped = classes.trim().split(/\s+/).filter(Boolean)
    if (mapped.length === 0) return
    if (from > cursor) push(code.slice(cursor, from), [])
    push(code.slice(from, to), mapped)
    cursor = to
  })
  if (cursor < code.length) push(code.slice(cursor), [])
  // 尾行约定与旧 wasm 出口一致：源码以 '\n' 收尾时行数组**少一个空尾行**
  // （消费方 `codeHighlight.ts` 会用 `code.endsWith('\n')` 把它补回）。
  if (code.endsWith('\n') && lines.length > 1) {
    const last = lines[lines.length - 1]!
    if (last.length === 0) lines.pop()
  }
  // 出口形状对齐 `HighlightedLine`（每行一个 `{ spans }` 对象）——切流时消费方零改动。
  return lines.map(spans => ({ spans }))
}
