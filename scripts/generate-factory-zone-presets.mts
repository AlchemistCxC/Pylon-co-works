#!/usr/bin/env bun
/**
 * 出厂区域预设数据 · 生成 / 校验（刀2 / #223）。
 *
 * ```bash
 * bun scripts/generate-factory-zone-presets.mts           # 默认：校验（现场派生 vs 仓库内数据文件，不一致就红）
 * bun scripts/generate-factory-zone-presets.mts --write    # 产出：把现场派生结果写进 src/zones/factory/
 * ```
 *
 * 形态照 `scripts/check-workbench-theme-contract.mts`：默认校验、`--write` 才写盘。
 *
 * 它守的是一条不变量：**落盘的出厂区域数据 == 生成时刻的 `pickZoneFields(GLOBAL_PRESETS[来源].theme, zone)`**。
 * 值**逐字段照抄**（含终端补全烘入的默认值、`cc` 区的 `ccLayout`/`ccHidden`/`ccScale` 三个元件名单字段），
 * **不做任何瘦身** —— 刨掉补全层会改变「只点某区域预设」的效果，那是刀3 的行为变更。
 *
 * ★★ **退出条件：刀3 落地后删除本脚本。** 刀3 让预设不再自带 `theme`（`GlobalPreset.theme` 在出厂数据里
 *    退场），本脚本的输入（现场派生）随之消失，留着就是死工具。届时本文件与 `deriveZonePresetPool` /
 *    `deriveFactoryZonePresetEntries` 两个参考实现一并清理。
 *
 * ★ 本脚本**只管 10 个数据文件**；`src/zones/factory/index.ts`（索引）是手写的，不在此产出。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PRESET_ZONES } from '../src/domains/theme/presetReducer.ts'
import { GLOBAL_PRESETS, type PresetInterfaceMode } from '../src/presets/index.ts'
import {
  FACTORY_ZONE_PRESET_ENTRIES,
  ZONE_PRESET_POOL,
  assembleFactoryZonePresetPool,
  deriveFactoryZonePresetEntries,
  type ZonePresetEntry,
} from '../src/zones/index.ts'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FACTORY_DIR = resolve(REPO_ROOT, 'src/zones/factory')
const WRITE = process.argv.includes('--write')

const MODES = ['gui', 'terminal'] as const satisfies readonly PresetInterfaceMode[]

/** 文件名 / 导出名：`gui-chat.ts` → `FACTORY_GUI_CHAT`。 */
function fileOf(mode: PresetInterfaceMode, zone: string): string {
  return `${mode}-${zone}.ts`
}
function exportOf(mode: PresetInterfaceMode, zone: string): string {
  return `FACTORY_${mode.toUpperCase()}_${zone.toUpperCase()}`
}

/** 单引号 TS 字符串（条目级字段用它；`values` 走 JSON，与 `src/presets/builtin.ts` 的写法一致）。 */
function tsString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** 嵌套对象/数组缩进重排（`JSON.stringify` 保证键序与缩进稳定 ⇒ 产出可复现）。 */
function prettyValue(value: unknown, indent: string): string {
  const text = JSON.stringify(value, null, 2)
  if (text === undefined) throw new Error(`值不可序列化：${String(value)}`)
  return text.split('\n').map((line, index) => (index === 0 ? line : indent + line)).join('\n')
}

function renderEntry(entry: ZonePresetEntry): string {
  const fields = Object.entries(entry.values as Record<string, unknown>)
    .map(([key, value]) => `      ${key}: ${prettyValue(value, '      ')},`)
    .join('\n')
  return [
    '  {',
    `    id: ${tsString(entry.id)},`,
    `    mode: ${tsString(entry.mode)},`,
    `    zone: ${tsString(entry.zone)},`,
    `    label: ${tsString(entry.label)},`,
    `    origin: 'factory',`,
    `    source: { presetName: ${tsString(entry.source?.presetName ?? entry.id)} },`,
    '    values: {',
    fields,
    '    },',
    '  },',
  ].join('\n')
}

