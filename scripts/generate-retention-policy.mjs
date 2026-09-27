#!/usr/bin/env node
// generate-retention-policy — 把保留策略档位/默认值从 Rust 单源生成到 TS。
//
// 为什么需要它：retention.rs 的档位表与默认值原本在 TS
// （historyRetentionPolicy.ts）逐字手抄一份（值与文档注释两边相同），没有任何
// 门禁守着，任一侧改动都不会被检查拦住（#331/D1）。#331/U3 裁决：按
// dev-standards「跨语言契约的单源方向」以 Rust 为单源，本脚本把 TS 侧变成派生物。
//
// 为什么不 `cargo run` 取值：同 generate-canonical-event-types.mjs 的取舍——
// 不把 cargo 拖进纯前端门禁链，直接读 Rust 源码里的 `pub const` 声明。
// 锚点写得紧：四个常量缺一、值形态不对即**报错退出**，绝不吐出看似正常的短表。
//
// 用法：
//   node scripts/generate-retention-policy.mjs           # 写文件
//   node scripts/generate-retention-policy.mjs --check   # 只校验是否已同步

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(root, 'src-tauri', 'pylon-session', 'src', 'retention.rs')
const TARGET = join(root, 'src', 'components', 'settings', 'historyRetentionPolicy.contract.ts')

/** Rust 常量名 → TS 导出名。 */
const NAME_MAP = {
  TIME_DAYS_TIERS: 'RETENTION_TIME_DAYS',
  COUNT_LIMIT_TIERS: 'RETENTION_COUNT_LIMITS',
  DEFAULT_TIME_DAYS: 'DEFAULT_TIME_DAYS',
  DEFAULT_COUNT_LIMIT: 'DEFAULT_COUNT_LIMIT',
}
const EXPECTED_RUST_NAMES = Object.keys(NAME_MAP)

/** 抓取一条 `pub const`（连同其紧邻的 `///` 文档块——属性行不隔断回溯）。 */
function extractConstant(source, rustName) {
  const declaration = source.indexOf(`pub const ${rustName}:`)
  if (declaration < 0) {
    throw new Error(`未找到 pub const ${rustName} 声明锚点：${SOURCE}`)
  }
  const lines = source.slice(0, declaration).split('\n')
  const docLines = []
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('///')) {
      docLines.unshift(trimmed.replace(/^\/\/\/\s?/, ''))
    } else if (docLines.length === 0 && (trimmed === '' || trimmed.startsWith('#['))) {
      continue
    } else {
      break
    }
  }
  const rest = source.slice(declaration)
  const eq = rest.indexOf('=')
  // 分号从 `=` 之后找——`[u32; 5]` 类型里自带分号。
  const valueEnd = eq < 0 ? -1 : rest.indexOf(';', eq)
  if (valueEnd < 0) {
    throw new Error(`pub const ${rustName} 声明缺少分号收尾`)
  }
  const value = rest
    .slice(rest.indexOf('=') + 1, valueEnd)
    .trim()
  return { rustName, docLines, value }
}

/** 从 Rust 单源提取四个契约常量。 */
export function readRetentionContract() {
  const source = readFileSync(SOURCE, 'utf8')
  const constants = EXPECTED_RUST_NAMES.map(name => extractConstant(source, name))
  for (const { rustName, value } of constants) {
    const isArray = value.startsWith('[') && value.endsWith(']')
    const items = isArray ? value.slice(1, -1).split(',').filter(item => item.trim() !== '') : [value]
    const allNumeric = items.length > 0 && items.every(item => /^\d+$/.test(item.trim()))
    if (!allNumeric) {
      throw new Error(
        `pub const ${rustName} 的值形态不符合预期（u32 标量或 u32 数组）：${value}——` +
          '多半是 retention.rs 写法变了，请更新本脚本而不是接受派生错误',
      )
    }
  }
  return constants
}

function render(constants) {
  const blocks = constants.map(({ rustName, docLines, value }) => {
    const doc = docLines.length > 0 ? docLines.map(line => ` * ${line}`.trimEnd()).join('\n') : ` * ${rustName}`
    const tsName = NAME_MAP[rustName]
    const tsValue = value.startsWith('[') ? `${value} as const` : value
    return `/**\n${doc}\n */\nexport const ${tsName} = ${tsValue}`
  })
  return `// 本文件由 scripts/generate-retention-policy.mjs 生成，**禁止手改**。
//
// 单源：src-tauri/pylon-session/src/retention.rs 的档位/默认值常量
//（#331/U3 裁决：成对 wire 契约以 Rust 为单源，TS 由脚本生成）。
// 改档位请改 Rust 侧，然后跑 \`bun run build:retention-policy\`；
// \`bun run check:retention-policy\` 会在不同步时报红。

${blocks.join('\n')}
`
}

function main() {
  const check = process.argv.includes('--check')
  const constants = readRetentionContract()
  const expected = render(constants)

  if (check) {
    if (!existsSync(TARGET)) {
      console.error(`[retention-policy] 缺少生成物：${TARGET}`)
      console.error('[retention-policy] 修复：bun run build:retention-policy')
      process.exit(1)
    }
    if (readFileSync(TARGET, 'utf8') !== expected) {
      console.error('[retention-policy] TS 档位/默认值与 Rust 单源不同步。')
      console.error('[retention-policy] 修复：bun run build:retention-policy')
      process.exit(1)
    }
    console.log(`[retention-policy] 与 Rust 单源一致（${constants.length} 个常量）`)
    return
  }

  writeFileSync(TARGET, expected)
  console.log(`[retention-policy] 已生成 ${constants.length} 个常量 → ${TARGET.slice(root.length + 1)}`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
