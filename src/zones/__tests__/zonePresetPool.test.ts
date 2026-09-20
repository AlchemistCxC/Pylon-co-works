// @vitest-environment jsdom
/**
 * 刀6（#206）区域预设池。
 *
 * 覆盖施工单 §四 的四类验收：派生（每格条数 / 切面 / 去重 / label 取舍 / sources）、
 * 未登记模式空池（整组不渲染）、出厂条目应用切片与现状一致、自定义条目存取与持久化、
 * Q8 已删字段键自动清理 + 行内占位。
 */
import { act, fireEvent, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GLOBAL_PRESETS, INTERFACE_MODE_PRESET_BUCKET, type GlobalPreset } from '../../presets/index.ts'
import { PRESET_ZONES } from '../../domains/theme/presetReducer.ts'
import { ZONE_FIELDS } from '../../themeFieldDefs.ts'
import type { ThemeSettings } from '../../store.ts'
import { useStore } from '../../store.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { mountSettingsSheet } from '../../test/settingsSheetHarness.tsx'
import { resetStores } from '../../test/resetStores.ts'
import { pickZoneFields } from '../pickZoneFields.ts'
import {
  ZONE_PRESET_POOL,
  createZonePresetEntryId,
  deriveZonePresetPool,
  normalizeZonePresetEntries,
  normalizeZonePresetValues,
  resolveZonePresetEntryTheme,
  zonePresetsFor,
  type ZonePresetEntry,
} from '../zonePresetPool.ts'