function renderFile(mode: PresetInterfaceMode, zone: string, entries: ZonePresetEntry[]): string {
  const fieldCount = entries.reduce((sum, entry) => sum + Object.keys(entry.values).length, 0)
  return [
    '/**',
    ` * 区域层 · 出厂区域预设数据 —— ${mode} 桶 / ${zone} 区域（刀2 / #223）。`,
    ' *',
    ' * ★ **本文件由 `scripts/generate-factory-zone-presets.mts --write` 生成，不要手改。**',
    ' *   校验：`bun scripts/generate-factory-zone-presets.mts`（默认模式，逐字节比对）。',
    ` * 值 = 生成时刻的 \`pickZoneFields(GLOBAL_PRESETS[来源].theme, '${zone}')\`，逐字段照抄`,
    ' * （含终端补全烘入的默认值；cc 区含 ccLayout/ccHidden/ccScale 三个元件名单字段）。',
    ' */',
    "import type { ZonePresetEntry } from '../zonePresetPool.ts'",
    '',
    `export const ${exportOf(mode, zone)}: readonly ZonePresetEntry[] = [`,
    entries.map(renderEntry).join('\n'),
    ']',
    '',
    `// 本文件 ${entries.length} 条 / ${fieldCount} 个字段值`,
    '',
  ].join('\n')
}

function main(): void {
  const derived = deriveFactoryZonePresetEntries(GLOBAL_PRESETS)

  // ★ 构建期闸门之一：越区键**报错**（不是静默丢弃）。与生产池装配走同一个函数。
  assembleFactoryZonePresetPool(derived)

  // ★ 活数据源护栏：生产池必须逐条引用**数据表里的那些对象**。
  //   若池退回现场派生（数据文件成了死数据），这里立刻红——这是「数据文件真的在跑」的机器判据。
  const deadData: string[] = []
  for (const mode of MODES) {
    for (const zone of PRESET_ZONES) {
      for (const entry of ZONE_PRESET_POOL[mode][zone]) {
        if (!FACTORY_ZONE_PRESET_ENTRIES.includes(entry)) deadData.push(`${mode}/${zone}/${entry.id}`)
      }
    }
  }
  if (deadData.length > 0) {
    throw new Error(
      `生产池没有消费落盘数据表（${deadData.length} 条不在 FACTORY_ZONE_PRESET_ENTRIES 里，例：${deadData.slice(0, 3).join('、')}）`
      + ' —— 数据文件成了死数据',
    )
  }

  const plan = MODES.flatMap(mode => PRESET_ZONES.map(zone => ({
    mode,
    zone,
    file: fileOf(mode, zone),
    entries: derived.filter(entry => entry.mode === mode && entry.zone === zone),
  })))

  // 完整性：每格条数必须等于该桶的预设数（少了⇒某套预设的区域引用会解析不到）
  let total = 0
  for (const { mode, zone, entries } of plan) {
    const expected = GLOBAL_PRESETS.filter(preset => preset.interfaceMode === mode).length
    if (entries.length !== expected) {
      throw new Error(`${mode}/${zone} 条目数 ${entries.length} ≠ 该桶预设数 ${expected}`)
    }
    total += entries.length
  }

  const mismatches: string[] = []
  const report: string[] = []
  for (const { mode, zone, file, entries } of plan) {
    const path = resolve(FACTORY_DIR, file)
    const expected = renderFile(mode, zone, entries)
    const fieldCount = entries.reduce((sum, entry) => sum + Object.keys(entry.values).length, 0)
    report.push(`  ${file.padEnd(20)} ${String(entries.length).padStart(2)} 条 / ${String(fieldCount).padStart(3)} 字段值 / ${String(expected.split('\n').length - 1).padStart(4)} 行`)
    if (WRITE) {
      writeFileSync(path, expected)
      continue
    }
    let actual: string | undefined
    try {
      actual = readFileSync(path, 'utf8')
    } catch {
      mismatches.push(`${file}：文件不存在（先跑 --write 产出）`)
      continue
    }
    if (actual !== expected) {
      const actualLines = actual.split('\n')
      const expectedLines = expected.split('\n')
      const at = expectedLines.findIndex((line, index) => line !== actualLines[index])
      mismatches.push(
        `${file}：与现场派生不一致（第 ${at + 1} 行起）\n`
        + `      期望: ${expectedLines[at] ?? '<无>'}\n`
        + `      实际: ${actualLines[at] ?? '<无>'}`,
      )
    }
  }

  console.log(`出厂区域预设：${plan.length} 个数据文件 / ${total} 条`)
  console.log(report.join('\n'))

  if (WRITE) {
    console.log(`\n已写入 ${FACTORY_DIR}`)
    return
  }
  if (mismatches.length > 0) {
    console.error(`\n出厂区域预设数据校验失败（${mismatches.length} 个文件）：`)
    console.error(mismatches.join('\n'))
    process.exit(1)
  }
  console.log('\n出厂区域预设数据校验通过：落盘数据与现场派生逐字节一致')
}

main()
