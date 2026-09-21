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
import { GLOBAL_PRESETS, INTERFACE_MODE_PRESET_BUCKET } from '../../presets/index.ts'
import { PRESET_ZONES } from '../../domains/theme/presetReducer.ts'
import { ZONE_FIELDS } from '../../themeFieldDefs.ts'
import type { ThemeSettings } from '../../store.ts'
import { useStore } from '../../store.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { mountSettingsSheet } from '../../test/settingsSheetHarness.tsx'
import { resetStores } from '../../test/resetStores.ts'
import { pickZoneFields } from '../pickZoneFields.ts'
import { effectivePresetTheme } from '../effectivePresetTheme.ts'
import {
  ZONE_PRESET_POOL,
  assembleFactoryZonePresetPool,
  createZonePresetEntryId,
  isCustomZonePresetEntry,
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

  it('每格条数 == 桶大小（刀2 起不折叠）、桶非空每格 ≥1 条，且条目 id 恰好覆盖该桶全部预设', () => {
    const cells = census()
    for (const mode of BUCKETS) {
      const names = bucketPresetNames(mode)
      for (const zone of PRESET_ZONES) {
        const entries = ZONE_PRESET_POOL[mode][zone]
        const at = `${mode}/${zone}`
        expect(entries.length, `${at} 条数不得超过桶大小`).toBeLessThanOrEqual(names.length)
        expect(entries.length, `${at} 桶非空 ⇒ 每格至少 1 条`).toBeGreaterThanOrEqual(1)
        // 覆盖性（刀2 / #223 起不折叠）：每套预设各留自己那条，id 恰好等于该桶全部预设名。
        expect(entries.map(entry => entry.id).sort(), `${at} 覆盖该桶全部预设`).toEqual([...names].sort())
      }
    }
    console.log('[刀6] 每格条数', JSON.stringify(cells))
  })

  it('不折叠（刀2 / #223 裁决 A）：同形切面各留一条，各自 id 与 label 取自己的来源；sources 已退场', () => {
    // 刀3（#223）：刀2 的 `deriveZonePresetPool` 参考实现已删（预设不再自带 theme）⇒ 夹具改为**手写条目**
    const twinEntries: ZonePresetEntry[] = [
      // 前两条侧栏切面同形（且字段书写顺序不同）
      { id: 'glass', mode: 'gui', zone: 'sidebar', label: 'A1', origin: 'factory', source: { presetName: 'glass' }, values: { sidebarBg: '#111', sidebarNameSize: 14 } },
      { id: 'solarized', mode: 'gui', zone: 'sidebar', label: 'A2', origin: 'factory', source: { presetName: 'solarized' }, values: { sidebarNameSize: 14, sidebarBg: '#111' } },
      { id: 'nord', mode: 'gui', zone: 'sidebar', label: 'A3', origin: 'factory', source: { presetName: 'nord' }, values: { sidebarBg: '#222' } },
    ]
    const entries = assembleFactoryZonePresetPool(twinEntries).gui.sidebar
    // 折叠若复活：同形的两条会并成一条 ⇒ 长度 2、且 solarized 这条消失（它的引用就装不上了）
    expect(entries).toHaveLength(3)
    expect(entries.map(entry => entry.id)).toEqual(['glass', 'solarized', 'nord'])
    expect(entries.map(entry => entry.label)).toEqual(['A1', 'A2', 'A3'])
    expect(entries[0].source).toEqual({ presetName: 'glass' })
    expect(entries[1].source).toEqual({ presetName: 'solarized' })
    for (const entry of entries) expect(entry).not.toHaveProperty('sources')
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

  it('出厂条目应用切片逐字段等于来源预设有效值在该区的切面（应用行为零变化）', () => {
    for (const mode of BUCKETS) {
      for (const zone of PRESET_ZONES) {
        for (const entry of ZONE_PRESET_POOL[mode][zone]) {
          const preset = GLOBAL_PRESETS.find(item => item.name === entry.source?.presetName)
          expect(preset, `${mode}/${zone} 来源预设必须存在`).toBeTruthy()
          expect(resolveZonePresetEntryTheme(entry), `${mode}/${zone}/${entry.id}`).toEqual(pickZoneFields(effectivePresetTheme(preset!), zone))
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

describe('zonePresetPool · ZonePresetRow 消费（刀6 #206）', () => {  beforeEach(() => {
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

describe('zonePresetPool · 自定义条目删除（刀7 前置 #211）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    useInterfaceModeStore.setState({ interfaceMode: 'modern-gui' })
  })

  /** 播一条自定义条目并让它成为 sidebar 的当前基准（= 被选中态）。 */
  function seedSelectedCustomEntry(label = '我的侧栏'): string {
    useStore.getState().setZoneField('sidebar', { sidebarBg: '#123456' })
    const id = useStore.getState().saveZonePresetEntry('gui', 'sidebar', label)!
    const entry = useStore.getState().zonePresetEntries.find(item => item.id === id)!
    useStore.getState().applyZonePreset('sidebar', id, resolveZonePresetEntryTheme(entry)!)
    return id
  }

  it('删除闭环 + 持久化：条目从池与写盘内容里同时消失', () => {
    const id = seedSelectedCustomEntry()
    expect(zonePresetsFor('modern-gui', 'sidebar', useStore.getState().zonePresetEntries).some(e => e.id === id)).toBe(true)
    expect(localStorage.getItem('pylon-theme')).toContain(id)

    useStore.getState().removeZonePresetEntry(id)

    expect(useStore.getState().zonePresetEntries).toHaveLength(0)
    expect(zonePresetsFor('modern-gui', 'sidebar', useStore.getState().zonePresetEntries).some(e => e.id === id)).toBe(false)
    // 写回可见：重载后不复活
    expect(localStorage.getItem('pylon-theme')).not.toContain(id)
    expect(normalizeZonePresetEntries(
      (JSON.parse(localStorage.getItem('pylon-theme')!) as { state: { zonePresetEntries?: unknown } }).state.zonePresetEntries,
    )).toEqual([])
  })

  it('删除被引用的条目：该区失去基准但保留现值（与全局删除链同语义）', () => {
    const id = seedSelectedCustomEntry()
    expect(useStore.getState().appliedPreset.sidebar).toBe(id)
    expect(useStore.getState().sidebarBg).toBe('#123456')

    useStore.getState().removeZonePresetEntry(id)

    expect(useStore.getState().appliedPreset.sidebar).toBe('')
    expect(useStore.getState().custom.sidebar).toBe(true)
    expect(useStore.getState().sidebarBg).toBe('#123456')
  })

  it('出厂条目不可删：把出厂预设名当 id 传进去是 no-op（不动条目、不写状态）', () => {
    const id = seedSelectedCustomEntry()
    const entriesBefore = useStore.getState().zonePresetEntries
    const appliedBefore = useStore.getState().appliedPreset

    useStore.getState().removeZonePresetEntry('glass')

    expect(useStore.getState().zonePresetEntries).toBe(entriesBefore)
    expect(useStore.getState().appliedPreset).toBe(appliedBefore)
    expect(useStore.getState().zonePresetEntries.map(entry => entry.id)).toEqual([id])
    expect(isCustomZonePresetEntry(ZONE_PRESET_POOL.gui.sidebar[0])).toBe(false)
  })

  it('两段式确认：点删除 → 行内 alertdialog → 确认删除后条目消失', () => {
    seedSelectedCustomEntry()
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    const group = within(presetGroup())

    fireEvent.click(group.getByRole('button', { name: '删除' }))
    const dialog = group.getByRole('alertdialog')
    expect(dialog).toHaveAccessibleName('确认删除区域预设 我的侧栏')
    expect(dialog).toHaveTextContent('将移除本区的自定义条目「我的侧栏」，本区保留现值但失去该预设基准')

    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
    expect(useStore.getState().zonePresetEntries).toHaveLength(0)
    expect(within(presetGroup()).queryByRole('button', { name: '我的侧栏' })).not.toBeInTheDocument()
    expect(within(presetGroup()).queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('取消路径：点取消不删、无残留确认框、删除入口回到常规态', () => {
    seedSelectedCustomEntry()
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    const group = within(presetGroup())

    fireEvent.click(group.getByRole('button', { name: '删除' }))
    expect(group.getByRole('alertdialog')).toBeInTheDocument()
    fireEvent.click(within(group.getByRole('alertdialog')).getByRole('button', { name: '取消' }))

    expect(useStore.getState().zonePresetEntries).toHaveLength(1)
    expect(within(presetGroup()).queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(within(presetGroup()).getByRole('button', { name: '我的侧栏' })).toBeInTheDocument()
    expect(within(presetGroup()).queryAllByRole('button', { name: '删除' })).toHaveLength(1)
  })

  it('出现条件三态：出厂条目 0 个、自定义未选中 0 个、自定义被选中恰好 1 个', () => {
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    const deletes = () => within(presetGroup()).queryAllByRole('button', { name: '删除' })

    // ① 出厂条目被选中 ⇒ 0 个（铁律 1：出厂件不可改、不可删）
    fireEvent.click(within(presetGroup()).getByRole('button', { name: 'Glass Light' }))
    expect(deletes()).toHaveLength(0)

    // ② 自定义条目已存在但未被选中 ⇒ 0 个
    let id = ''
    act(() => { id = useStore.getState().saveZonePresetEntry('gui', 'sidebar', '未选中的条目')! })
    expect(within(presetGroup()).getByRole('button', { name: '未选中的条目' })).toBeInTheDocument()
    expect(deletes()).toHaveLength(0)

    // ③ 选中该自定义条目 ⇒ 恰好 1 个
    act(() => {
      const entry = useStore.getState().zonePresetEntries.find(item => item.id === id)!
      useStore.getState().applyZonePreset('sidebar', id, resolveZonePresetEntryTheme(entry)!)
    })
    expect(deletes()).toHaveLength(1)
  })

  it('Q8 灰显占位条目可被删除（那是它唯一的自然出口）', () => {
    const broken: ZonePresetEntry = {
      id: 'zone-gui-sidebar-9', mode: 'gui', zone: 'sidebar', label: '失效条目',
      values: { ekgWidth: 3 } as unknown as Partial<ThemeSettings>,
    }
    useStore.setState({ zonePresetEntries: [broken] })
    useStore.getState().pruneZonePresetEntries()
    mountSettingsSheet({ domain: 'appearance', section: 'sidebar' })
    const group = within(presetGroup())

    // 占位条目本身灰显不可点，但删除入口常驻
    expect(group.getByRole('button', { name: '失效条目' })).toBeDisabled()
    fireEvent.click(group.getByRole('button', { name: '删除' }))
    fireEvent.click(within(group.getByRole('alertdialog')).getByRole('button', { name: '确认删除' }))
    expect(useStore.getState().zonePresetEntries).toHaveLength(0)
    expect(within(presetGroup()).queryByRole('button', { name: '失效条目' })).not.toBeInTheDocument()
  })
})