// 本文件是 .ts（无 JSX）：mock 组件直接返回 null，不用元素写法。
vi.mock('../../components/settings/AgentRuntimePanel.tsx', () => ({ default: () => null }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

const BUCKETS = ['gui', 'terminal'] as const

function bucketPresetNames(mode: (typeof BUCKETS)[number]): string[] {
  return GLOBAL_PRESETS.filter(preset => preset.interfaceMode === mode).map(preset => preset.name)
}

/** 施工单 §四要求「报告每格条数」：本条把 8 格（+global 一列）读数打进测试输出。 */
function census(): Record<string, Record<string, number>> {
  return Object.fromEntries(BUCKETS.map(mode => [
    mode,
    Object.fromEntries(PRESET_ZONES.map(zone => [zone, ZONE_PRESET_POOL[mode][zone].length])),
  ]))
}

function presetGroup(): HTMLElement {
  return screen.getByText('局部预设').closest('.set-group') as HTMLElement
}

describe('zonePresetPool · 派生（刀6 #206）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  })

  it('每格条数 ≤ 桶大小、桶非空每格 ≥1 条，且「条目 + sources」恰好覆盖该桶全部预设', () => {
    const cells = census()
    for (const mode of BUCKETS) {
      const names = bucketPresetNames(mode)
      for (const zone of PRESET_ZONES) {
        const entries = ZONE_PRESET_POOL[mode][zone]
        const at = `${mode}/${zone}`
        expect(entries.length, `${at} 去重后条数不得超过桶大小`).toBeLessThanOrEqual(names.length)
        expect(entries.length, `${at} 桶非空 ⇒ 每格至少 1 条`).toBeGreaterThanOrEqual(1)
        // 覆盖性：每个桶内预设恰好出现在「来源 id 或 sources」之一，去重不丢条目、也不重复计。
        expect(entries.flatMap(entry => [entry.id, ...(entry.sources ?? [])]).sort(), `${at} 覆盖该桶全部预设`).toEqual([...names].sort())
        // 图省事写坏的「假去重」会把两条同形切面留成两条：逐格确认没有重复切面。
        const fingerprints = entries.map(entry => JSON.stringify(resolveZonePresetEntryTheme(entry)))
        expect(new Set(fingerprints).size, `${at} 同一格内不得有同形重复条目`).toBe(entries.length)
      }
    }
    console.log('[刀6] 每格条数', JSON.stringify(cells))
  })

  it('去重：同形切面折叠为一条，label 取排序最前的来源，其余进 sources', () => {
    const presets: GlobalPreset[] = [
      // a1 / a2 侧栏切面同形（且字段书写顺序不同，验证稳定序列化与键序无关）
      { name: 'glass', label: 'A1', interfaceMode: 'gui', theme: { sidebarBg: '#111', sidebarNameSize: 14 } },
      { name: 'solarized', label: 'A2', interfaceMode: 'gui', theme: { sidebarNameSize: 14, sidebarBg: '#111' } },
      { name: 'nord', label: 'A3', interfaceMode: 'gui', theme: { sidebarBg: '#222' } },
    ]
    const pool = deriveZonePresetPool(presets)
    const entries = pool.gui.sidebar
    expect(entries).toHaveLength(2)
    expect(entries[0].id).toBe('glass')
    expect(entries[0].label).toBe('A1')
    expect(entries[0].source).toEqual({ presetName: 'glass' })
    expect(entries[0].sources).toEqual(['solarized'])
    expect(entries[1].id).toBe('nord')
    expect(entries[1].label).toBe('A3')
    expect(entries[1].sources).toBeUndefined()
  })

  it('tactical-blue / 未登记模式 ⇒ 空池，且整组不渲染', () => {
    expect(zonePresetsFor('tactical-blue', 'sidebar')).toEqual([])
    expect(zonePresetsFor('not-registered', 'sidebar')).toEqual([])
    expect(INTERFACE_MODE_PRESET_BUCKET['tactical-blue']).toBeUndefined()
    // 未登记到池的区域轴（layout 无字段）同样是空
    expect(zonePresetsFor('modern-gui', 'layout')).toEqual([])

    useInterfaceModeStore.setState({ interfaceMode: 'tactical-blue' })
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    expect(screen.queryByText('局部预设')).not.toBeInTheDocument()
  })

  it('出厂条目应用切片逐字段等于 pickZoneFields(来源预设.theme, zone)（应用行为零变化）', () => {
    for (const mode of BUCKETS) {
      for (const zone of PRESET_ZONES) {
        for (const entry of ZONE_PRESET_POOL[mode][zone]) {
          const preset = GLOBAL_PRESETS.find(item => item.name === entry.source?.presetName)
          expect(preset, `${mode}/${zone} 来源预设必须存在`).toBeTruthy()
          expect(resolveZonePresetEntryTheme(entry), `${mode}/${zone}/${entry.id}`).toEqual(pickZoneFields(preset!.theme, zone))
        }
      }
    }
  })

  it('池按 (模式桶, 区域) 隔离：终端格的自定义条目不出现在 GUI 格', () => {
    const entry: ZonePresetEntry = {
      id: 'zone-terminal-sidebar-1', mode: 'terminal', zone: 'sidebar', label: '终端侧栏',
      values: { sidebarBg: '#000000' },
    }
    expect(zonePresetsFor('modern-gui', 'sidebar', [entry]).some(item => item.id === entry.id)).toBe(false)
    expect(zonePresetsFor('terminal-like', 'sidebar', [entry]).some(item => item.id === entry.id)).toBe(true)
    // 区域轴同理：同一模式、别的区不出现
    expect(zonePresetsFor('terminal-like', 'chat', [entry]).some(item => item.id === entry.id)).toBe(false)
  })
})

describe('zonePresetPool · 自定义条目（刀6 #206）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  })

  it('存当前 → 入池（键含模式 + 区域）→ 应用恢复值；写盘可见且可按读入路径还原', () => {
    useStore.getState().setZoneField('sidebar', { sidebarBg: '#123456', sidebarNameSize: 17 })
    const id = useStore.getState().saveZonePresetEntry('gui', 'sidebar', '我的侧栏')
    expect(id, '存当前必须返回条目 id').toBeTruthy()
    // 「键含模式 + 区域」
    expect(id!.startsWith('zone-gui-sidebar-')).toBe(true)

    const saved = useStore.getState().zonePresetEntries
    expect(saved).toHaveLength(1)
    expect(saved[0].label).toBe('我的侧栏')
    expect(saved[0].source, '自定义条目存值快照，不存引用').toBeUndefined()
    // 快照 = 该 zone 的 ZONE_FIELDS 字段集
    expect(Object.keys(saved[0].values ?? {}).sort()).toEqual([...ZONE_FIELDS.sidebar].sort())
    expect(saved[0].values?.sidebarBg).toBe('#123456')

    // 池：自定义条目接在出厂条目之后
    const entries = zonePresetsFor('modern-gui', 'sidebar', saved)
    const custom = entries.find(entry => entry.id === id)
    expect(custom, '自定义条目必须出现在该格').toBeTruthy()
    expect(entries.indexOf(custom!)).toBeGreaterThan(entries.length - 2)
    expect(custom!.label).toBe('我的侧栏')

    // 应用：改走再恢复
    useStore.getState().setZoneField('sidebar', { sidebarBg: '#000000' })
    expect(useStore.getState().sidebarBg).toBe('#000000')
    const theme = resolveZonePresetEntryTheme(custom!)
    expect(theme?.sidebarBg).toBe('#123456')
    useStore.getState().applyZonePreset('sidebar', custom!.id, theme!)
    expect(useStore.getState().sidebarBg).toBe('#123456')
    expect(useStore.getState().sidebarNameSize).toBe(17)
    expect(useStore.getState().appliedPreset.sidebar).toBe(id)
    expect(useStore.getState().custom.sidebar).toBe(false)

    // 持久化：写进 pylon-theme（与 customPresets 同一家族），读入路径可原样还原
    const raw = localStorage.getItem('pylon-theme')
    expect(raw, '主题域必须已写盘').toBeTruthy()
    const persisted = JSON.parse(raw!) as { state: { zonePresetEntries?: unknown } }
    expect(persisted.state.zonePresetEntries).toEqual(saved)
    expect(normalizeZonePresetEntries(persisted.state.zonePresetEntries)).toEqual(saved)
  })

  it('存当前：名称为空不建条目；id 撞号加后缀', () => {
    expect(useStore.getState().saveZonePresetEntry('gui', 'sidebar', '   ')).toBeNull()
    expect(useStore.getState().zonePresetEntries).toHaveLength(0)

    const existing = ['zone-gui-sidebar-1']
    expect(createZonePresetEntryId('gui', 'sidebar', 1, existing)).toBe('zone-gui-sidebar-1-1')
    expect(createZonePresetEntryId('terminal', 'cc', 2, existing)).toBe('zone-terminal-cc-2')
  })
})

