/**
 * convert-presets-to-delta — 全局预设 delta 化转换脚本（W2-15，F3-B）。
 *
 * 每个预设的 theme 从全量快照 → 相对 THEME_DEFAULTS 的 delta（过滤 defs 未知键/与
 * 默认相等的键/已 deprecated 布局字段 sidebarWidth/showPet）。应用语义改为
 * `{...THEME_DEFAULTS, ...delta}`（一键换装 = 干净全量换装）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/convert-presets-to-delta.mts --check
 *   node --experimental-strip-types scripts/convert-presets-to-delta.mts --write
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { GLOBAL_PRESETS } from '../src/presets.ts'
import { THEME_DEFAULTS, THEME_FIELD_KEYS } from '../src/themeFieldDefs.ts'

const DEFAULTS = THEME_DEFAULTS as Record<string, string | number | boolean>
/** 已迁出主题层的布局字段（sidebarWidth→workspaceStore；showPet→workspaceStore）——delta 等价测试明确排除 */
const DEPRECATED_LAYOUT_FIELDS = new Set(['sidebarWidth', 'showPet'])

const knownKeys = new Set(THEME_FIELD_KEYS)

function toDelta(theme: Record<string, unknown>): Record<string, unknown> {
  const delta: Record<string, unknown> = {}
  for (const key of Object.keys(theme).sort()) {
    if (!knownKeys.has(key as never)) continue
    if (DEPRECATED_LAYOUT_FIELDS.has(key)) continue
    if (theme[key] === DEFAULTS[key]) continue
    delta[key] = theme[key]
  }
  return delta
}

function expand(delta: Record<string, unknown>): Record<string, unknown> {
  return { ...DEFAULTS, ...delta }
}

const check = process.argv.includes('--check')
const write = process.argv.includes('--write')

let failures = 0
for (const preset of GLOBAL_PRESETS) {
  const delta = toDelta(preset.theme as Record<string, unknown>)
  const expanded = expand(delta)
  // 等价校验：展开后的有效字段 == 原快照（排除 deprecated 布局字段）
  const original = Object.fromEntries(
    Object.entries(preset.theme as Record<string, unknown>)
      .filter(([key]) => knownKeys.has(key as never) && !DEPRECATED_LAYOUT_FIELDS.has(key)),
  )
  const mismatches = Object.keys(original).filter(key => original[key] !== expanded[key])
  if (mismatches.length > 0) {
    failures += 1
    console.error(`[convert] ${preset.name}: 等价校验失败 ${mismatches.join(', ')}`)
  }
  if (!write) {
    console.log(`[convert] ${preset.name}: ${Object.keys(preset.theme as Record<string, unknown>).length} 字段 → ${Object.keys(delta).length} delta`)
  }
}

if (failures > 0) {
  console.error(`[convert] FAIL: ${failures} 个预设等价校验失败`)
  process.exitCode = 1
} else if (check) {
  console.log('[convert] check 通过：6 预设 delta 展开与转换前快照等价（排除 deprecated 布局字段）')
} else if (write) {
  // 重写 presets.ts 的 GLOBAL_PRESETS theme 为 delta
  const path = new URL('../src/presets.ts', import.meta.url)
  let source = readFileSync(path, 'utf8')
  const arrayStart = source.indexOf('export const GLOBAL_PRESETS')
  // 数组真末位 = 末尾的独立 `]`（内部 ccHidden 等含 `]`，不能用首个）
  const arrayEnd = source.lastIndexOf(']', source.indexOf('export function pickZoneFields'))
  const newArray = `export const GLOBAL_PRESETS: GlobalPreset[] = [
${GLOBAL_PRESETS.map(preset => {
  const delta = toDelta(preset.theme as Record<string, unknown>)
  const body = Object.keys(delta).sort().map(key => `      ${key}: ${JSON.stringify(delta[key])},`).join('\n')
  return `  {
    name: '${preset.name}',
    label: '${preset.label}',
    // W2-15（F3-B）：delta（相对 THEME_DEFAULTS）——应用时 { ...THEME_DEFAULTS, ...delta } 干净全量换装
    theme: {
${body}
    },
  }`
}).join(',\n')}
]`
  source = source.slice(0, arrayStart) + newArray + source.slice(arrayEnd + 1)
  writeFileSync(path, source)
  console.log('[convert] presets.ts 已重写为 delta 格式')
}
