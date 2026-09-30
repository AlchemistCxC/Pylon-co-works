// #444：脱敏词表跨语言一致性门禁（vitest 纳管，随 `bun run test` 与 CI 生效）。
//
// 前端 `src/domains/export/threeSourceExport.ts` 的脱敏实现**镜像** Rust
// `src-tauri/pylon-foundations/src/sanitize.rs` 的 Strip 语义（三源取证导出与
// obs05-07 DEV 观测共用）。批次②后 key 词表已单源化：TS 侧
// canonicalExportSanitizeVocabulary.generated.ts 由
// generate-export-sanitize-vocabulary.mjs 从 Rust 源码生成（--check 门禁在
// check:frontend 链），本文件继续看守「生成物 ↔ 行为 ↔ Rust 源」三方互证：
//   1. `is_export_sensitive_key` 的 exact 名单 ≡ 生成物 EXPORT_SANITIZE_EXACT_KEYS
//      ≡ `isSensitiveExportKey` 行为（双向：Rust 加词 / 生成物失同步 /
//      TS 改行为任一侧漂移即红）；
//   2. 后缀/contains 规则（token / apikey / api_key / secret）同上；
//   3. SENSITIVE_KEY_PATTERN / BARE_SECRET_PATTERN 两条值正则（有意不生成，
//      Rust regex 与 JS 方言差异）：两侧字面量均可提取（防解析失效静默放行），
//      且 JS 重放语义等价（已知字面差异 `bearer\s+` vs `bearer\s` 对 is_match
//      语义等价，允许）。
//
// 有意不镜像（非漂移，勿加门禁）：Rust `is_sensitive_key`（Redact 表，含
// attachment/header + 8KiB 截断）是 runtime_log 语义，前端不做 Redact。
//
// 只读解析 Rust 源文本，不要求 rust 工具链；Rust 侧重构书写形状导致解析为
// 空时此处红灯显性失效，不允许静默放行。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractBraceBlock } from './acp-vocabulary.test.mts'
import {
  containsSensitiveValue,
  isSensitiveExportKey,
} from '../src/domains/export/threeSourceExport.ts'
import {
  EXPORT_SANITIZE_CONTAINS,
  EXPORT_SANITIZE_EXACT_KEYS,
  EXPORT_SANITIZE_SUFFIXES,
} from '../src/domains/export/canonicalExportSanitizeVocabulary.generated.ts'

const readSource = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const SANITIZE_RS = '../src-tauri/pylon-foundations/src/sanitize.rs'
const THREE_SOURCE_TS = '../src/domains/export/threeSourceExport.ts'

// ── Rust 源解析 ───────────────────────────────────────────────────────────────

/** is_export_sensitive_key 函数体内 matches!(...) 圆括号平衡块的 exact 字符串名单。 */
function parseRustExactKeys(sanitizeRs: string): string[] {
  const fnBody = extractBraceBlock(sanitizeRs, 'pub fn is_export_sensitive_key')
  if (!fnBody) return []
  const block = extractParenBlock(fnBody, 'matches!(')
  if (!block) return []
  return [...block.matchAll(/"([a-z][a-z0-9_]*)"/g)].map(match => match[1]!)
}