describe('zonePresetPool · Q8 无效条目清理（刀6 #206）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  })

  it('自定义快照里的已删字段键 ⇒ 自动清理 + 行内占位（灰显不可应用、不给开关）', () => {
    // 刀4 已删字段（ekgWidth / barFillColor）+ 一个越区键
    const brokenValues = { ekgWidth: 3, barFillColor: '#ff0000', chatBg: '#ffffff' } as unknown as Partial<ThemeSettings>
    const broken: ZonePresetEntry = {
      id: 'zone-gui-sidebar-1', mode: 'gui', zone: 'sidebar', label: '失效条目', values: brokenValues,
    }

    // 数据层：清理键
    const cleaned = normalizeZonePresetValues('sidebar', brokenValues)
    expect(cleaned.droppedKeys.sort()).toEqual(['barFillColor', 'chatBg', 'ekgWidth'])
    expect(cleaned.values).toEqual({})

    // 查询层：条目退化为行内占位，且不可应用
    const entry = zonePresetsFor('modern-gui', 'sidebar', [broken]).find(item => item.id === broken.id)
    expect(entry?.stale).toBe(true)
    expect(resolveZonePresetEntryTheme(entry!)).toBeNull()

    // store：自动清理落盘（清的是键，不是用户条目）
    useStore.setState({ zonePresetEntries: [broken] })
    useStore.getState().pruneZonePresetEntries()
    expect(useStore.getState().zonePresetEntries).toHaveLength(1)
    expect(useStore.getState().zonePresetEntries[0].values).toEqual({})

    // UI：行内占位（灰显 + 不可点），且没有「是否清理」的用户开关
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    const group = within(presetGroup())
    const chip = group.getByRole('button', { name: '失效条目' })
    expect(chip).toBeDisabled()
    expect(chip.getAttribute('title')).toContain('字段已被删除')
    expect(group.queryByRole('switch')).not.toBeInTheDocument()
    expect(group.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('清理后仍有有效字段的条目照常可应用（只丢无效键）', () => {
    const entry: ZonePresetEntry = {
      id: 'zone-gui-sidebar-2', mode: 'gui', zone: 'sidebar', label: '半失效条目',
      values: { sidebarBg: '#abcdef', ekgWidth: 3 } as unknown as Partial<ThemeSettings>,
    }
    const [custom] = zonePresetsFor('modern-gui', 'sidebar', [entry]).filter(item => item.id === entry.id)
    expect(custom.stale).toBeUndefined()
    expect(custom.values).toEqual({ sidebarBg: '#abcdef' })
    expect(resolveZonePresetEntryTheme(custom)).toEqual({ sidebarBg: '#abcdef' })
  })
})

describe('zonePresetPool · ZonePresetRow 消费（刀6 #206）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  })

  it('候选 = 该 (界面模式, 区域) 的池条目（同形折叠后有 sources 备注），自定义条目接在其后', () => {
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    const group = within(presetGroup())
    for (const entry of ZONE_PRESET_POOL.gui.sidebar) {
      expect(group.getByRole('button', { name: entry.label })).toBeInTheDocument()
    }
    // GUI 桶的侧栏格不含终端桶的预设标签
    expect(group.queryByRole('button', { name: 'Claude 风格' })).not.toBeInTheDocument()
    // 存当前入口（与全局预设的另存交互对齐）
    expect(group.getByPlaceholderText('区域预设名称')).toBeInTheDocument()
    expect(group.getByRole('button', { name: '存当前' })).toBeDisabled()
  })

  it('界面模式切到 terminal-like ⇒ 四个区的候选整批换桶', () => {
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    expect(within(presetGroup()).getByRole('button', { name: 'Glass Light' })).toBeInTheDocument()
    act(() => { useInterfaceModeStore.setState({ interfaceMode: 'terminal-like' }) })
    const group = within(presetGroup())
    for (const entry of ZONE_PRESET_POOL.terminal.sidebar) {
      expect(group.getByRole('button', { name: entry.label })).toBeInTheDocument()
    }
    expect(group.queryByRole('button', { name: 'Glass Light' })).not.toBeInTheDocument()
  })

  // 施工单 §八-3：选中的预设 chip 带 aria-current（本轮唯一的追加断言）
  it('选中的区域预设 chip 带 aria-current', () => {
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    fireEvent.click(within(presetGroup()).getByRole('button', { name: 'Glass Light' }))
    expect(within(presetGroup()).getByRole('button', { name: 'Glass Light' })).toHaveAttribute('aria-current', 'true')
  })
})
