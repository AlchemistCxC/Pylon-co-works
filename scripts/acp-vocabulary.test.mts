// #357：ACP 词表跨语言对齐门禁（vitest 纳管，随 `bun run test` 与 CI 生效）。
//
// 两次契约漂移（#110 F2 wire 词表双形状、#348 A1 摘除 `WriterTimeout` 后前端
// 死词条滞留至 #357）的根因是：Rust 封闭词表与前端呈现表各自手工维护，改一侧
// 没有任何东西逼着改另一侧。本文件把两侧做成**静态双向比对**（先例：
// `check-ipc-contract.mts` 的解析思想 × `audit-maintenance.test.mts` 的形态）：
//   1. `engine.rs::CrashReason::as_str` wire 码集 ≡ `ACP_CRASH_CAUSE_CODES`
//      （src/app/errorCodeExplanations.ts）——双向精确，死词条 / 漏词条都红；
//   2. `turn_ledger.rs::TurnTerminalCause` serde camelCase 标签全集
//      − {completed, cancelled, emptyTurn}（三者由专门分支处理）≡
//      `LEDGER_FAILURE_CAUSES`（src/domains/workbench/generationLedgerSummary.ts）；
//   3. `error.rs::AcpError::code()` 各码 ⊆ ERROR_CODE_EXPLANATIONS 键
//      （单向覆盖：这些码在前端表中散布多节且与其它词表源共用，无法精确切节）。
//
// 纪律语义：前端镜像 Rust **封闭词表本身**，而非产生频率——`#[allow(dead_code)]`
// 预留变体（firstTokenTimeout 等）保留映射；无产生点但被裁定豁免保留的变体
// （pending_lock_poisoned，见 engine.rs 文档注释）两侧同轮摘除，谁先动谁红灯。
//
// 只读解析 Rust 源文本，不要求 rust 工具链；解析器自带合成输入自测（对齐
// check-ipc-contract 的 --self-test 精神）。Rust 侧重构了枚举/匹配臂的书写
// 形状而导致解析为空时，此处以红灯显性失效，不允许静默放行。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ACP_CRASH_CAUSE_CODES, ERROR_CODE_EXPLANATIONS } from '../src/app/errorCodeExplanations.ts'
import { LEDGER_FAILURE_CAUSES } from '../src/domains/workbench/generationLedgerSummary.ts'

const readSource = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const ENGINE_RS = '../src-tauri/pylon-acp/src/engine.rs'
const TURN_LEDGER_RS = '../src-tauri/pylon-acp/src/turn_ledger.rs'
const ERROR_RS = '../src-tauri/pylon-acp/src/error.rs'

// ── Rust 源解析器 ─────────────────────────────────────────────────────────────

/** 从 source 中摘出 signature 首个出现起的整个花括号块（含括号）。 */
export function extractBraceBlock(source: string, signature: string): string {
  const start = source.indexOf(signature)
  if (start < 0) return ''
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return ''
}

/** 匹配臂抽取：`Self::X => "code"` / `Type::X => "code"`，容忍 `X { .. }` / `X(_)` 载荷。 */
export function parseMatchArms(block: string, typeNames: string[]): Map<string, string> {
  const pattern = new RegExp(
    `(?:${typeNames.map(escapeRegExp).join('|')})::([A-Za-z][A-Za-z0-9_]*)\\s*(?:\\{[^}]*\\}|\\([^)]*\\))?\\s*=>\\s*"([a-z][a-z0-9_]*)"`,
    'g',
  )
  const arms = new Map<string, string>()
  for (const [, variant, code] of block.matchAll(pattern)) arms.set(variant!, code!)
  return arms
}