/** 从 signature 起做圆括号深度扫描（内容为简单字符串列表，字符串内无括号）。 */
function extractParenBlock(source: string, signature: string): string {
  const start = source.indexOf(signature)
  if (start < 0) return ''
  let depth = 0
  for (let i = start + signature.length - 1; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1
    if (source[i] === ')') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return ''
}

/** 函数体内的 ends_with("x") 后缀规则与 contains("x") 规则。 */
function parseRustSuffixRules(fnBody: string): { suffixes: string[]; contains: string[] } {
  return {
    suffixes: [...fnBody.matchAll(/\.ends_with\("([a-z_]+)"\)/g)].map(match => match[1]!),
    contains: [...fnBody.matchAll(/\.contains\("([a-z_]+)"\)/g)].map(match => match[1]!),
  }
}

/** Regex::new(r"..." / r#"..."#) 原始字面量（按出现序：[0]=SENSITIVE_KEY_PATTERN、[1]=BARE_SECRET_PATTERN）。
 * 两种 raw string 语法并存；SENSITIVE 字面量内嵌半角 `"`（分隔符字符类 `[:=："＝"]`），惰性扫到终止锚 `"#?\s*[,)]`。 */
function parseRustRegexLiterals(sanitizeRs: string): string[] {
  return [...sanitizeRs.matchAll(/Regex::new\(\s*r#?"([\s\S]*?)"#?\s*[,)]/g)].map(match => match[1]!)
}

// ── TS 侧词表（行为导入 + 生成物导入） ────────────────────────────────────────

function parseTsRegexLiterals(threeSourceTs: string): string[] {
  const sensitive = threeSourceTs.match(/const SENSITIVE_KEY_PATTERN = \/(.*)\/\r?\n/)
  const bare = threeSourceTs.match(/const BARE_SECRET_PATTERN = \/(.*)\/\r?\n/)
  return [sensitive?.[1] ?? '', bare?.[1] ?? '']
}

// ── 门禁 ──────────────────────────────────────────────────────────────────────

const sanitizeRs = readSource(SANITIZE_RS)
const threeSourceTs = readSource(THREE_SOURCE_TS)

describe('sanitize 词表跨语言一致性（#444）', () => {
  const rustFnBody = extractBraceBlock(sanitizeRs, 'pub fn is_export_sensitive_key')
  const rustExact = parseRustExactKeys(sanitizeRs)
  const tsExact = [...EXPORT_SANITIZE_EXACT_KEYS]

  it('Rust 解析非空（书写形状重构时红灯而非静默放行）', () => {
    expect(rustFnBody).not.toBe('')
    expect(rustExact.length).toBeGreaterThanOrEqual(11)
    expect(tsExact.length).toBeGreaterThanOrEqual(11)
  })

  it('exact 名单：生成物与 Rust 源双向精确一致', () => {
    expect([...tsExact].sort()).toEqual([...rustExact].sort())
  })

  const rustRules = parseRustSuffixRules(rustFnBody)

  it('后缀与 contains 规则：生成物与 Rust 源一致，且 TS 函数行为与 Rust 词表构造的期望谓词全等', () => {
    expect([...EXPORT_SANITIZE_SUFFIXES]).toEqual(rustRules.suffixes)
    expect([...EXPORT_SANITIZE_CONTAINS]).toEqual(rustRules.contains)
    // TS 侧规则形状（endsWith × 3 + includes × 1 的既定形状）由生成物钉住。

    const expectedPredicate = (rawKey: string): boolean => {
      const key = rawKey.toLowerCase()
      return (
        rustExact.includes(key)
        || rustRules.suffixes.some(suffix => key.endsWith(suffix))
        || rustRules.contains.some(frag => key.includes(frag))
      )
    }
    const probes = [
      ...rustExact,
      ...rustExact.map(key => key.toUpperCase()),
      'tokensTotal', // O26：共享后缀名不误伤
      'inputTokenCount',
      'my_api_key',
      'clientSecret',
      'secretKey',
      'cookieJar',
      'normal',
      'tokenStats',
      'credential',
    ]
    for (const probe of probes) {
      expect(isSensitiveExportKey(probe)).toBe(expectedPredicate(probe))
    }
  })

  describe('值正则语义等价（JS 重放）', () => {
    const rustLiterals = parseRustRegexLiterals(sanitizeRs)
    const tsLiterals = parseTsRegexLiterals(threeSourceTs)

    it('两侧两条正则字面量均可提取', () => {
      expect(rustLiterals.length).toBe(2)
      expect(tsLiterals[0]).not.toBe('')
      expect(tsLiterals[1]).not.toBe('')
    })

    const valueProbes = [
      'password: abc',
      'secret = x',
      'token：y', // 全角冒号分隔符
      'authorization="z"',
      'Bearer xyz',
      'bearer\tabc',
      'bearer', // 无空白分隔 → 不中
      'sk-abc123',
      'ghp_prefix',
      'xoxb-token',
      'akiaExample',
      'eyjpayload',
      'disk-usage', // S1 词边界：正常词不误伤
      'task-123',
      'heyjohn',
      'plain text',
    ]

    it('SENSITIVE_KEY_PATTERN 两侧对探针集行为一致', () => {
      const rustRe = new RegExp(rustLiterals[0]!, 'u')
      const tsRe = new RegExp(tsLiterals[0]!)
      for (const probe of valueProbes) {
        expect(tsRe.test(probe.toLowerCase())).toBe(rustRe.test(probe.toLowerCase()))
      }
    })

    it('BARE_SECRET_PATTERN 两侧对探针集行为一致', () => {
      const rustRe = new RegExp(rustLiterals[1]!, 'u')
      const tsRe = new RegExp(tsLiterals[1]!)
      for (const probe of valueProbes) {
        expect(tsRe.test(probe.toLowerCase())).toBe(rustRe.test(probe.toLowerCase()))
      }
    })

    it('TS containsSensitiveValue 与两侧正则联合行为一致', () => {
      for (const probe of valueProbes) {
        const lower = probe.toLowerCase()
        const expected = new RegExp(rustLiterals[0]!, 'u').test(lower)
          || new RegExp(rustLiterals[1]!, 'u').test(lower)
        expect(containsSensitiveValue(probe)).toBe(expected)
      }
    })
  })
})
