// 流式切分 / markdown 解析 / 高亮共用语料。
//
// 切分语料照抄 `src/renderers/solid-workbench/__tests__/streamingComputeParity.test.ts`
// 的 SPLIT_CORPUS 起始段（切分契约形状 + 字素/UTF-16 边角），再补 scale 档合成文。
// markdown 语料覆盖常见块形状与边界；高亮语料按语言取样。

/** 流式切分契约语料（shape + edge）。 */
export const SPLIT_CORPUS: readonly string[] = [
  '',
  ' ',
  '\n',
  '\n\n',
  '  \n\n  x',
  '\t\n\n\tx',
  '正在回复的一段话',
  '第一行\n\n第二行片段',
  'A\n\nB',
  'a\n\n\n\nb',
  '头部\n\n```js\nconst x = 1',
  '头部\n\n```js\nconst x = 1\n```\n\n新的片段继续',
  '- 项1\n- 项2\n\n新段落开始',
  '段落一\n\n```rust\nfn main() {}\n```\n\n收尾',
  '~~删除线~~ 与 **加粗** 混排\n\n下一段',
  '👩‍💻 字素重复 👩‍💻\n\n下一段',
  '中文段落\n\n中文第二段',
  'CRLF 行尾\r\n\r\n第二段',
  '| a | b |\n| - | - |\n| 1 | 2 |\n\n表格后段落',
  '> 引用块\n> 续行\n\n引用后',
  '1. 有序\n2. 列表\n\n   嵌套段落',
  '---\n\n标题后的分隔线',
  '# 标题\n正文',
  '```\n未闭合围栏',
  '文本末尾恰好一个换行\n',
]

/** 全前缀扫描用的增长源文本（flow=prefix-scan：每个前缀的切分决策都必须一致）。 */
export const PREFIX_SCAN_SOURCE =
  '开场白\n\n```ts\nconst a = 1\n```\n\n中部段落，含中文与 emoji 👩‍💻。\n\n- 列表项 A\n- 列表项 B\n\n未闭合尾块还在长'

/** 大文本切分（scale 档）：块重复拼接。 */
export function repeatedBlocks(blocks: number): string {
  const unit = '## 段落标题\n\n正文段落，一些中文内容。\n\n```js\nconsole.log("code")\n```\n\n'
  return unit.repeat(blocks)
}

// ── markdown 解析语料 ────────────────────────────────────────────────────────

/** 结构变体（shape）：常见块形状一条一块。 */
export const MARKDOWN_SHAPE_CORPUS: ReadonlyArray<{ id: string, input: string }> = [
  { id: 'heading-paragraph', input: '# 大标题\n\n正文段落，**加粗**与*斜体*混排。' },
  { id: 'list-nested', input: '- 项 A\n- 项 B\n  - 嵌套 B1\n  - 嵌套 B2\n1. 有序一\n2. 有序二' },
  { id: 'table', input: '| 工具 | 状态 |\n| --- | --- |\n| read | ok |\n| write | running |' },
  { id: 'code-fence', input: '前置\n\n```ts\nconst x: number = 42\n```\n\n后置' },
  { id: 'blockquote', input: '> 引用第一行\n> 第二行\n\n普通段落' },
  { id: 'task-list', input: '- [x] 已完成\n- [ ] 未完成' },
  { id: 'inline-mix', input: '行内 `code`、[链接](https://example.com)、~~删除~~、图片 ![alt](img.png)' },
  { id: 'thematic-break', input: '---\n\n分段' },
  { id: 'html-inline', input: '文本 <em>强调</em> 与 <br> 混排' },
]

/** 边界（edge）。 */
export const MARKDOWN_EDGE_CORPUS: ReadonlyArray<{ id: string, input: string }> = [
  { id: 'empty', input: '' },
  { id: 'only-newlines', input: '\n\n\n' },
  { id: 'unclosed-fence', input: '```js\nconst x = 1' },
  { id: 'crlf', input: '第一行\r\n\r\n第二行' },
  { id: 'no-trailing-newline', input: '结尾没有换行' },
  { id: 'footnote-probe', input: '脚注[^1]\n\n[^1]: 注释内容' },
]

/** 量级（scale）：`blocks` 个块重复。 */
export function markdownScaleDoc(blocks: number): string {
  const unit = [
    '## 分节标题',
    '',
    '正文段落：包含 **加粗**、`行内代码` 与一个 [链接](https://example.com)。',
    '',
    '```ts',
    'export function sample(list: readonly string[]): number {',
    '  return list.map(item => item.length).reduce((a, b) => a + b, 0)',
    '}',
    '```',
    '',
    '- 要点一',
    '- 要点二',
    '',
  ].join('\n')
  return unit.repeat(blocks)
}

// ── 高亮语料 ─────────────────────────────────────────────────────────────────

export const HIGHLIGHT_CORPUS: ReadonlyArray<{ id: string, language: string, code: string }> = [
  { id: 'ts-sample', language: 'ts', code: 'const answer: number = 42\nexport function main(): void { console.log(answer) }\n' },
  { id: 'js-sample', language: 'js', code: 'function f() { return 1 }\n' },
  { id: 'python-sample', language: 'python', code: 'def main():\n    return 1\n' },
  { id: 'rust-sample', language: 'rust', code: 'fn main() { let x: u32 = 1; }\n' },
  { id: 'go-sample', language: 'go', code: 'func main() { fmt.Println("hi") }\n' },
  { id: 'json-sample', language: 'json', code: '{"key": [1, 2, null]}\n' },
  { id: 'bash-sample', language: 'bash', code: 'echo "$HOME"\n' },
  { id: 'css-sample', language: 'css', code: '.term-root { color: red; }\n' },
  { id: 'unknown-language', language: 'not-a-language', code: 'const x = 1\n' },
]