/** 枚举变体抽取：跳过 `///` 文档与 `#[…]` 属性行，取 `Variant` / `Variant { … }` 行。 */
export function parseEnumVariants(enumBody: string): string[] {
  const withoutComments = enumBody
    .split('\n')
    .filter(line => !line.trimStart().startsWith('///') && !line.trimStart().startsWith('#'))
    .join('\n')
  const variants: string[] = []
  for (const match of withoutComments.matchAll(/^\s*([A-Z][A-Za-z0-9_]*)\s*(?:\{[^}]*\})?\s*,/gm)) {
    variants.push(match[1]!)
  }
  return variants
}

/** serde `rename_all = "camelCase"` 下 PascalCase 变体名的序列化标签。 */
export function serdeCamelCase(variant: string): string {
  return variant[0]!.toLowerCase() + variant.slice(1)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 摘出枚举定义：attrs = 紧邻 `enum` 声明之前的 serde 属性行；body = 枚举花括号块。 */
export function extractEnumWithAttrs(source: string, enumName: string): { attrs: string; body: string } {
  const declIdx = source.indexOf(`enum ${enumName}`)
  if (declIdx < 0) return { attrs: '', body: '' }
  const attrIdx = source.lastIndexOf('#[serde', declIdx)
  const from = attrIdx > 0 ? attrIdx : declIdx
  return { attrs: source.slice(from, declIdx), body: extractBraceBlock(source.slice(declIdx), `enum ${enumName}`) }
}

// ── 解析器自测（合成输入）────────────────────────────────────────────────────

describe('acp-vocabulary 解析器自测', () => {
  it('匹配臂解析容忍 Self::/类型前缀与 { .. } 载荷', () => {
    const arms = parseMatchArms(`
      match self {
            Self::ReplayTimeout { .. } => "replay_timeout",
            CrashReason::WriterFailed => "writer_failed",
            Self::Rpc(_) => "rpc_error",
        }
    `, ['Self', 'CrashReason'])
    expect(Object.fromEntries(arms)).toEqual({
      ReplayTimeout: 'replay_timeout',
      WriterFailed: 'writer_failed',
      Rpc: 'rpc_error',
    })
  })

  it('枚举变体解析跳过文档与属性行，兼容单行载荷变体', () => {
    const variants = parseEnumVariants(`
      #[derive(Debug)]
      #[serde(rename_all = "camelCase")]
      pub enum TurnTerminalCause {
          /// 正常完成且有文本产出。
          Completed,
          /// 成功但无文本产出。
          EmptyTurn { cause: EmptyTurnCause },
          /// 预留。
          #[allow(dead_code)] // 预留：接线时摘除
          FirstTokenTimeout,
          /// 含字符串字面量 "=>" 的文档也不得误判。
          Cancelled,
      }
    `)
    expect(variants).toEqual(['Completed', 'EmptyTurn', 'FirstTokenTimeout', 'Cancelled'])
  })

  it('serdeCamelCase 与 serde rename_all=camelCase 的标签形态一致', () => {
    expect(serdeCamelCase('MaxTurn')).toBe('maxTurn')
    expect(serdeCamelCase('FirstTokenTimeout')).toBe('firstTokenTimeout')
    expect(serdeCamelCase('EmptyTurn')).toBe('emptyTurn')
  })

  it('花括号块摘取按深度配对，签名缺失返回空串', () => {
    expect(extractBraceBlock('fn f() -> X { match s { A => "a{x}" } }', 'fn f')).toContain('"a{x}"')
    expect(extractBraceBlock('no signature here', 'fn f')).toBe('')
  })
})

// ── 跨语言比对 ───────────────────────────────────────────────────────────────

describe('acp-vocabulary 跨语言对齐（改任一侧必须同步另一侧）', () => {
  it('CrashReason::as_str wire 码集 ≡ errorCodeExplanations 崩因子表（双向精确）', () => {
    const implBlock = extractBraceBlock(readSource(ENGINE_RS), 'impl CrashReason')
    const asStrBlock = extractBraceBlock(implBlock, 'pub fn as_str(&self)')
    const rustCodes = [...parseMatchArms(asStrBlock, ['CrashReason', 'Self']).values()]
    expect(rustCodes.length, 'engine.rs 的 CrashReason::as_str 解析为空——Rust 侧重构了书写形状，需同步本门禁').toBeGreaterThan(0)

    const missingInFrontend = rustCodes.filter(code => !ACP_CRASH_CAUSE_CODES.includes(code))
    const deadInFrontend = ACP_CRASH_CAUSE_CODES.filter(code => !rustCodes.includes(code))
    expect(missingInFrontend, `Rust CrashReason 新增了 wire 码，前端缺解释（src/app/errorCodeExplanations.ts 的 ACP_CRASH_CAUSE_EXPLANATIONS）：${missingInFrontend.join(', ')}`).toEqual([])
    expect(deadInFrontend, `前端残留 Rust 已裁除的死词条（先例 #357 writer_timeout），从 src/app/errorCodeExplanations.ts 的 ACP_CRASH_CAUSE_EXPLANATIONS 删除：${deadInFrontend.join(', ')}`).toEqual([])
  })

  it('TurnTerminalCause camelCase 标签 − 非失败分支 ≡ LEDGER_FAILURE_CAUSES', () => {
    const source = readSource(TURN_LEDGER_RS)
    const { attrs, body } = extractEnumWithAttrs(source, 'TurnTerminalCause')
    expect(body, 'turn_ledger.rs 未找到 TurnTerminalCause 枚举').not.toBe('')
    // rename_all 是标签形态的依据：改成别的序列化策略必须显性失效，不许静默漂移。
    expect(attrs, 'TurnTerminalCause 的 serde rename_all 变更——标签形态随变，需同步本门禁与前端消费侧').toContain('rename_all = "camelCase"')

    const allTags = parseEnumVariants(body).map(serdeCamelCase)
    expect(allTags.length, 'TurnTerminalCause 变体解析为空——Rust 侧重构了书写形状，需同步本门禁').toBeGreaterThan(0)

    // 这三个标签由 resolveGenerationLedgerTerminalReason 的 done/cancelled/emptyTurn
    // 专门分支处理，不进失败侧集合；Rust 若新增非失败语义变体，此处红灯强制人来分类。
    const nonFailureTags = ['completed', 'cancelled', 'emptyTurn']
    const expectedFailureTags = allTags.filter(tag => !nonFailureTags.includes(tag))

    const missingInFrontend = expectedFailureTags.filter(tag => !LEDGER_FAILURE_CAUSES.has(tag))
    const deadInFrontend = [...LEDGER_FAILURE_CAUSES].filter(tag => !expectedFailureTags.includes(tag))
    expect(missingInFrontend, `Rust TurnTerminalCause 新增失败侧变体，src/domains/workbench/generationLedgerSummary.ts 的 LEDGER_FAILURE_CAUSES 漏认（该失败将不再呈现为 error）：${missingInFrontend.join(', ')}`).toEqual([])
    expect(deadInFrontend, `LEDGER_FAILURE_CAUSES 残留 Rust 已裁除的死标签（先例 #357 writerTimeout）：${deadInFrontend.join(', ')}`).toEqual([])
  })

  it('AcpError::code() 的每个码在前端码表都有解释（单向覆盖）', () => {
    const implBlock = extractBraceBlock(readSource(ERROR_RS), 'impl AcpError')
    const codeBlock = extractBraceBlock(implBlock, 'pub fn code(&self)')
    const rustCodes = [...parseMatchArms(codeBlock, ['Self', 'AcpError']).values()]
    expect(rustCodes.length, 'error.rs 的 AcpError::code 解析为空——Rust 侧重构了书写形状，需同步本门禁').toBeGreaterThan(0)

    const missing = rustCodes.filter(code => !(code in ERROR_CODE_EXPLANATIONS))
    expect(missing, `AcpError 新增/变更的码在前端码表缺解释（src/app/errorCodeExplanations.ts，bare code 会直接漏给用户）：${missing.join(', ')}`).toEqual([])
  })
})
