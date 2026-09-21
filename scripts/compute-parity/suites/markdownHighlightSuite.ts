// markdown-highlight 域套件：wasm `highlightBlock`（syntect）vs TS 基线
// starry-night（雕刻基线 oldHighlightEngine.ts）。两侧统一归一到「扁平 token
// 序列」（口径与 markdownComputeParity / parity/diff.mjs 一致：行数组间按无类
// 文本补 '\n'）。
// 已过审差异：js/go 的引擎级残差（见 parity-report.json 的 divergent 清单）。

import type { Suite } from '../harness.ts'
import type { ComputeContextLike } from '../index.ts'
import { highlightTs } from '../baselines/oldHighlightEngine.ts'
import { HIGHLIGHT_CORPUS } from '../fixtures/corpora.ts'

interface WasmHighlightedLine {
  readonly spans: ReadonlyArray<{ readonly classes: ReadonlyArray<string>, readonly text: string }>
}

/** wasm 行数组 → 扁平 token 序列（与 markdownComputeParity 的 flattenRustLines 同一语义）。 */
function flattenWasmLines(
  lines: ReadonlyArray<WasmHighlightedLine> | undefined,
  endsWithNewline: boolean,
): Array<{ scope: string, text: string }> | null {
  if (!lines) return null
  const toToken = (span: WasmHighlightedLine['spans'][number]) => ({
    scope: (span.classes ?? []).join(' '),
    text: span.text,
  })
  const rows = lines.map(line => line.spans.map(toToken))
  const out: Array<{ scope: string, text: string }> = []
  for (const row of rows) {
    if (out.length === 0) {
      out.push(...row)
      continue
    }
    const last = out[out.length - 1]
    const first = row[0]
    const lastPlain = last !== undefined && last.scope === ''
    const firstPlain = first !== undefined && first.scope === ''
    if (lastPlain && firstPlain) {
      last!.text += '\n' + first!.text
      out.push(...row.slice(1))
    } else if (lastPlain) {
      last!.text += '\n'
      out.push(...row)
    } else if (firstPlain) {
      out.push({ scope: '', text: '\n' + first!.text }, ...row.slice(1))
    } else {
      out.push({ scope: '', text: '\n' }, ...row)
    }
  }
  if (endsWithNewline) {
    const last = out[out.length - 1]
    if (last && last.scope === '') last.text += '\n'
    else out.push({ scope: '', text: '\n' })
  }
  return out
}

export function buildMarkdownHighlightSuite(ctx: ComputeContextLike): Suite {
  const wasm = ctx.markdown
  return {
    domain: 'markdown-highlight',
    pairs: [
      {
        name: 'highlightBlock',
        domain: 'markdown-highlight',
        ts: input => highlightTs(input.code, input.language),
        wasm: (input) => {
          const lines = wasm.highlightBlock(input.code, input.language) as ReadonlyArray<WasmHighlightedLine> | undefined
          return flattenWasmLines(lines, input.code.endsWith('\n'))
        },
        knownDivergences: ['js-sample', 'go-sample'],
        cases: HIGHLIGHT_CORPUS.map(item => ({
          id: item.id,
          meta: { shape: item.language, edge: item.language === 'unknown-language' },
          build: () => ({ code: item.code, language: item.language }),
        })),
      },
      {
        name: 'scopeForLanguage',
        domain: 'markdown-highlight',
        ts: languages => languages.map(language => wasmScopeOfTs(language)),
        wasm: languages => languages.map(language => wasm.scopeForLanguage(language)),
        cases: [
          {
            id: 'alias-table',
            meta: { shape: 'wordlist', edge: true },
            build: () => ['ts', 'typescript', 'tsx', 'js', 'py', 'python', 'rs', 'rust', 'go', 'java', 'c', 'cpp', 'css', 'json', 'yaml', 'yml', 'sh', 'bash', 'html', 'markup', 'unknown-lang', ''],
          },
        ],
      },
    ],
  }
}

/**
 * `scopeForLanguage` 的 TS 基线：映射表仍在生产树（`src/components/chat/codeHighlight.ts`
 * 的 LANGUAGE_SCOPES 同表，wasm 侧注释亦称「与原 TS 基线同表」）。为避免把生产
 * 模块拖进脚手架（它依赖 markdownCompute 装载器），此处按 wasm 出口注释所指向的
 * 同表语义内联镜像——表内容以 parity 门禁 `markdownComputeParity.test.ts` 的
 * LANGUAGE_SCOPES 为准（逐字同表）。
 */
function wasmScopeOfTs(language: string): string | undefined {
  const LANGUAGE_SCOPES: Record<string, string> = {
    js: 'source.js', javascript: 'source.js', jsx: 'source.js',
    ts: 'source.ts', typescript: 'source.ts', tsx: 'source.tsx',
    py: 'source.python', python: 'source.python',
    rs: 'source.rust', rust: 'source.rust',
    go: 'source.go', java: 'source.java',
    c: 'source.c', cpp: 'source.c++', cxx: 'source.c++',
    css: 'source.css', json: 'source.json', yaml: 'source.yaml', yml: 'source.yaml',
    sh: 'source.shell', shell: 'source.shell', bash: 'source.shell',
    html: 'text.html.basic', markup: 'text.html.basic',
  }
  return LANGUAGE_SCOPES[language.toLowerCase()]
}
