#!/usr/bin/env node
// generate-canonical-event-types — 把 canonical 事件词表从 Rust 单源生成到 TS。
//
// 为什么需要它：词表原本在 TS（`eventSchema.ts` 的字面量数组）与 Rust（裸字符串，
// `event_repo.rs` 等 150+ 处）各写一份，且**没有任何门禁守着**，漂移只能靠人读。
// issue #220 WP1 要求单源化——单源选 Rust（canonical 类型在 Rust 侧已存在，TS 只是
// 消费者），本脚本把 TS 侧变成派生物。
//
// 为什么不 `cargo run` 取词表：那会把 cargo 拖进纯前端门禁链。这里直接读 Rust
// 源码里 `canonical_event_types! { ... }` 宏调用的展开项；宏本身保证了
// enum / as_str / from_wire / 词表数组四者不会互相漂移，因此源码里的 `=> "wire"`
// 列表就是词表本身（不是「某一处副本」）。锚点写得紧：找不到宏块或解析出的条目
// 数不合理时**报错退出**，绝不吐出一份看似正常的短词表。
//
// 用法：
//   node scripts/generate-canonical-event-types.mjs           # 写文件
//   node scripts/generate-canonical-event-types.mjs --check   # 只校验是否已同步

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(root, 'src-tauri', 'pylon-canonical-types', 'src', 'lib.rs')
const TARGET = join(root, 'src', 'domains', 'events', 'canonicalEventTypes.generated.ts')

/** 词表下限：解析少于这么多个条目即视为锚点失效，而不是「词表变短了」。 */
const MIN_EXPECTED_ENTRIES = 20

/** 从 Rust 单源提取词表（声明顺序即 wire 顺序）。 */
export function readCanonicalEventTypes() {
  const source = readFileSync(SOURCE, 'utf8')
  const macroStart = source.indexOf('canonical_event_types! {')
  if (macroStart < 0) {
    throw new Error(`未找到 canonical_event_types! 宏调用锚点：${SOURCE}`)
  }
  // 宏体以顶格 `}` 收尾（词表条目自带缩进，不会撞上这个锚点）。
  const macroEnd = source.indexOf('\n}', macroStart)
  if (macroEnd < 0) {
    throw new Error('canonical_event_types! 宏体未找到顶格收尾 `}`')
  }
  const body = source.slice(macroStart, macroEnd)
  const entries = [...body.matchAll(/=>\s*"([^"]+)",/g)].map(match => match[1])
  if (entries.length < MIN_EXPECTED_ENTRIES) {
    throw new Error(
      `词表只解析出 ${entries.length} 项（下限 ${MIN_EXPECTED_ENTRIES}）——` +
        '多半是宏写法的锚点失效，请更新本脚本而不是接受这份短词表',
    )
  }
  if (new Set(entries).size !== entries.length) {
    throw new Error('词表存在重复条目')
  }
  return entries
}

function render(entries) {
  return `// 本文件由 scripts/generate-canonical-event-types.mjs 生成，**禁止手改**。
//
// 单源：src-tauri/pylon-canonical-types/src/lib.rs 的 canonical_event_types! 宏调用
// （enum / as_str / from_wire / 词表数组由同一份 \`Variant => "wire"\` 列表展开）。
// 改词表请改 Rust 侧，然后跑 \`bun run build:canonical-types\`；
// \`bun run check:canonical-types\` 会在不同步时报红。

export const CANONICAL_EVENT_TYPES = [
${entries.map(entry => `  '${entry}',`).join('\n')}
] as const
`
}

function main() {
  const check = process.argv.includes('--check')
  const entries = readCanonicalEventTypes()
  const expected = render(entries)

  if (check) {
    if (!existsSync(TARGET)) {
      console.error(`[canonical-types] 缺少生成物：${TARGET}`)
      console.error('[canonical-types] 修复：bun run build:canonical-types')
      process.exit(1)
    }
    if (readFileSync(TARGET, 'utf8') !== expected) {
      console.error('[canonical-types] TS 词表与 Rust 单源不同步。')
      console.error('[canonical-types] 修复：bun run build:canonical-types')
      process.exit(1)
    }
    console.log(`[canonical-types] 与 Rust 单源一致（${entries.length} 项）`)
    return
  }

  writeFileSync(TARGET, expected)
  console.log(`[canonical-types] 已生成 ${entries.length} 项 → ${TARGET.slice(root.length + 1)}`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
